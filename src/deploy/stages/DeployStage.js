const BaseStage = require('./BaseStage');
class DeployStage extends BaseStage {
  async execute(stageConfig, basePath) {
    if (stageConfig.restart_cmd) {
      console.log('[DeployStage] Executing deploy/restart script...');
      this.engine.runCommand(stageConfig.restart_cmd, stageConfig.script_dir || process.cwd());
    } else {
       console.log('[DeployStage] No restart_cmd provided, treating as simple config. Config:', stageConfig);
    }
  }
}
module.exports = DeployStage;