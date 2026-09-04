const BaseStage = require('./BaseStage');
const path = require('path');

/**
 * 원격 서버의 라이브를 백업 폴더로 되돌린다. local_rollback 의 SSH 판이다.
 *
 * 방식이 둘인 것도 같다.
 *   배포중 롤백 (consume)  방금 만든 백업을 **move** 한다. 그 백업은 소비된다.
 *   강제 롤백   (copy)     백업을 **복사**해서 되돌린다. 원본은 남는다.
 *
 * ⚠️ 복사에 robocopy 를 쓴다면 종료코드를 반드시 걸러야 한다 —
 *    **robocopy 는 정상 복사에도 1 을 낸다.** 그대로 두면 성공한 복사가 실패로 잡힌다.
 *    8 이상만 실패다.
 */
class RemoteRollbackMacroStage extends BaseStage {
  async execute(stageConfig, basePath) {
    const config = stageConfig && typeof stageConfig === 'object' ? stageConfig : {};
    const vars = this.engine.context.variables;
    const cfg = (key) => config[key] !== undefined ? config[key] : vars[key];

    const win = (p) => String(p).replace(/\//g, '\\');

    const host = cfg('host');
    const user = cfg('user');
    const port = cfg('port') || null;
    const keyPath = cfg('key_path');
    const deployPath = cfg('web_deploy_path');

    if (!host || !deployPath) {
      throw new Error(`RemoteRollbackMacroStage 에 필요한 값이 없습니다: ${!host ? 'host' : 'web_deploy_path'}`);
    }

    const livePath = win(deployPath);
    const siteName = cfg('iis_site') || path.basename(livePath.replace(/[\\/]+$/, ''));
    const manageIis = config.manage_iis !== false;

    const target = this.#pickBackup(config);
    if (!target) return;

    const keepBackup = target.mode === 'copy';
    const targetPath = win(target.path);
    const stamp = this.#stamp();
    const tempPath = `${livePath}_rollback_${stamp}`;
    const asidePath = keepBackup
      ? `${win(target.root || path.dirname(targetPath))}\\${path.basename(livePath)}_backup_${stamp}`
      : `${livePath}_failed_${stamp}`;

    const ssh = this.#sshRunner({ target: user ? `${user}@${host}` : host, port, keyPath, basePath });

    console.log(`\n[RemoteRollback] Restoring ${siteName} from ${path.basename(targetPath)}` +
      ` (${keepBackup ? '백업 보존' : '백업 소비'})`);

    // 백업이 실제로 있는지 먼저 본다. 없는데 IIS 를 내리면 서비스만 죽는다.
    const exists = ssh(`if exist ${targetPath} (echo FOUND) else (echo MISSING)`, { capture: true, allowFailure: true });
    if (!/FOUND/.test(exists.output || '')) {
      throw new Error(
        `원격에 백업 폴더가 없습니다: ${targetPath}\n` +
        `  이력에는 남아 있습니다. 누가 지웠는지 확인하십시오.`
      );
    }

    // 1. 강제 롤백이면 서비스가 살아 있는 동안 복사부터 끝낸다.
    let source = targetPath;
    if (keepBackup) {
      source = tempPath;
      console.log(`[RemoteRollback] Step 0: 백업을 복사합니다 -> ${path.basename(source)}`);
      // robocopy 는 성공해도 0 이 아니다. 8 미만은 정상으로 본다.
      ssh(`robocopy ${targetPath} ${source} /E /NFL /NDL /NJH /NJS /R:1 /W:1 & if errorlevel 8 (exit 1) else (exit 0)`);
    }

    try {
      if (manageIis) {
        console.log(`[RemoteRollback] Step 1: Stopping IIS`);
        this.#iis(ssh, 'stop', siteName);
      }

      console.log(`[RemoteRollback] Step 2: 현재 라이브를 치웁니다 -> ${path.basename(asidePath)}`);
      ssh(`if exist ${livePath} move ${livePath} ${asidePath}`);

      console.log(`[RemoteRollback] Step 3: ${path.basename(source)} -> ${path.basename(livePath)}`);
      ssh(`move ${source} ${livePath}`);
    } finally {
      if (manageIis) {
        console.log(`[RemoteRollback] Step 4: Starting IIS`);
        try { this.#iis(ssh, 'start', siteName); } catch { /* 서비스는 세우고 나간다 */ }
      }
    }

    if (target.runKey && !keepBackup && this.engine.deployState) {
      try { this.engine.deployState.markBackupConsumed(target.runKey); } catch { /* 무시 */ }
    }

    console.log(`[RemoteRollback] Rollback completed.`);
  }

  /** local_rollback 과 같은 규칙으로 되돌릴 백업을 고른다. */
  #pickBackup(config) {
    const vars = this.engine.context.variables;
    const state = this.engine.deployState;
    const requested = Number(config.last_deploy || vars.last_deploy || 0);

    if (requested > 0) {
      if (!state) throw new Error(`강제 롤백에는 배포 이력이 필요합니다.`);

      const candidates = state.rollbackCandidates(this.engine.context.environment);
      if (candidates.length === 0) {
        throw new Error(`되돌릴 수 있는 배포 이력이 없습니다 (환경=${this.engine.context.environment}).`);
      }

      const index = Math.min(requested, candidates.length) - 1;
      if (index + 1 !== requested) {
        console.log(`[RemoteRollback] 요청 lastDeploy=${requested} -> 사용 가능한 백업이 ` +
          `${candidates.length}건이라 ${index + 1}번으로 조정합니다`);
      }

      const run = candidates[index];
      console.log(`[RemoteRollback] 대상: ${run.variables.backup_path}`);
      console.log(`[RemoteRollback]   배포키 ${run.key} / 커밋 ${(run.variables.git_to || '').slice(0, 8) || '-'}` +
        ` / ${run.finished_at || run.started_at}`);

      return {
        path: run.variables.backup_path,
        root: path.dirname(String(run.variables.backup_path).replace(/\//g, '\\')),
        mode: 'copy',
        runKey: run.key
      };
    }

    // 배포중 롤백: 이번 실행이 **만든** 백업.
    // 무장됐을 때만 믿는다 — 그 전의 `backup_path` 는 설정에서 온 백업 루트일 수 있고,
    // 그것을 백업으로 착각하면 보관 폴더 전체가 라이브 자리로 옮겨간다.
    const armed = this.engine.context.rollbackArmed || vars.rollback_armed === true;
    const own = armed ? vars.backup_path : null;
    if (own) return { path: own, root: path.dirname(String(own).replace(/\//g, '\\')), mode: 'consume', runKey: null };

    console.log(`[RemoteRollback] 되돌릴 백업이 없습니다 - 라이브를 건드리기 전에 실패했습니다.`);
    return null;
  }

  #sshRunner({ target, port, keyPath, basePath }) {
    const sshPort = port ? `-p ${port}` : '';
    const keyArg = keyPath ? `-i "${keyPath}"` : '';
    return (remoteCmd, opts = {}) => {
      const cmd = `ssh ${sshPort} -o StrictHostKeyChecking=no ${keyArg} ${target} "${remoteCmd}"`;
      console.log(`  [ssh] ${remoteCmd}`);
      return this.engine.runCommand(cmd, basePath, opts);
    };
  }

  /** appcmd 는 "이미 그 상태" 일 때도 0 이 아닌 코드를 낸다. 출력을 보고 가른다. */
  #iis(ssh, action, site) {
    const appcmd = '%windir%\\system32\\inetsrv\\appcmd.exe';
    for (const [kind, name] of [['site', 'site.name'], ['apppool', 'apppool.name']]) {
      const r = ssh(`${appcmd} ${action} ${kind} /${name}:${site}`, { capture: true, allowFailure: true });
      if (r.code === 0) { console.log(`  [iis] OK - ${action} ${kind} ${site}`); continue; }
      const out = (r.output || '').trim();
      if (/already (started|stopped)|ALREADY_(STARTED|STOPPED)/i.test(out)) {
        console.log(`  [iis] 이미 원하는 상태 - ${kind} ${site}`);
        continue;
      }
      throw new Error(`원격 IIS ${action} 실패: ${kind} ${site}`);
    }
  }

  #stamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }
}

module.exports = RemoteRollbackMacroStage;
