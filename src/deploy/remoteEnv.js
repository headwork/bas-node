/**
 * 원격 cmd 에 환경변수를 실어 보낸다. (#P202609_002 [D10])
 *
 * 배포 스크립트는 값을 **환경변수로** 받는다 — 위치 인자는 순서를 틀리면
 * 조용히 잘못 동작하기 때문이다. 원격에서는 그것을 `set` 으로 앞에 붙인다.
 *
 *   set A=1&set B=2&script.bat
 *
 * ⚠️ **따옴표를 쓰지 않는다.** 명령 전체가 이미 `ssh host "…"` 안에 들어가므로
 *    여기서 `set "A=B"` 로 적으면 따옴표가 겹쳐 인용이 깨진다
 *    (`RemoteDeployMacroStage.js` 의 인용 주석과 같은 문제).
 *
 * 따옴표를 못 쓰니 **공백이 든 값을 실을 수 없다.** 이 저장소는 원격 경로에
 * 공백이 없다고 이미 가정하고 있고(`move ${livePath} ${backupPath}` 가 인용 없이 나간다),
 * 그 가정을 여기서 **검사로 굳힌다** — 공백이 들어오면 조용히 깨지는 대신 즉시 멈춘다.
 */

// cmd 가 명령으로 승격시키거나 변수로 펼치는 문자들.
const META = /["&|<>^%]/;

function buildRemoteEnv(env) {
  const parts = [];

  for (const [key, raw] of Object.entries(env)) {
    if (raw === undefined || raw === null) continue;
    const value = String(raw);

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`원격 환경변수 이름이 올바르지 않습니다: ${key}`);
    }
    if (/\s/.test(value)) {
      throw new Error(
        `원격 환경변수에 공백을 실을 수 없습니다: ${key}=${value}\n` +
        `  ssh 인용이 겹쳐 값이 잘립니다. 공백 없는 경로를 쓰십시오.`
      );
    }
    if (META.test(value)) {
      throw new Error(
        `원격 환경변수에 cmd 특수문자를 실을 수 없습니다: ${key}=${value}\n` +
        `  " & | < > ^ % 는 원격 셸이 명령으로 해석합니다.`
      );
    }

    parts.push(`set ${key}=${value}`);
  }

  return parts.length > 0 ? `${parts.join('&')}&` : '';
}

/**
 * 원격에 맨몸으로 나가는 경로를 검사한다.
 *
 * 값(`buildRemoteEnv`)과 같은 제약이 **스크립트 경로 자체**에도 걸린다 — 그것도
 * `ssh host "…"` 안에 따옴표 없이 들어가기 때문이다. 공백이 있으면 경로가 조용히
 * 잘리고, 잘린 경로로 move 가 돌면 엉뚱한 폴더가 옮겨간다.
 *
 * 검사를 여기 두는 이유는 **부르는 자리가 넷**이기 때문이다(배포·롤백 매크로,
 * 웹서버 제어, 스크립트 전송). 각자 적으면 한 곳만 고쳐지는 날이 온다.
 */
function assertRemotePath(p, what = '원격 스크립트 경로') {
  if (/\s/.test(String(p))) {
    throw new Error(
      `${what}에 공백을 쓸 수 없습니다: ${p}\n` +
      `  ssh 인용이 겹쳐 값이 잘립니다. 공백 없는 경로를 쓰십시오.`
    );
  }
}

module.exports = { buildRemoteEnv, assertRemotePath };
