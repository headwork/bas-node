const BaseStage = require('./BaseStage');
const path = require('path');

/**
 * 원격 서버로 파일을 올리고(선택) 원격 명령을 실행한다.
 *
 * 두 가지 전송 방식을 모두 받는다.
 *   file:  <경로>   파일 하나만 올린다 (압축파일 업로드 — 실제 운영 흐름)
 *   (생략)          build_path 폴더 전체를 올린다 (기존 동작)
 *
 * file 을 생략하고 archive 스테이지가 앞서 돌았다면 `archive_path` 를 자동으로 집는다.
 * 폴더 통째 전송은 수천 개 파일을 개별 SSH 왕복으로 보내 매우 느리므로,
 * 압축파일 한 개를 올리는 쪽이 기본 경로다.
 *
 * 포트를 반드시 넘길 수 있어야 한다 — 운영서버는 22 가 아니라 9222 이고,
 * ~/.ssh/config 에 포트가 적혀 있지 않다. scp 는 대문자 -P, ssh 는 소문자 -p 다.
 * 이 둘을 섞어 쓰면 scp 가 -p 를 "타임스탬프 보존" 으로 해석해 조용히 22 번으로 나간다.
 */
class OtherServerStage extends BaseStage {
  async execute(stageConfig, basePath) {
    const vars = this.engine.context.variables;

    const host = stageConfig.host || vars.host;
    const user = stageConfig.user || vars.user;
    const port = stageConfig.port || vars.port || null;
    const keyPath = stageConfig.key_path || vars.key_path;
    const remotePath = stageConfig.remote_path || vars.remote_path;

    // 올릴 것: 명시 file > archive 스테이지 산출물 > build_path 폴더 전체
    const file = stageConfig.file || (stageConfig.file === undefined ? vars.archive_path : null);
    const buildPath = vars.build_path || stageConfig.build_path;

    // user·key_path 는 선택이다. ~/.ssh/config 에 Host 항목이 있으면 ssh 가 알아서 찾는다.
    if (!host || !remotePath) {
      throw new Error("OtherServerStage requires 'host' and 'remote_path'.");
    }
    const target = user ? `${user}@${host}` : host;
    if (!file && !buildPath) {
      throw new Error("OtherServerStage requires 'file' (또는 archive_path) 또는 'build_path'.");
    }

    console.log(`\n[OtherServerStage] Starting remote deployment via scp/ssh...`);
    console.log(`- Target : ${target}${port ? `:${port}` : ' (포트: ssh config)'}`);
    if (!user) console.log(`- Account: ssh config 의 User 를 따릅니다`);
    console.log(`- Remote : ${remotePath}`);

    const keyArg = keyPath ? `-i "${keyPath}"` : '';
    const scpPort = port ? `-P ${port}` : '';   // scp 는 대문자
    const sshPort = port ? `-p ${port}` : '';   // ssh 는 소문자

    if (file) {
      console.log(`- Upload : ${path.basename(file)} (파일 1개)`);
      const scpCmd = `scp ${scpPort} -o StrictHostKeyChecking=no ${keyArg} "${file}" ${target}:"${remotePath}"`;
      this.engine.runCommand(scpCmd, basePath);
    } else {
      console.log(`- Upload : ${buildPath} (폴더 전체)`);
      const scpCmd = `scp -r ${scpPort} -o StrictHostKeyChecking=no ${keyArg} "${buildPath}/*" ${target}:"${remotePath}"`;
      this.engine.runCommand(scpCmd, basePath);
    }

    if (stageConfig.remote_cmd) {
      console.log(`[OtherServerStage] Executing remote command...`);
      const sshCmd = `ssh ${sshPort} -o StrictHostKeyChecking=no ${keyArg} ${target} "${stageConfig.remote_cmd}"`;
      this.engine.runCommand(sshCmd, basePath);
    }

    console.log(`[OtherServerStage] Remote deployment completed successfully.`);
  }
}

module.exports = OtherServerStage;
