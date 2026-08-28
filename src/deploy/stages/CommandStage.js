const BaseStage = require('./BaseStage');

/**
 * 임의 명령 실행.
 *
 *   - sync: "npm ci"                      문자열 그대로
 *   - sync: { cmd: "npm ci", group: ... }  객체 형태
 *
 * 객체 형태를 받는 이유는 `group`·`if`·`unless` 같은 메타를 붙일 자리가 필요해서다.
 * 문자열만 받으면 이 스테이지들은 `--only` 그룹 실행에서 통째로 빠진다.
 */
class CommandStage extends BaseStage {
  async execute(stageConfig, basePath) {
    if (typeof stageConfig === 'string') {
      this.engine.runCommand(stageConfig, basePath);
      return;
    }

    if (stageConfig && typeof stageConfig === 'object' && typeof stageConfig.cmd === 'string') {
      this.engine.runCommand(stageConfig.cmd, stageConfig.cwd || basePath);
      return;
    }

    throw new Error('Invalid config for command stage: ' + JSON.stringify(stageConfig));
  }
}

module.exports = CommandStage;
