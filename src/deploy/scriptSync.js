const fs = require('fs');
const path = require('path');
const { assertRemotePath } = require('./remoteEnv');

/**
 * 공용 스크립트를 원격 배포서버에 맞춘다. (#P202609_002 [D10] · TASK5)
 *
 * `#P002-OQ4` 확정안이 **(b) 수동 배치 + (e) 별도 scp** 다.
 *
 *   (b) 사람이 도구 서버 한 곳에 놓는다        `${tool_home}/script/windows`
 *   (e) 도구가 배포 때마다 원격으로 밀어 넣는다  `${upload_path}\_scripts\windows`
 *
 * **산출물 zip 에 실어 보내지 않는다.** zip 은 임시폴더에 풀려 **그대로 라이브가 되므로**
 * 배포 스크립트가 서비스 폴더에 남는다(계획서 `[D10]` 초안에서 철회한 안이다).
 * 그래서 전송을 따로 한 번 더 한다 — 왕복 2회가 늘지만 라이브가 깨끗하다.
 *
 * ## 매번 덮어쓴다
 *
 * "이미 있으면 건너뛴다" 를 하지 않는다. 원격에 **옛 판**이 남아 있는 경우가 가장 위험하다 —
 * 종료코드 규약(`06_배포_스크립트_규약.md` §4)이 바뀌면 Node 가 실패를 성공으로 읽고
 * 옛 프로세스가 새 파일을 서비스한다. 파일 서너 개라 매번 보내는 값이 싸다.
 */

/** 보낼 대상. 확장자로만 고른다 — 폴더에 README 나 백업본이 섞여도 딸려가지 않는다. */
const SCRIPT_EXT = /\.(bat|cmd|sh|ps1)$/i;

const GUIDE = 'docs/design/배포/06_배포_스크립트_규약.md';

/**
 * `script_dir` 을 안 적었을 때 보는 자리 — 도구 옆의 `script/windows`.
 *
 * 네 매크로가 **같은 식을 복사해 들고 있었다.** 이 과제가 없애려는 것이 그것이라 합친다.
 * 폴더 이름이 바뀌면 여기 한 줄만 바뀐다.
 */
function defaultScriptDir(vars = {}, os = 'windows') {
  return path.join(vars.tool_home || '.', 'script', os);
}

/**
 * 스크립트 폴더의 파일 목록. 폴더가 없으면 null (빈 폴더와 구분한다 — 사유가 다르다).
 * 정렬해서 돌려준다: 명령이 실행마다 달라지면 스냅샷으로 죌 수 없다.
 */
function listScripts(localDir) {
  let names;
  try {
    names = fs.readdirSync(localDir);
  } catch {
    return null;
  }
  return names.filter(n => SCRIPT_EXT.test(n)).sort();
}

/**
 * 로컬 스크립트 폴더를 원격에 복사한다.
 *
 * @param ssh       원격 실행기 (`makeSshRunner` 가 만든 것)
 * @param localDir  도구 서버의 스크립트 폴더
 * @param remoteDir 원격에 놓을 자리 (**역슬래시 경로**. cmd 가 받는다)
 * @returns {string[]} 보낸 파일 이름들
 */
function syncRemoteScripts(engine, { ssh, localDir, remoteDir, target, port, keyPath, basePath }) {
  if (!localDir) {
    throw new Error(
      `스크립트 폴더를 알 수 없습니다.\n` +
      `  yaml 의 script_dir 을 적거나, tool_home 아래 script/windows 에 두십시오. (${GUIDE})`
    );
  }
  // 스크립트를 실행하는 자리에서도 같은 검사가 걸리지만, **여기서 먼저 만난다** —
  // 전송이 배포의 첫 단계라 이 자리에서 멈추면 원격은 손도 대지 않은 상태다.
  assertRemotePath(remoteDir, '원격 스크립트 폴더');

  const names = listScripts(localDir);
  if (names === null) {
    // 배포를 시작하기 전에 멈춘다. 이것을 Step 3(웹서버 정지)에서 만나면
    // 업로드·압축해제를 다 하고 나서 실패한다.
    throw new Error(
      `스크립트 폴더가 없습니다: ${localDir}\n` +
      `  배포서버 제어용 공용 스크립트(deploy.bat · webserver_<type>.bat)를 이 자리에 두십시오.\n` +
      `  원본은 저장소의 docs/design/template/windows/ 에 있습니다. (${GUIDE})`
    );
  }
  if (names.length === 0) {
    throw new Error(`스크립트 폴더가 비어 있습니다: ${localDir} (${GUIDE})`);
  }

  ssh(`if not exist ${remoteDir} mkdir ${remoteDir}`);

  // 파일을 하나씩 나열한다. 와일드카드를 쓰지 않는 이유가 둘이다 —
  //   · cmd 는 `*.bat` 을 펼치지 않는다(펼치는 것은 셸이고 cmd 는 안 한다).
  //   · `scp -r <폴더>` 는 대상이 이미 있을 때 OpenSSH 판에 따라 한 겹 더 들어간다.
  // 목록은 Node 가 이미 읽었으므로 펼칠 것도 없다.
  const sources = names.map(n => `"${path.join(localDir, n)}"`).join(' ');
  const scpPort = port ? `-P ${port}` : '';           // scp 는 대문자 -P
  const keyArg = keyPath ? `-i "${keyPath}"` : '';
  // scp 의 원격 경로는 슬래시다. 역슬래시는 인용 안에서 이스케이프로 먹힌다.
  const dest = String(remoteDir).replace(/\\/g, '/');

  engine.runCommand(
    `scp ${scpPort} -o StrictHostKeyChecking=no ${keyArg} ${sources} ${target}:"${dest}/"`,
    basePath
  );
  console.log(`  [scripts] ${names.length}개 전송: ${names.join(', ')}`);

  return names;
}

/**
 * 부르기 직전에 스크립트가 있는지 본다. (#P202609_002 TASK7b)
 *
 * 🔴 **없으면 종료코드가 거짓말을 한다.** cmd 는 없는 배치 파일에 `1` 을 내는데,
 *    `1` 은 계약상 *"배포 실패 - 라이브는 이전 빌드로 살아 있습니다"* 다.
 *    스크립트를 못 찾았을 뿐인데 배포가 실패했다고 보고된다.
 *
 * 흔한 원인이 `tool_home` 이다. 소스에서 바로 돌리면(`node src/deploy/deploy-cli.js`)
 * 진입점이 `src/deploy` 라 그 아래를 찾는다. 배포된 도구는 번들 한 장이 루트에 있어
 * 제대로 잡힌다 — 그래서 **개발할 때만** 어긋나고, 그때 이 메시지를 본다.
 */
function assertScript(scriptPath, scriptDir) {
  if (fs.existsSync(scriptPath)) return;
  throw new Error(
    `배포 스크립트를 찾을 수 없습니다: ${scriptPath}\n` +
    `  찾은 폴더 : ${scriptDir}\n` +
    `  yaml 의 script_dir 로 폴더를 지정하거나, 도구 옆 script/windows 에 두십시오.\n` +
    `  원본은 저장소의 docs/design/template/windows/ 에 있습니다. (${GUIDE})`
  );
}

module.exports = { syncRemoteScripts, listScripts, assertScript, defaultScriptDir, SCRIPT_EXT };
