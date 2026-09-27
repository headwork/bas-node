const BaseStage = require('./BaseStage');
const { stampNow, uniquePath } = require('../backupRetention');
const { ROLLBACK, reasonFor } = require('../scriptExit');
const { assertScript, defaultScriptDir } = require('../scriptSync');
const { joinPreserve } = require('../scriptArgs');
const { classifyPreserve, allNames } = require('../preserveClassify');
const path = require('path');
const fs = require('fs');

/**
 * 백업 폴더로 라이브를 되돌린다 (#P001-REQ5).
 *
 * 방식이 둘이다.
 *
 *   배포중 롤백 (mode: 'consume')  파이프라인이 실패해서 자동으로 도는 경우.
 *                                 방금 만든 백업을 **move** 한다. 그 백업은 소비된다.
 *
 *   강제 롤백   (mode: 'copy')     사람이 `--rollback=N` 으로 부르는 경우.
 *                                 백업을 **복사**해서 되돌린다. 원본 백업은 남으므로
 *                                 같은 지점으로 몇 번이든 다시 되돌릴 수 있다.
 *
 * 되돌릴 대상은 **배포 이력**에서 고른다. 폴더를 훑어 최신을 집으면 그것이 성공한
 * 배포였는지, 이 파이프라인이 만든 것인지 알 수 없다. 이력에는 성공 여부·시각·커밋이
 * 함께 있다. 이력에 경로가 없을 때만 예전처럼 폴더를 훑는다(전환기 대비).
 */
class LocalRollbackMacroStage extends BaseStage {
  async execute(stageConfig, basePath) {
    const config = stageConfig && typeof stageConfig === 'object' ? stageConfig : {};
    const vars = this.engine.context.variables;

    // 라이브 폴더는 `web_deploy_path`. 배포와 롤백이 같은 경로를 봐야 한다 —
    // 어긋나면 되돌릴 대상이 아닌 폴더를 백업으로 덮는다.
    const deployPath = config.web_deploy_path || vars.web_deploy_path;
    if (!deployPath) {
      throw new Error("LocalRollbackMacroStage requires 'web_deploy_path' (stage config or context variable).");
    }

    // local_deploy 와 반드시 같은 사이트를 잡아야 한다. 여기서만 다른 이름이 나오면
    // 배포는 멈춘 사이트를 롤백이 못 세운다. 우선순위를 local_deploy 와 맞춰 둔다.
    const siteName = config.site || vars.web_server_name || config.web_server_name
      || vars.iis_site || config.iis_site || path.basename(deployPath);
    // 기존 YAML 이 수정 없이 돌아야 한다 (#P002-REQ5).
    const wsType = vars.web_server_type || config.web_server_type || 'iis';
    const scriptDir = vars.script_dir || config.script_dir || defaultScriptDir(vars);
    const manageIis = config.manage_iis !== false && (vars.web_server_type || config.web_server_type) !== 'none';

    const target = this.#pickBackup(config, deployPath);
    if (!target) return;   // 되돌릴 변경이 없다 (사유는 #pickBackup 이 출력한다)

    // 운영 중 생긴 데이터(업로드·캐시)는 배포와 **같은 목록·같은 규칙**으로 넘긴다.
    // 롤백은 코드를 옛것으로 되돌리는 것이지 데이터를 되돌리는 것이 아니다 —
    // 빠뜨리면 롤백은 성공하고 그 사이의 업로드만 사라진다. 에러는 나지 않는다.
    // 이름 검증(공백·와일드카드)은 **라이브를 건드리기 전에** 한다.
    // ⚠️ **현재 라이브**에서 가져온다. 코드만 옛것으로 돌리고 데이터는 현재 것이다.
    const kinds = this.engine.context.preserveKinds
      || classifyPreserve(this.engine.context.preserve, this.engine.context.preserveConfig);
    const carryArg = joinPreserve(allNames(kinds));

    console.log(`[LocalRollback] Restoring ${siteName} from ${path.basename(target.path)}` +
      ` (트랙 ${target.track} — ${target.track === 'B' ? '사람이 부른 롤백' : '배포중 원복'})`);

    // 현재 라이브를 치워 둘 자리. 둘 다 **라이브 옆**이다 — 같은 볼륨이라 move 가 이름 바꾸기로 끝난다.
    //   파이프라인 실패로 도는 경우는 그 배포본이 원인이므로 `_failed_` 로 격리한다.
    //     다음 배포가 성공하면 지운다 (removeLeftovers).
    //   사람이 부른 강제 롤백은 `_replaced_` 로 치우고 **서비스가 다시 뜨면 스크립트가 지운다.**
    //     강제 롤백을 했다는 것은 그 라이브가 문제였다는 뜻이다. 앞으로 갈 사본은 배포 zip 이고,
    //     운영 데이터는 이미 preserve 로 넘어왔다. 백업 이름으로 남기면 보관 개수만 잡아먹는다.
    //
    //   ⚠️ 타임스탬프가 초 단위라 **같은 초에 배포하고 되돌리면 이름이 겹친다.**
    //      스크립트는 겹치면 거부하므로(옳다) Node 가 비켜 간 이름을 준다.
    const stamp = stampNow();
    const asidePath = uniquePath(path.join(path.dirname(deployPath),
      `${path.basename(deployPath)}_${target.track === 'B' ? 'replaced' : 'failed'}_${stamp}`));

    // 복사 → 정지 → 치우기 → 복귀 → 시작. **스크립트 한 번이다** (#P002-TASK7).
    // 원격과 같은 스크립트, 같은 종료코드 표를 쓴다 — 다른 것은 호출 경로뿐이다.
    const script = path.join(scriptDir, 'rollback.bat');
    assertScript(script, scriptDir);
    const scratch = `${deployPath}_rollback_temp`;

    // 남아 있는 스크래치를 먼저 치운다. **스크립트는 이미 있으면 거부한다**(exit 1) —
    // 덮어쓰면 반쪽짜리 사본이 라이브가 될 수 있으니 옳은 태도다. 다만 그 판단,
    // "이건 우리가 만든 찌꺼기고 지워도 된다" 는 Node 가 한다.
    // 안 치우면 롤백이 영영 막힌다 — 하필 비상용 경로에서.
    if (fs.existsSync(scratch)) {
      console.log(`[LocalRollback] 이전 롤백이 남긴 임시 사본을 지웁니다: ${path.basename(scratch)}`);
      fs.rmSync(scratch, { recursive: true, force: true });
    }

    console.log(`  live   ${deployPath}`);
    console.log(`  zip    ${target.path}`);
    console.log(`  aside  ${asidePath}`);
    if (carryArg) console.log(`  carry  ${carryArg.split(';').join(', ')}`);

    const r = this.engine.runCommand(`"${script}"`, basePath, {
      capture: true,
      allowFailure: true,
      env: {
        RB_LIVE: deployPath,
        // 원본은 둘 중 하나다 — 확정 zip(전개해도 원본이 줄지 않는다) 또는
        // 스왑이 남긴 옛 라이브 폴더(전개가 없어 몇 초면 끝난다).
        RB_ZIP: target.folder ? '' : target.path,
        RB_SOURCE: target.folder ? target.path : '',
        RB_STAGE: target.folder ? '' : scratch,
        RB_ASIDE: asidePath,
        RB_STRIP: String(config.strip !== undefined ? config.strip : (vars.strip !== undefined ? vars.strip : 1)),
        RB_CARRY: carryArg,
        WS_SKIP: manageIis ? '' : '1',
        WS_TYPE: manageIis ? wsType : '',
        WS_NAME: manageIis ? siteName : '',
        WS_POOL: (manageIis && (vars.web_server_pool || config.web_server_pool))
          ? (vars.web_server_pool || config.web_server_pool) : ''
      }
    });

    const out = (r.output || '').trim();
    if (out) out.split(/\r?\n/).forEach(line => console.log(`  ${line}`));

    if (r.code !== 0) {
      const why = reasonFor(ROLLBACK, r.code);
      console.error(`\n[LocalRollback] 롤백 실패 - ${siteName}`);
      console.error(`  사유     : ${why}`);
      console.error(`  종료코드 : ${r.code}`);
      if (r.code === 5) {
        console.error(`  ⚠️ 라이브 폴더가 없습니다. 직접 실행하십시오:`);
        console.error(`     move "${asidePath}" "${deployPath}"`);
      }
      throw new Error(`로컬 롤백 실패: ${why} (종료코드 ${r.code})`);
    }

    console.log(`[LocalRollback] Rollback completed. Live path restored from ${path.basename(target.path)}.`);
  }

  /**
   * 되돌릴 백업을 고른다.
   *
   * @returns {{path, mode, runKey}|null}  null 이면 되돌릴 것이 없다
   */
  #pickBackup(config, deployPath) {
    const vars = this.engine.context.variables;
    const state = this.engine.deployState;
    const requested = Number(config.last_deploy || vars.last_deploy || 0);
    const env = this.engine.context.environment;

    if (!state) {
      if (requested > 0) throw new Error(`롤백에는 배포 이력이 필요합니다 (설정 폴더를 찾지 못했습니다).`);
      console.log(`[LocalRollback] 배포 이력이 없어 되돌릴 대상을 찾을 수 없습니다.`);
      return null;
    }

    const candidates = state.releaseCandidates(env);
    const exists = (p) => p && fs.existsSync(p);

    // ── 트랙 B: 사람이 `--rollback=N` 으로 부른다. 이력의 N번째 확정 빌드.
    if (requested > 0) {
      if (candidates.length === 0) {
        throw new Error(
          `되돌릴 수 있는 확정 빌드가 없습니다 (환경=${env}).\n` +
          `  확정은 헬스체크를 통과한 배포에만 생깁니다.`
        );
      }

      // 이력이 요청보다 적으면 가장 오래된 것으로 내린다. 사용자가 기대한 것보다
      // **덜 되돌아가는** 것이므로 조용히 넘기지 않는다.
      const index = Math.min(requested, candidates.length) - 1;
      if (index + 1 !== requested) {
        console.log(`[LocalRollback] 요청 lastDeploy=${requested} -> 확정 빌드가 ` +
          `${candidates.length}건이라 ${index + 1}번으로 조정합니다`);
      }

      const run = candidates[index];
      const zip = run.variables.release_zip;
      if (!exists(zip)) {
        // 이력에는 있는데 파일이 없다 = 사람이 지웠다. 다음 것으로 넘어가면
        // 의도한 것보다 더 되돌아간다. 여기서 멈추는 것이 옳다.
        throw new Error(
          `확정 빌드가 없습니다: ${zip}\n` +
          `  이력(${run.key}, ${run.finished_at || run.started_at})에는 남아 있습니다. 누가 지웠는지 확인하십시오.`
        );
      }

      console.log(`[LocalRollback] 대상: ${path.basename(zip)}`);
      console.log(`[LocalRollback]   배포키 ${run.key} / 커밋 ${(run.variables.git_to || '').slice(0, 8) || '-'}` +
        ` / ${run.finished_at || run.started_at}`);

      return { path: zip, track: 'B', runKey: run.key };
    }

    // ── 트랙 A: 배포중·헬스체크 실패. 라이브를 건드린 뒤(무장)에만 돈다.
    //
    // 무장 전이면 라이브가 그대로이므로 되돌릴 변경 자체가 없다. 잘못 믿고 돌면
    // 멀쩡한 라이브를 옛 빌드로 덮는다.
    const armed = this.engine.context.rollbackArmed || vars.rollback_armed === true;
    if (!armed) {
      console.log(`[LocalRollback] 되돌릴 변경이 없습니다 - 배포 전에 중단되어 라이브가 그대로입니다.`);
      return null;
    }

    // 스왑이면 옛 라이브가 아직 옆에 있다. **역스왑이 가장 빠른 복구다** —
    // zip 전개(수십 초)보다 몇 초가 낫고, 그 판이 곧 직전 상태다.
    if (vars.deploy_mode_used === 'swap' && exists(vars.org_path)) {
      console.log(`[LocalRollback] 옛 라이브가 남아 있습니다 - 역스왑으로 되돌립니다: ${path.basename(vars.org_path)}`);
      return { path: vars.org_path, track: 'A', runKey: null, folder: true };
    }

    const latest = candidates.find(r => exists(r.variables.release_zip));
    if (latest) {
      console.log(`[LocalRollback] 직전 확정 빌드로 되돌립니다: ${path.basename(latest.variables.release_zip)}`);
      return { path: latest.variables.release_zip, track: 'A', runKey: latest.key };
    }

    // 확정 빌드도 옛 라이브도 없다. 라이브가 있으면 손실은 없고, 없으면 진짜 사고다.
    if (fs.existsSync(deployPath)) {
      console.error(`[LocalRollback] ⚠️ 확정 빌드가 없어 되돌릴 수 없습니다 - 라이브는 그대로입니다.`);
      return null;
    }
    console.error(`[LocalRollback] CRITICAL: 라이브 경로가 없는데 되돌릴 빌드도 없습니다: ${deployPath}`);
    console.error(`[LocalRollback] 수동 복구가 필요합니다.`);
    throw new Error(`Rollback aborted: no confirmed build available for ${deployPath}`);
  }
}

module.exports = LocalRollbackMacroStage;
