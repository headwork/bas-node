const BaseStage = require('./BaseStage');
const IisControlStage = require('./IisControlStage');
const FsRenameStage = require('./FsRenameStage');
const { listBackups, stampNow } = require('../backupRetention');
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
    const siteName = config.site || vars.iis_site || config.iis_site || path.basename(deployPath);
    const manageIis = config.manage_iis !== false;

    const target = this.#pickBackup(config, deployPath);
    if (!target) return;   // 되돌릴 변경이 없다 (사유는 #pickBackup 이 출력한다)

    const keepBackup = target.mode === 'copy';
    console.log(`[LocalRollback] Restoring ${siteName} from ${path.basename(target.path)}` +
      ` (${keepBackup ? '백업 보존' : '백업 소비'})`);

    const iisStage = new IisControlStage(this.engine);
    const renameStage = new FsRenameStage(this.engine);

    // 1. 강제 롤백이면 **서비스가 살아 있는 동안** 복사부터 끝낸다.
    //    정지 구간에 690MB 복사를 넣으면 그만큼 서비스가 죽어 있게 된다.
    let source = target.path;
    if (keepBackup) {
      source = `${deployPath}_rollback_temp`;
      if (fs.existsSync(source)) fs.rmSync(source, { recursive: true, force: true });
      console.log(`[LocalRollback] Step 0: 백업을 복사합니다 -> ${path.basename(source)}`);
      const startedAt = Date.now();
      fs.cpSync(target.path, source, { recursive: true });
      console.log(`[LocalRollback]   복사 소요 ${((Date.now() - startedAt) / 1000).toFixed(1)}초`);
    }

    try {
      // 2. IIS 정지
      if (manageIis) {
        console.log(`[LocalRollback] Step 1: Stopping IIS Service`);
        await iisStage.execute({ action: 'stop', site: siteName }, basePath);
      }

      // 3. 지금 라이브를 치워 둔다.
      //    파이프라인 실패로 도는 경우는 그 배포본이 원인이므로 `_failed_` 로 격리한다.
      //    사람이 부른 강제 롤백은 실패한 것이 아니므로 `_backup_` 으로 남긴다 —
      //    그래야 "되돌렸다가 다시 최신으로" 가 가능하다.
      if (fs.existsSync(deployPath)) {
        const asideName = keepBackup
          ? `${path.basename(deployPath)}_backup_${stampNow()}`
          : `${path.basename(deployPath)}_failed_${stampNow()}`;
        const asideDir = keepBackup ? (target.root || path.dirname(deployPath)) : path.dirname(deployPath);
        const asidePath = path.join(asideDir, asideName);
        console.log(`[LocalRollback] Step 2: 현재 라이브를 치웁니다 -> ${asideName}`);
        await renameStage.execute({ src: deployPath, dest: asidePath }, basePath);
      } else {
        console.log(`[LocalRollback] Step 2: 라이브 경로가 없습니다 (스왑 도중 실패). 치울 것이 없습니다.`);
      }

      // 4. 준비한 것을 라이브로
      console.log(`[LocalRollback] Step 3: Restoring backup to live path`);
      await renameStage.execute({ src: source, dest: deployPath }, basePath);
    } finally {
      // 5. 배포는 실패해도 서비스는 세우고 나간다.
      if (manageIis) {
        console.log(`[LocalRollback] Step 4: Starting IIS Service`);
        try { await iisStage.execute({ action: 'start', site: siteName }, basePath); } catch { /* 무시 */ }
      }
    }

    if (target.runKey && !keepBackup && this.engine.deployState) {
      // 소비된 백업은 다음 롤백 후보에서 빠져야 한다.
      try { this.engine.deployState.markBackupConsumed(target.runKey); } catch { /* 무시 */ }
    }

    console.log(`[LocalRollback] Rollback completed. Live path restored from ${path.basename(target.path)}.`);
  }

  /**
   * 되돌릴 백업을 고른다.
   *
   * @returns {{path, root, mode, runKey}|null}  null 이면 되돌릴 것이 없다
   */
  #pickBackup(config, deployPath) {
    const vars = this.engine.context.variables;
    const state = this.engine.deployState;
    const requested = Number(config.last_deploy || vars.last_deploy || 0);
    const forced = requested > 0;                       // 사람이 --rollback=N 으로 부름

    // ── 강제 롤백: 이력에서 N번째 성공 배포를 고른다
    if (forced) {
      if (!state) throw new Error(`강제 롤백에는 배포 이력이 필요합니다 (설정 폴더를 찾지 못했습니다).`);

      const candidates = state.rollbackCandidates(this.engine.context.environment);
      if (candidates.length === 0) {
        throw new Error(
          `되돌릴 수 있는 배포 이력이 없습니다 (환경=${this.engine.context.environment}).\n` +
          `  백업이 남아 있는 성공 배포가 있어야 합니다.`
        );
      }

      // 이력이 요청보다 적으면 가장 오래된 것으로 내린다. 사용자가 기대한 것보다
      // **덜 되돌아가는** 것이므로 조용히 넘기지 않는다.
      const index = Math.min(requested, candidates.length) - 1;
      if (index + 1 !== requested) {
        console.log(`[LocalRollback] 요청 lastDeploy=${requested} -> 사용 가능한 백업이 ` +
          `${candidates.length}건이라 ${index + 1}번으로 조정합니다`);
      }

      const run = candidates[index];
      const backupPath = run.variables.backup_path;

      if (!fs.existsSync(backupPath)) {
        // 이력에는 있는데 폴더가 없다 = 사람이 지웠다. 다음 것으로 넘어가면
        // 의도한 것보다 더 되돌아간다. 여기서 멈추는 것이 옳다.
        throw new Error(
          `백업 폴더가 없습니다: ${backupPath}\n` +
          `  이력(${run.key}, ${run.finished_at || run.started_at})에는 남아 있습니다. 누가 지웠는지 확인하십시오.`
        );
      }

      console.log(`[LocalRollback] 대상: ${path.basename(backupPath)}`);
      console.log(`[LocalRollback]   배포키 ${run.key} / 커밋 ${(run.variables.git_to || '').slice(0, 8) || '-'}` +
        ` / ${run.finished_at || run.started_at}`);

      return { path: backupPath, root: path.dirname(backupPath), mode: 'copy', runKey: run.key };
    }

    // ── 배포중 롤백: 이번 실행이 **만든** 백업을 그대로 쓴다
    //
    // 무장(armed) 됐을 때만 믿는다. 무장은 라이브를 백업으로 옮긴 직후에만 켜지므로,
    // 그 전이면 `backup_path` 는 이번 배포가 만든 것이 아니다 — 설정에 같은 이름이
    // 섞여 들어왔을 뿐일 수 있고, 그 값은 대개 **백업 루트 폴더**라 실재한다.
    // 존재 검사만으로는 그것을 못 거른다. 잘못 믿으면 백업 폴더 전체가 라이브가 된다.
    const armed = this.engine.context.rollbackArmed || vars.rollback_armed === true;
    const own = armed ? vars.backup_path : null;
    if (own && fs.existsSync(own)) {
      return { path: own, root: path.dirname(own), mode: 'consume', runKey: null };
    }

    // ── 전환기 폴백: 이력에 경로가 없던 시절의 백업은 폴더를 훑어 찾는다
    const backupRoot = vars.backup_root || config.backup_root || null;
    const found = listBackups(deployPath, backupRoot);
    if (found.length > 0) {
      console.log(`[LocalRollback] 이력에 백업 경로가 없어 폴더에서 찾았습니다: ${found[0].name}`);
      return { path: found[0].path, root: path.dirname(found[0].path), mode: 'consume', runKey: null };
    }

    // 백업이 없다는 것에는 두 가지 경우가 있다. 뭉뚱그리면 오해를 부른다.
    //   (a) 스왑 전에 실패했다 -> 라이브가 그대로 있다. 되돌릴 변경 자체가 없다.
    //   (b) 스왑 도중 실패했다 -> 라이브가 사라졌는데 복구할 백업이 없다. 진짜 위험.
    if (fs.existsSync(deployPath)) {
      console.log(`[LocalRollback] 되돌릴 변경이 없습니다 - 배포 전에 중단되어 라이브가 그대로입니다.`);
      console.log(`[LocalRollback] 대상: ${deployPath}`);
      return null;
    }
    console.error(`[LocalRollback] CRITICAL: 라이브 경로가 없는데 백업도 없습니다: ${deployPath}`);
    console.error(`[LocalRollback] 수동 복구가 필요합니다.`);
    throw new Error(`Rollback aborted: no backup available for ${deployPath}`);
  }
}

module.exports = LocalRollbackMacroStage;
