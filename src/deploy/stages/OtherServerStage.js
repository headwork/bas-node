const BaseStage = require('./BaseStage');

class OtherServerStage extends BaseStage {
  async execute(stageConfig, basePath) {
    const host = stageConfig.host;
    const user = stageConfig.user;
    const keyPath = stageConfig.key_path;
    const remotePath = stageConfig.remote_path;
    const buildPath = this.engine.context.variables.build_path || stageConfig.build_path;

    if (!host || !user || !remotePath || !buildPath) {
      throw new Error("OtherServerStage requires 'host', 'user', 'remote_path', and 'build_path'.");
    }

    console.log(`\n[OtherServerStage] Starting remote server deployment via SSH/SCP...`);
    console.log(`- Target Host: ${user}@${host}`);
    console.log(`- Remote Path: ${remotePath}`);
    
    // 1. SSH 키 설정
    const keyArg = keyPath ? `-i "${keyPath}"` : '';

    // 2. SCP를 통한 빌드 결과물 전송 (Windows 10+ 및 Linux 기본 지원)
    // -o StrictHostKeyChecking=no 는 최초 접속 프롬프트 방지
    const scpCmd = `scp -r -o StrictHostKeyChecking=no ${keyArg} "${buildPath}/*" ${user}@${host}:"${remotePath}"`;
    console.log(`[OtherServerStage] Uploading files...`);
    this.engine.runCommand(scpCmd, basePath);

    // 3. 원격 서버에서 배포 후처리 스크립트 실행 (선택사항)
    if (stageConfig.remote_cmd) {
      console.log(`[OtherServerStage] Executing remote command...`);
      const sshCmd = `ssh -o StrictHostKeyChecking=no ${keyArg} ${user}@${host} "${stageConfig.remote_cmd}"`;
      this.engine.runCommand(sshCmd, basePath);
    }

    console.log(`[OtherServerStage] Remote deployment completed successfully.`);
  }
}

module.exports = OtherServerStage;
