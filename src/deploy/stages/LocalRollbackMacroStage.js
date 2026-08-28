const BaseStage = require('./BaseStage');
const IisControlStage = require('./IisControlStage');
const FsRenameStage = require('./FsRenameStage');
const { listBackups } = require('../backupRetention');
const path = require('path');
const fs = require('fs');

/**
 * local_deploy 로 배포한 IIS 사이트를 직전 백업으로 되돌린다 (#P001-REQ5).
 *
 * 실패한 배포본은 지우지 않고 `<deploy_path>_failed_<timestamp>` 로 밀어 둔다.
 * 원인 분석 대상이므로 보관 정책(`_backup_` 만 대상)에도 걸리지 않는다 — 확인 후 직접 정리해야 한다.
 */
class LocalRollbackMacroStage extends BaseStage {
  async execute(stageConfig, basePath) {
    const config = stageConfig && typeof stageConfig === 'object' ? stageConfig : {};
    const vars = this.engine.context.variables;
    const deployPath = config.deploy_path || vars.deploy_path;

    if (!deployPath) {
      throw new Error("LocalRollbackMacroStage requires 'deploy_path' (stage config or context variable).");
    }

    const siteName = config.site || path.basename(deployPath);
    // local_deploy 와 같은 규약. IIS 를 제어하지 않는 대상은 롤백도 제어하지 않는다.
    const manageIis = config.manage_iis !== false;
    const backups = listBackups(deployPath);

    if (backups.length === 0) {
      // 백업이 없다는 것에는 두 가지 경우가 있다. 뭉뚱그리면 오해를 부른다.
      //   (a) 스왑 전에 실패했다 -> 라이브가 그대로 있다. 되돌릴 변경 자체가 없다.
      //   (b) 스왑 도중 실패했다 -> 라이브가 사라졌는데 복구할 백업이 없다. 진짜 위험.
      if (fs.existsSync(deployPath)) {
        console.log(`[LocalRollback] 되돌릴 변경이 없습니다 - 배포 전에 중단되어 라이브가 그대로입니다.`);
        console.log(`[LocalRollback] 대상: ${deployPath}`);
        return;
      }
      console.error(`[LocalRollback] CRITICAL: 라이브 경로가 없는데 백업도 없습니다: ${deployPath}`);
      console.error(`[LocalRollback] 수동 복구가 필요합니다.`);
      throw new Error(`Rollback aborted: no backup available for ${deployPath}`);
    }

    const newest = backups[0];
    console.log(`[LocalRollback] Restoring ${siteName} from ${newest.name}`);

    const iisStage = new IisControlStage(this.engine);
    const renameStage = new FsRenameStage(this.engine);

    // 1. IIS 정지
    if (manageIis) {
      console.log(`[LocalRollback] Step 1: Stopping IIS Service`);
      await iisStage.execute({ action: 'stop', site: siteName }, basePath);
    } else {
      console.log(`[LocalRollback] Step 1: IIS 제어 건너뜀 (manage_iis: false)`);
    }

    // 2. 실패한 배포본을 치워 둔다 (삭제하지 않는다)
    if (fs.existsSync(deployPath)) {
      const failedPath = `${deployPath}_failed_${Date.now()}`;
      console.log(`[LocalRollback] Step 2: Moving failed deployment aside -> ${path.basename(failedPath)}`);
      await renameStage.execute({ src: deployPath, dest: failedPath }, basePath);
    } else {
      console.log(`[LocalRollback] Step 2: Live path is missing (deployment failed mid-swap). Nothing to move aside.`);
    }

    // 3. 최신 백업을 라이브로 복구
    console.log(`[LocalRollback] Step 3: Restoring backup to live path`);
    await renameStage.execute({ src: newest.path, dest: deployPath }, basePath);

    // 4. IIS 재기동
    if (manageIis) {
      console.log(`[LocalRollback] Step 4: Starting IIS Service`);
      await iisStage.execute({ action: 'start', site: siteName }, basePath);
    } else {
      console.log(`[LocalRollback] Step 4: IIS 제어 건너뜀 (manage_iis: false)`);
    }

    console.log(`[LocalRollback] Rollback completed. Live path restored from ${newest.name}.`);
  }
}

module.exports = LocalRollbackMacroStage;
