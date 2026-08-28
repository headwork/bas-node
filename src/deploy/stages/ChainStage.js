const BaseStage = require('./BaseStage');
const path = require('path');
class ChainStage extends BaseStage {
  async execute(stageConfig, basePath) {
    if (!stageConfig.chain) throw new Error("Chain property missing");
    console.log('[ChainStage] Executing chained YAML: ' + stageConfig.chain);
    const chainPath = path.resolve(basePath, stageConfig.chain);
    
    // Lazy require
    const PipelineEngine = require('../PipelineEngine'); 
    const chainEngine = new PipelineEngine();
    
    let passParams = {};
    if (stageConfig.pass_env) {
      passParams = { ...this.engine.context.variables };
    }
    if (stageConfig.with) {
      passParams = { ...passParams, ...stageConfig.with };
    }
    await chainEngine.run(chainPath, passParams);
  }
}
module.exports = ChainStage;