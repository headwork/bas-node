const BaseStage = require('./BaseStage');
const { WEBSERVER, reasonFor } = require('../scriptExit');
const { assertRemotePath } = require('../remoteEnv');

/**
 * 웹서버 제어를 **스크립트에 위임**한다. (#P202609_002 [D10] · TASK6)
 *
 * `IisControlStage` 를 대체한다. 달라진 것은 둘이다.
 *
 *   1. appcmd 를 직접 부르지 않고 `webserver_<type>.bat` 을 부른다.
 *      새 웹서버는 스크립트 한 장을 옆에 놓으면 되고 이 파일은 열리지 않는다.
 *
 *   2. **출력을 파싱하지 않는다.** 지금까지 BENIGN/FATAL 정규식이 필요했던 이유는
 *      appcmd 가 "이미 멈춤" 에도 0 이 아닌 코드를 내고 그 메시지가 **서버 로캘**을
 *      따르기 때문이다(한글 Windows 면 한글). 스크립트가 종료코드로 정규화해 주므로
 *      여기서는 코드만 본다 — 로캘에 의존하지 않는다.
 *
 * 로컬·원격 구현이 **한 벌**이다. 다른 것은 주입받는 runner 뿐이고,
 * 두 runner 의 시그니처가 이미 같다 — `(cmd, opts) -> { code, output }`.
 */

/**
 * 스크립트와의 계약. 표는 `src/deploy/scriptExit.js` 에 **한 벌만** 둔다 —
 * deploy.bat 도 같은 표를 쓰므로 여기에 또 적으면 두 곳이 갈린다.
 */
const EXIT_REASON = WEBSERVER;

const ACTIONS = ['stop', 'start', 'reload'];

class ScriptControlStage extends BaseStage {
  /** `web_server_control` 스테이지로 직접 쓸 때(로컬). */
  async execute(stageConfig, basePath) {
    const vars = this.engine.context.variables;
    const cfg = (key) => stageConfig[key] !== undefined ? stageConfig[key] : vars[key];

    return this.control({
      action: stageConfig.action,
      scriptDir: cfg('script_dir'),
      type: cfg('web_server_type'),
      name: stageConfig.site || cfg('web_server_name') || cfg('iis_site'),
      pool: cfg('web_server_pool'),
      runner: (cmd, opts) => this.engine.runCommand(cmd, basePath, opts),
      sep: '\\'
    });
  }

  /**
   * 매크로가 부르는 자리. runner 만 바꿔 끼우면 로컬·원격이 같은 코드를 탄다.
   *
   * @param runner    (cmd, opts) -> { code, output }
   * @param scriptDir 스크립트가 있는 폴더. 로컬이면 로컬 경로, 원격이면 원격 경로다
   * @param sep       그 폴더의 경로 구분자
   * @param quote     경로를 따옴표로 감쌀지. **원격은 false 여야 한다** —
   *                  명령 전체가 이미 `ssh host "…"` 안에 들어가므로 여기서 또 감싸면
   *                  인용이 겹쳐 깨진다(`RemoteDeployMacroStage` 인용 주석과 같은 문제).
   */
  async control({ action, scriptDir, type, name, pool, runner, sep = '\\', quote = true, skip = false }) {
    if (skip) {
      console.log(`  [webserver] 제어 건너뜀`);
      return;
    }

    if (!ACTIONS.includes(String(action))) {
      throw new Error(`ScriptControlStage: action 은 ${ACTIONS.join('|')} 여야 합니다 (받은 값: ${action})`);
    }
    // 기본값을 만들지 않는다. 짐작한 사이트명으로 남의 서비스를 내릴 수 있다.
    const missing = [];
    if (!scriptDir) missing.push('script_dir');
    if (!type) missing.push('web_server_type');
    if (!name) missing.push('web_server_name (또는 iis_site)');
    if (missing.length) {
      throw new Error(`웹서버 제어에 필요한 값이 없습니다: ${missing.join(', ')}`);
    }

    const script = `${String(scriptDir).replace(/[\\/]+$/, '')}${sep}webserver_${type}.bat`;

    // 따옴표를 못 쓰는 자리(원격)에서 공백이 든 경로는 **조용히 잘린다.** 즉시 멈춘다.
    if (!quote) assertRemotePath(script);

    const env = { WS_ACTION: action, WS_NAME: name };
    if (pool) env.WS_POOL = pool;

    // 출력은 사람이 보라고 잡는다. 판정은 코드로만 한다.
    const r = runner(quote ? `"${script}"` : script, { capture: true, allowFailure: true, env });

    const out = (r.output || '').trim();
    if (out) out.split(/\r?\n/).forEach(line => console.log(`  ${line}`));

    if (r.code === 0) return;

    const why = reasonFor(EXIT_REASON, r.code);
    console.error(`\n[webserver] ${action} 실패 - ${name} (${type})`);
    console.error(`  사유     : ${why}`);
    console.error(`  종료코드 : ${r.code}`);
    console.error(`  스크립트 : ${script}`);

    throw new Error(`웹서버 ${action} 실패: ${name} - ${why}`);
  }
}

module.exports = ScriptControlStage;
module.exports.EXIT_REASON = EXIT_REASON;
