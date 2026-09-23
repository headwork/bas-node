/**
 * 폴더를 잡고 있는 프로세스를 찾아 로그에 남긴다. (#P202609_003 TASK2)
 *
 * Windows 는 폴더 안에 열린 핸들이 하나라도 있으면 그 폴더의 이동·이름변경을 거부한다.
 * 그때 돌아오는 것은 `액세스가 거부되었습니다.` 한 줄뿐이고, **누가 잡고 있는지는 말해 주지 않는다.**
 * 2026-09-22 QA 배포 실패(`plWesysDeployNode#15`)가 그랬다 — 사람이 원격에 들어가 짐작으로 찾아야 했다.
 *
 * 여기서 만드는 것은 **진단**이지 판정이 아니다. 실패 사유는 이미 종료코드가 말했고,
 * 이 출력은 "그래서 누구에게 닫아 달라고 할까"에만 쓰인다. 그래서 실패해도 조용히 넘어간다 —
 * 진단이 실패해서 배포 결과가 달라지면 안 된다.
 *
 * ## 무엇을 잡아내나
 *
 * | 잡는다 | 못 잡는다 |
 * |---|---|
 * | 그 폴더의 DLL·EXE 를 로드한 프로세스 (w3wp, dotnet) | 그 폴더를 현재 디렉터리로 둔 cmd·PowerShell |
 * | 그 폴더에서 실행 중인 프로세스 | 탐색기의 폴더 감시 핸들 |
 *
 * 못 잡는 쪽까지 보려면 핸들 테이블을 훑어야 하고(Sysinternals `handle.exe` 급), 그건 배포서버에
 * 도구를 하나 더 깔라는 말이 된다. **가장 흔한 원인(w3wp 가 아직 안 죽음)을 잡는 것이 목적**이고,
 * 잡히지 않으면 "찾지 못했다"고 말한다 — 없다고 단정하지 않는다.
 *
 * ## 왜 파이프(`|`)를 쓰지 않나
 *
 * 원격은 `ssh "<명령>"` 안의 **cmd** 가 받는다. `|` 를 넣으면 cmd 가 파이프로 먹고,
 * 큰따옴표를 넣으면 ssh 의 인용과 겹친다(`RemoteDeployMacroStage.#remoteMtimes` 와 같은 제약).
 * 그래서 `Where-Object` 대신 `foreach`, 문자열은 홑따옴표만 쓴다.
 */

/**
 * 진단 명령 문자열. 로컬·원격이 같은 명령을 쓴다 — 어느 쪽도 cmd 가 받기 때문이다.
 * 출력은 한 줄에 하나, `HOLD <pid> <이름>` 형식이다.
 */
function lockDiagCommand(dirPath) {
  const p = String(dirPath).replace(/\//g, '\\').replace(/\\+$/, '');
  return 'powershell -NoProfile -c ' +
    `$p='${p}'; foreach($x in Get-Process){ try{ ` +
    `if($x.Path -and $x.Path.StartsWith($p,[System.StringComparison]::OrdinalIgnoreCase)){ ` +
    `'HOLD ' + $x.Id + ' ' + $x.ProcessName; continue } ` +
    `foreach($m in $x.Modules){ ` +
    `if($m.FileName.StartsWith($p,[System.StringComparison]::OrdinalIgnoreCase)){ ` +
    `'HOLD ' + $x.Id + ' ' + $x.ProcessName; break } } ` +
    '}catch{} }';
}

/** `HOLD <pid> <이름>` 줄만 골라 `{ pid, name }` 로. 그 외 줄은 버린다(경고·빈 줄). */
function parseHolders(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map(line => /^HOLD\s+(\d+)\s+(.+?)\s*$/.exec(line.trim()))
    .filter(Boolean)
    .map(m => ({ pid: Number(m[1]), name: m[2] }));
}

/**
 * 진단을 실행하고 결과를 출력한다. `run` 은 `(cmd, opts) -> { code, output }` 이면 된다 —
 * 로컬(`engine.runCommand`)과 원격(`sshRunner`)의 시그니처가 같아서 한 함수로 둘 다 쓴다.
 *
 * 절대 던지지 않는다. 실패 경로에서 부르는 함수라, 여기서 던지면 **원래 실패 사유가 가려진다.**
 */
function reportLockHolders(run, dirPath, logger = console) {
  let holders = [];
  try {
    const r = run(lockDiagCommand(dirPath), { capture: true, allowFailure: true });
    holders = parseHolders(r && r.output);
  } catch {
    logger.error(`  [lock] 잠금 프로세스를 조회하지 못했습니다`);
    return [];
  }

  if (holders.length === 0) {
    // 단정하지 않는다 — 탐색기·cmd 의 현재 디렉터리는 이 방법으로 보이지 않는다.
    logger.error(`  [lock] ${dirPath} 를 잡고 있는 프로세스를 찾지 못했습니다`);
    logger.error(`  [lock]   탐색기나 cmd 가 그 폴더를 열고 있으면 여기에 나오지 않습니다. 원격에서 확인하십시오`);
    return [];
  }

  logger.error(`  [lock] ${dirPath} 를 잡고 있는 프로세스 ${holders.length}건:`);
  for (const h of holders) logger.error(`  [lock]   ${h.name} (PID ${h.pid})`);
  return holders;
}

module.exports = { lockDiagCommand, parseHolders, reportLockHolders };
