const BaseStage = require('./BaseStage');
const path = require('path');
const { makeSshRunner } = require('../sshRunner');
const { syncRemoteScripts, defaultScriptDir, defaultRemoteScriptDir } = require('../scriptSync');
const { ROLLBACK, reasonFor } = require('../scriptExit');
const { assertRemotePath } = require('../remoteEnv');
const { joinPreserve } = require('../scriptArgs');

/**
 * 원격 서버의 라이브를 백업 폴더로 되돌린다. local_rollback 의 SSH 판이다.
 *
 * 방식이 둘인 것도 같다.
 *   배포중 롤백 (consume)  방금 만든 백업을 **move** 한다. 그 백업은 소비된다.
 *   강제 롤백   (copy)     백업을 **복사**해서 되돌린다. 원본은 남는다.
 *
 * ## 경계 — 어느 백업으로 되돌릴지는 Node, 되돌리는 일은 스크립트 (`[D10]`)
 *
 * **판단이 여기 남는다** — 배포 이력에서 N번째 성공 배포를 고르고, 요청이 이력보다
 * 크면 조정하고, 이번 실행이 만든 백업인지(무장 여부) 가린다. 그 판단의 결과인
 * 경로 셋(live·source·aside)만 `rollback.bat` 에 넘긴다.
 *
 * 폴더를 옮기는 일은 **ssh 한 번**이다 (#P002-TASK7). 두 move 사이에는 라이브가
 * 존재하지 않는데, 그 구간에 왕복이 끼면 끊긴 연결이 곧 "라이브 없음" 이 된다 —
 * 그것도 이미 한 번 실패해서 되돌리는 길에서.
 *
 * ⚠️ robocopy(`copy` 모드의 복제)도 스크립트 안이다. **robocopy 는 정상 복사에도 1 을 내므로**
 *    `if errorlevel 8` 로 갈라야 한다. 그대로 실패로 보면 성공한 롤백이 전부 실패가 된다.
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
    const siteName = cfg('web_server_name') || cfg('iis_site')
      || path.basename(livePath.replace(/[\\/]+$/, ''));
    // 기존 YAML 이 수정 없이 돌아야 한다 — 지금까지 이 도구가 다룬 것은 IIS 뿐이다 (#P002-REQ5).
    const wsType = cfg('web_server_type') || 'iis';
    const manageIis = config.manage_iis !== false && cfg('web_server_type') !== 'none';
    const scriptDir = cfg('remote_script_dir')
      || defaultRemoteScriptDir(cfg('upload_path'), this.engine.context.environment);
    // 도구 서버의 원본 자리 (#P002-TASK5). 배포 매크로와 같은 값을 본다.
    const localScriptDir = cfg('script_dir') || defaultScriptDir(vars);

    const target = this.#pickBackup(config);
    if (!target) return;

    // 운영 중 생긴 데이터는 배포와 **같은 목록·같은 규칙**으로 넘긴다 (local_rollback 과 같다).
    // 이름 검증은 스크립트 전송보다 먼저다 — 원격에 아무것도 하기 전에 멈춘다.
    const preserve = config.preserve || this.engine.context.preserve || [];
    const preserveArg = joinPreserve(preserve);

    const keepBackup = target.mode === 'copy';
    const targetPath = win(target.path);
    const stamp = this.#stamp();
    const tempPath = `${livePath}_rollback_${stamp}`;
    // 치워 둘 자리는 local_rollback 과 같다 — 실패본은 `_failed_`(다음 배포 성공 시 삭제),
    // 강제 롤백이 밀어낸 라이브는 `_replaced_`(서비스가 다시 뜨면 스크립트가 삭제).
    const asidePath = `${livePath}_${keepBackup ? 'replaced' : 'failed'}_${stamp}`;

    const ssh = this.#sshRunner({ target: user ? `${user}@${host}` : host, port, keyPath, basePath });

    console.log(`\n[RemoteRollback] Restoring ${siteName} from ${path.basename(targetPath)}` +
      ` (${keepBackup ? '백업 보존' : '백업 소비'})`);

    // 공용 스크립트를 맞춘다 (#P002-TASK5).
    //
    // ⚠️ `manage_iis:false` 여도 건너뛰지 않는다. TASK7 이후 **폴더를 옮기는 것도**
    //    스크립트가 하므로, 웹서버를 안 만진다고 스크립트가 필요 없어지지 않는다.
    //    라이브를 건드리기 전에 확인한다 — 이 실패를 롤백 도중에 만나면
    //    서비스만 멈춘 채로 끝난다.
    if (cfg('sync_scripts') !== false) {
      syncRemoteScripts(this.engine, {
        ssh,
        localDir: localScriptDir,
        remoteDir: scriptDir,
        target: user ? `${user}@${host}` : host,
        port, keyPath, basePath
      });
    }

    // 복사 → 정지 → 치우기 → 복귀 → 시작. **ssh 한 번이다** (#P002-TASK7).
    //
    // 예전에는 여기가 ssh 6회였고(존재확인·robocopy·정지·move·move·시작),
    // 두 move 사이에는 라이브 폴더가 **존재하지 않았다.** 그 구간에 왕복이 끼면
    // 끊긴 연결이 곧 "라이브 없음" 이 된다 — 그것도 이미 한 번 실패해서 도는 길에서.
    //
    // 백업 존재 확인도 스크립트에 넘겼다. 없으면 `4` 로 멈춘다 —
    // 같은 규칙을 Node 와 스크립트가 따로 들고 있으면 한쪽만 고쳐지는 날이 온다.
    assertRemotePath(`${scriptDir}\\rollback.bat`);

    console.log(`  live   ${livePath}`);
    console.log(`  source ${targetPath}`);
    console.log(`  aside  ${asidePath}`);
    if (preserve.length > 0) console.log(`  preserve ${preserve.join(', ')}`);

    const r = ssh(`${scriptDir}\\rollback.bat`, {
      capture: true,
      allowFailure: true,
      env: {
        RB_LIVE: livePath,
        RB_SOURCE: targetPath,
        RB_ASIDE: asidePath,
        // 되돌린 뒤 백업을 남길지 소비할지. 사람이 부른 강제 롤백은 원본을 남겨야
        // 같은 지점으로 몇 번이든 다시 되돌릴 수 있다.
        RB_MODE: keepBackup ? 'copy' : 'consume',
        RB_TEMP: keepBackup ? tempPath : undefined,
        RB_PRESERVE: preserveArg || undefined,
        WS_SKIP: manageIis ? undefined : '1',
        WS_TYPE: manageIis ? wsType : undefined,
        WS_NAME: manageIis ? siteName : undefined,
        WS_POOL: manageIis ? cfg('web_server_pool') : undefined
      }
    });

    const out = (r.output || '').trim();
    if (out) out.split(/\r?\n/).forEach(line => console.log(`  ${line}`));

    if (r.code !== 0) {
      const why = reasonFor(ROLLBACK, r.code);
      console.error(`\n[RemoteRollback] 롤백 실패 - ${siteName}`);
      console.error(`  사유     : ${why}`);
      console.error(`  종료코드 : ${r.code}`);
      if (r.code === 5) {
        console.error(`  ⚠️ 라이브 폴더가 없습니다. 원격에서 직접 실행하십시오:`);
        console.error(`     move ${keepBackup ? tempPath : targetPath} ${livePath}`);
      }
      throw new Error(`원격 롤백 실패: ${why} (종료코드 ${r.code})`);
    }

    // 소비된 백업은 다음 롤백 후보에서 빠져야 한다. **성공했을 때만** 표시한다 —
    // 실패했는데 소비로 적으면 되돌릴 수 있는 지점이 이력에서 사라진다.
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
        mode: 'copy',
        runKey: run.key
      };
    }

    // 배포중 롤백: 이번 실행이 **만든** 백업.
    // 무장됐을 때만 믿는다 — 그 전의 `backup_path` 는 설정에서 온 백업 루트일 수 있고,
    // 그것을 백업으로 착각하면 보관 폴더 전체가 라이브 자리로 옮겨간다.
    const armed = this.engine.context.rollbackArmed || vars.rollback_armed === true;
    const own = armed ? vars.backup_path : null;
    if (own) return { path: own, mode: 'consume', runKey: null };

    console.log(`[RemoteRollback] 되돌릴 백업이 없습니다 - 라이브를 건드리기 전에 실패했습니다.`);
    return null;
  }

  /** 원격 명령 실행기. 구현은 sshRunner.js 한 곳에 있다 (배포 매크로와 공유). */
  #sshRunner(opts) {
    return makeSshRunner(this.engine, opts);
  }

  #stamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }
}

module.exports = RemoteRollbackMacroStage;
