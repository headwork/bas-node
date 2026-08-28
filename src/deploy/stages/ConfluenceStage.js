const BaseStage = require('./BaseStage');
const path = require('path');
const fs = require('fs');

class ConfluenceStage extends BaseStage {
  async execute(stageConfig, basePath) {
    // target 블록에 설정된 환경변수에서 confluence 설정 유무 확인
    const isEnabled = this.engine.context.variables.confluence || stageConfig.enabled;

    if (!isEnabled || isEnabled.toString().toLowerCase() !== 'true') {
      console.log(`[ConfluenceStage] Confluence integration is disabled. Skipping.`);
      return;
    }

    console.log(`\n[ConfluenceStage] Starting Confluence auto-update...`);
    
    // bas-node/src/HlngConfluence.js 를 실행해야 하므로 경로 계산
    // PipelineEngine은 src/deploy/에 있으므로 상위 디렉터리로 접근
    const scriptPath = path.resolve(__dirname, '..', '..', 'HlngConfluence.js');
    
    if (!fs.existsSync(scriptPath)) {
      console.log(`[ConfluenceStage] Warning: Confluence script not found at ${scriptPath}`);
      return;
    }

    // 환경 변수 세팅 (필요시 추가)
    // HlngConfluence.js는 주로 process.env 나 특정 파라미터에 의존하므로 
    // 엔진 컨텍스트 변수들을 시스템 env 형태로 넘겨줄 수도 있습니다.
    
    // 단순히 Node 스크립트 실행
    const cmd = `node "${scriptPath}"`;
    console.log(`[ConfluenceStage] Executing: ${cmd}`);
    this.engine.runCommand(cmd, basePath);

    console.log(`[ConfluenceStage] Confluence updated successfully.`);
  }
}

module.exports = ConfluenceStage;
