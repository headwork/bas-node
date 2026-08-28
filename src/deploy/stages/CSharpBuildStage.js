const BaseStage = require('./BaseStage');
const fs = require('fs');

class CSharpBuildStage extends BaseStage {
  async execute(stageConfig, basePath) {
    const buildPath = this.engine.context.variables.build_path || stageConfig.build_path;
    const buildCmd = stageConfig.cmd || 'dotnet build -c Release'; // 기본값으로 dotnet 사용

    if (!buildPath) {
      throw new Error("CSharpBuildStage requires 'build_path'.");
    }

    if (!fs.existsSync(buildPath)) {
      throw new Error(`Build path does not exist: ${buildPath}`);
    }

    console.log(`\n[CSharpBuildStage] Starting build process...`);
    console.log(`- Build Path: ${buildPath}`);
    console.log(`- Command: ${buildCmd}`);
    
    // 빌드는 시간이 오래 걸릴 수 있으므로 상세 로그를 스트림으로 확인하게 됩니다.
    // PipelineEngine.runCommand는 { stdio: 'inherit' }를 쓰기 때문에 자동으로 콘솔에 출력됨.
    this.engine.runCommand(buildCmd, buildPath);

    console.log(`[CSharpBuildStage] Build completed successfully.`);
  }
}

module.exports = CSharpBuildStage;
