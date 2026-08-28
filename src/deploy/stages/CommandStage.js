const BaseStage = require('./BaseStage');
class CommandStage extends BaseStage {
  async execute(stageConfig, basePath) {
    if (typeof stageConfig === 'string') {
      this.engine.runCommand(stageConfig);
    } else {
      throw new Error('Invalid config for command stage: ' + JSON.stringify(stageConfig));
    }
  }
}
module.exports = CommandStage;