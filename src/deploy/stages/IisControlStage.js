const BaseStage = require('./BaseStage');
const path = require('path');
const fs = require('fs');

/**
 * IIS 사이트/앱풀 제어.
 *
 * 실패 사유를 구분한다. 예전에는 모든 실패를 "이미 그 상태인가 보다"로 넘겼는데,
 * 그러면 권한 부족이나 사이트명 오타에도 파이프라인이 성공으로 끝난다.
 * 서비스를 세우지 못한 채 배포파일을 갈아치우게 되므로 반드시 구분해야 한다.
 */

// 이미 원하는 상태인 경우. 이건 진짜로 넘어가도 된다.
const BENIGN = [
  /already started/i,
  /already stopped/i,
  /ALREADY_STARTED/i,
  /ALREADY_STOPPED/i
];

// 넘어가면 안 되는 것들. 사유를 사람이 읽을 수 있게 붙인다.
const FATAL = [
  {
    re: /insufficient permissions|Access is denied|액세스가 거부|redirection\.config/i,
    why: '권한 부족 - IIS 제어에는 관리자 권한이 필요합니다 (관리자 터미널에서 실행)'
  },
  {
    re: /does not exist|cannot find|Unknown (site|apppool)|찾을 수 없/i,
    why: '대상을 찾을 수 없습니다 - 사이트/앱풀 이름을 확인하세요'
  }
];

class IisControlStage extends BaseStage {
  async execute(stageConfig, basePath) {
    const action = stageConfig.action; // 'start' or 'stop'
    const site = stageConfig.site;

    if (!action || !site) {
      throw new Error("IisControlStage requires 'action' and 'site' parameters.");
    }

    const validActions = ['start', 'stop'];
    if (!validActions.includes(action.toLowerCase())) {
      throw new Error(`Invalid action: ${action}. Must be 'start' or 'stop'.`);
    }

    if (process.platform !== 'win32') {
      console.log(`[IisControlStage] Skipped on non-Windows platform (action: ${action}, site: ${site})`);
      return;
    }

    const appcmd = path.join(process.env.windir || 'C:\\Windows', 'system32', 'inetsrv', 'appcmd.exe');
    if (!fs.existsSync(appcmd)) {
      throw new Error(`IIS management tool not found: ${appcmd}. IIS 가 설치되어 있는지 확인하세요.`);
    }

    this.run(appcmd, `${action} site /site.name:${site}`, `site ${site}`);
    this.run(appcmd, `${action} apppool /apppool.name:${site}`, `apppool ${site}`);
  }

  run(appcmd, args, label) {
    const cmd = `"${appcmd}" ${args}`;
    console.log(`[IisControlStage] Executing: ${cmd}`);

    // 출력을 잡아야 사유를 구분할 수 있다. inherit 로는 코드가 못 읽는다.
    const result = this.engine.runCommand(cmd, undefined, { capture: true, allowFailure: true });

    if (result.code === 0) {
      console.log(`[IisControlStage] OK - ${label}`);
      return;
    }

    const output = (result.output || '').trim();

    if (BENIGN.some(re => re.test(output))) {
      console.log(`[IisControlStage] 이미 원하는 상태입니다 - ${label}`);
      return;
    }

    const matched = FATAL.find(f => f.re.test(output));
    const why = matched ? matched.why : '알 수 없는 실패';

    console.error(`\n[IisControlStage] IIS 제어 실패 - ${label}`);
    console.error(`  사유     : ${why}`);
    console.error(`  종료코드 : ${result.code}`);
    if (output) console.error(`  출력     : ${output.split('\n').slice(0, 5).join('\n             ')}`);

    throw new Error(`IIS ${label} 제어 실패: ${why}`);
  }
}

module.exports = IisControlStage;
