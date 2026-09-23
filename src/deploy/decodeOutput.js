/**
 * 명령 출력 디코더. (#P202609_003 TASK3)
 *
 * `execSync` 에 `encoding:'utf8'` 을 주면 **UTF-8 로 고정 해석**된다. 그런데 이 도구가 읽는
 * 출력의 상당수는 원격 `cmd` 가 낸 것이고, 한글 Windows 의 cmd 는 **CP949** 로 말한다.
 * 그래서 정작 중요한 한 줄이 깨진다 — 2026-09-22 QA 배포 실패에서 원인을 말해 주는 줄이
 * `액세스가 거부되었습니다.` 가 아니라 `�׼����� �źεǾ����ϴ�.` 로 찍혔고,
 * 그 한 줄이 깨진 탓에 "왜 실패했는지"를 스크립트 본문을 읽어서 역추적해야 했다.
 *
 * ## 왜 코드페이지를 물어보지 않나
 *
 * 출력마다 다르기 때문이다. 같은 배포 안에서도 Node 가 UTF-8 로 낸 줄과 원격 cmd 가 CP949 로
 * 낸 줄이 **한 버퍼에 섞인다**(`output: stdout + stderr`). 실행 전에 하나로 정할 수가 없다.
 *
 * ## 판정 기준은 U+FFFD 다
 *
 * UTF-8 로 읽어 **치환문자(U+FFFD)가 나오면 UTF-8 이 아니다.** CP949 바이트열은 UTF-8 로
 * 유효한 경우가 거의 없어 이 판정이 선다(ASCII 는 양쪽이 같으므로 영향 없음).
 * 반대 방향은 성립하지 않는다 — UTF-8 바이트를 CP949 로 읽으면 **깨진 채로 성공**하므로
 * 순서를 바꾸면 안 된다. UTF-8 을 먼저 시도하는 것이 이 함수의 전부다.
 */

/** UTF-8 로 읽고, 깨졌으면 CP949 로 다시 읽는다. 문자열이 들어오면 그대로 돌려준다. */
function decodeOutput(raw) {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string') return raw;      // 이미 디코드된 것 (encoding 옵션을 준 호출)
  if (!Buffer.isBuffer(raw)) return String(raw);

  const utf8 = raw.toString('utf8');
  if (!utf8.includes('�')) return utf8;

  try {
    // Node 13+ 는 full-icu 를 내장한다 (v22.14 실측). 없는 빌드면 throw 하므로 UTF-8 로 돌아간다.
    return new TextDecoder('euc-kr').decode(raw);
  } catch {
    return utf8;
  }
}

module.exports = { decodeOutput };
