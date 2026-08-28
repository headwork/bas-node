class BaseStage {
  constructor(engine) {
    this.engine = engine;
  }
  async execute(stageConfig, basePath) {
    throw new Error("execute() must be implemented");
  }
}
module.exports = BaseStage;