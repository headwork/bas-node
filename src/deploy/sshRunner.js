const { buildRemoteEnv } = require('./remoteEnv');

/**
 * 원격 명령 실행기. (#P202609_002 TASK6)
 *
 * `RemoteDeployMacroStage` 와 `RemoteRollbackMacroStage` 에 **같은 코드가 복사돼 있었다.**
 * 이 과제가 없애려는 것이 바로 그 이중화라 여기로 합친다.
 *
 * 반환 시그니처는 `engine.runCommand` 와 같다 — `(cmd, opts) -> { code, output }`.
 * 그래서 위층(ScriptControlStage 등)은 로컬인지 원격인지 모르고 같은 코드를 탄다.
 *
 * ⚠️ `opts.env` 는 **원격** 환경변수다. 로컬 runCommand 로 넘기면 엉뚱한 프로세스에 붙으므로
 *    여기서 `set` 으로 조립해 원격 cmd 에 싣고, 나머지 옵션만 내려보낸다.
 */
function makeSshRunner(engine, { target, port, keyPath, basePath }) {
  const sshPort = port ? `-p ${port}` : '';           // ssh 는 소문자 -p (scp 는 대문자 -P)
  const keyArg = keyPath ? `-i "${keyPath}"` : '';

  return (remoteCmd, opts = {}) => {
    const { env, ...rest } = opts;
    const prefix = env ? buildRemoteEnv(env) : '';
    const cmd = `ssh ${sshPort} -o StrictHostKeyChecking=no ${keyArg} ${target} "${prefix}${remoteCmd}"`;
    console.log(`  [ssh] ${prefix}${remoteCmd}`);
    return engine.runCommand(cmd, basePath, rest);
  };
}

module.exports = { makeSshRunner };
