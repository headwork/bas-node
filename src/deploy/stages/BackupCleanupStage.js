const BaseStage = require('./BaseStage');
const { applyRetention } = require('../backupRetention');

/**
 * 백업 보관 정책 적용 스테이지 (#P001-OQ2).
 * local_deploy 가 끝에서 자동 호출하지만, YAML 에서 `backup_cleanup` 으로 단독 호출할 수도 있다.
 *
 *   - backup_cleanup: {}                       # 루트 backup: 설정을 그대로 사용
 *   - backup_cleanup: { keep_recent_days: 14 } # 이 호출에서만 덮어쓰기
 */
class BackupCleanupStage extends BaseStage {
  async execute(stageConfig, basePath) {
    const config = stageConfig && typeof stageConfig === 'object' ? stageConfig : {};
    const vars = this.engine.context.variables;
    const deployPath = config.web_deploy_path || vars.web_deploy_path;

    if (!deployPath) {
      throw new Error("BackupCleanupStage requires 'web_deploy_path' (stage config or context variable).");
    }

    // 루트 backup: 블록이 기본, 스테이지 인자가 덮어쓴다.
    const merged = { ...(this.engine.context.backup || {}), ...config };
    delete merged.web_deploy_path;

    applyRetention(deployPath, merged);
  }
}

module.exports = BackupCleanupStage;
