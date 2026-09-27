const BaseStage = require('./BaseStage');
const path = require('path');
const { makeSshRunner } = require('../sshRunner');
const { syncRemoteScripts, defaultScriptDir, defaultRemoteScriptDir } = require('../scriptSync');
const { ROLLBACK, reasonFor } = require('../scriptExit');
const { assertRemotePath } = require('../remoteEnv');
const { joinPreserve } = require('../scriptArgs');
const { classifyPreserve, allNames } = require('../preserveClassify');

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
    // ⚠️ 롤백에서는 **현재 라이브**에서 가져온다. 코드만 옛것으로 돌리고 데이터는 현재 것이다.
    const kinds = this.engine.context.preserveKinds
      || classifyPreserve(this.engine.context.preserve, this.engine.context.preserveConfig);
    const carryArg = joinPreserve(allNames(kinds));

    const targetPath = win(target.path);
    const stamp = this.#stamp();
    const tempPath = `${livePath}_rollback_${stamp}`;
    // 치워 둘 자리 — 배포중 원복(트랙 A)이 치운 실패본은 `_failed_`,
    // 사람이 부른 롤백(트랙 B)이 밀어낸 라이브는 `_replaced_`. 둘 다 다음 배포 성공 때 지워진다.
    const asidePath = `${livePath}_${target.track === 'B' ? 'replaced' : 'failed'}_${stamp}`;

    const ssh = this.#sshRunner({ target: user ? `${user}@${host}` : host, port, keyPath, basePath });

    console.log(`\n[RemoteRollback] Restoring ${siteName} from ${path.basename(targetPath)}` +
      ` (트랙 ${target.track} — ${target.track === 'B' ? '사람이 부른 롤백' : '배포중 원복'})`);

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
    console.log(`  zip    ${targetPath}`);
    console.log(`  aside  ${asidePath}`);
    if (carryArg) console.log(`  carry  ${carryArg.split(';').join(', ')}`);

    const r = ssh(`${scriptDir}\\rollback.bat`, {
      capture: true,
      allowFailure: true,
      env: {
        RB_LIVE: livePath,
        // 확정 zip 이다. **전개해도 원본이 줄지 않으므로** 소비/보존(`RB_MODE`)이라는
        // 축 자체가 사라졌다 — 같은 지점으로 몇 번이든 다시 되돌릴 수 있다.
        RB_ZIP: target.folder ? undefined : targetPath,
        RB_SOURCE: target.folder ? targetPath : undefined,
        RB_STAGE: target.folder ? undefined : tempPath,
        RB_ASIDE: asidePath,
        RB_STRIP: String(this.#strip(config)),
        RB_CARRY: carryArg || undefined,
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
        console.error(`     move ${asidePath} ${livePath}`);
      }
      throw new Error(`원격 롤백 실패: ${why} (종료코드 ${r.code})`);
    }

    console.log(`[RemoteRollback] Rollback completed.`);
  }

  /**
   * 되돌릴 확정 빌드를 고른다. **두 트랙이 갈리는 자리다** (`[D04]`).
   *
   *   트랙 B  `--rollback=N` — 사람이 판단한다. 이력의 N번째 확정 빌드
   *   트랙 A  배포중·헬스체크 실패 — 파이프라인이 자동. **직전** 확정 빌드
   *
   * 가르는 기준은 "확정됐는가" 다. 트랙 A 가 도는 시점의 이번 배포는 아직 미확정이므로,
   * 이력의 맨 앞 확정본이 곧 "직전 성공 배포" 다.
   */
  #pickBackup(config) {
    const vars = this.engine.context.variables;
    const state = this.engine.deployState;
    const requested = Number(config.last_deploy || vars.last_deploy || 0);
    const env = this.engine.context.environment;

    if (!state) {
      if (requested > 0) throw new Error(`롤백에는 배포 이력이 필요합니다.`);
      console.log(`[RemoteRollback] 배포 이력이 없어 되돌릴 대상을 찾을 수 없습니다.`);
      return null;
    }

    const candidates = state.releaseCandidates(env);

    if (requested > 0) {
      if (candidates.length === 0) {
        throw new Error(
          `되돌릴 수 있는 확정 빌드가 없습니다 (환경=${env}).\n` +
          `  확정은 헬스체크를 통과한 배포에만 생깁니다. 아직 한 번도 없다면 이력이 비어 있는 것이 맞습니다.`
        );
      }

      const index = Math.min(requested, candidates.length) - 1;
      if (index + 1 !== requested) {
        console.log(`[RemoteRollback] 요청 lastDeploy=${requested} -> 확정 빌드가 ` +
          `${candidates.length}건이라 ${index + 1}번으로 조정합니다`);
      }

      const run = candidates[index];
      console.log(`[RemoteRollback] 대상: ${run.variables.release_zip}`);
      console.log(`[RemoteRollback]   배포키 ${run.key} / 커밋 ${(run.variables.git_to || '').slice(0, 8) || '-'}` +
        ` / ${run.finished_at || run.started_at}`);

      return { path: run.variables.release_zip, track: 'B', runKey: run.key };
    }

    // 트랙 A — 이번 배포가 라이브를 건드린 뒤에 실패했을 때만 돈다.
    // 무장 여부로 가린다. 무장 전에 되돌리면 멀쩡한 라이브를 옛 빌드로 덮는다.
    const armed = this.engine.context.rollbackArmed || vars.rollback_armed === true;
    if (!armed) {
      console.log(`[RemoteRollback] 되돌릴 것이 없습니다 - 라이브를 건드리기 전에 실패했습니다.`);
      return null;
    }

    // 스왑이면 옛 라이브가 아직 옆에 있다. **역스왑이 가장 빠른 복구다** —
    // 전개가 없어 몇 초면 끝나고, 그 판이 곧 직전 상태다. 확정 전까지만 산다.
    if (vars.deploy_mode_used === 'swap' && vars.org_path) {
      console.log(`[RemoteRollback] 옛 라이브가 남아 있습니다 - 역스왑으로 되돌립니다: ${vars.org_path}`);
      return { path: String(vars.org_path).replace(/\//g, '\\'), track: 'A', runKey: null, folder: true };
    }

    if (candidates.length === 0) {
      console.error(`[RemoteRollback] ⚠️ 확정 빌드가 없어 되돌릴 수 없습니다.`);
      if (vars.org_path) {
        console.error(`[RemoteRollback]   옛 라이브가 남아 있습니다. 원격에서 직접 실행하십시오:`);
        console.error(`     move ${vars.org_path} ${String(vars.web_deploy_path).replace(/\//g, '\\')}`);
      }
      return null;
    }

    console.log(`[RemoteRollback] 직전 확정 빌드로 되돌립니다: ${candidates[0].variables.release_zip}`);
    return { path: candidates[0].variables.release_zip, track: 'A', runKey: candidates[0].key };
  }

  /** 아카이브의 최상위 한 겹을 벗기는 값. 배포와 같은 기본값(1)을 쓴다. */
  #strip(config) {
    const raw = config.strip !== undefined ? config.strip : this.engine.context.variables.strip;
    return raw === undefined ? 1 : Number(raw);
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
