/**
 * 스크립트에 넘기는 값의 형식. (#P202609_002 [D10] · TASK7)
 *
 * 값은 **환경변수 하나에 문자열 하나**로 들어간다. 목록을 넘겨야 할 때는 구분자로 잇는데,
 * 그 구분자를 정하는 것은 Node 쪽 사정이 아니라 **cmd 의 사정**이다 —
 * `for %%N in (%DP_PRESERVE%)` 가 공백·쉼표·세미콜론에서 쪼갠다.
 *
 * 그래서 이름에 그 문자들이 들어가면 **조용히 두 개로 쪼개진다.** 쪼개진 이름은
 * "이전 배포본에 없음" 으로 건너뛰어지므로 **배포는 성공하고 데이터만 사라진다.**
 * 여기서 멈추는 이유가 그것이다.
 */

/** cmd 의 `for` 가 토큰을 가르는 문자들. 와일드카드는 경로 확장으로 새는 자리다. */
const SPLITTERS = /[\s,;]/;
const WILDCARD = /[*?]/;

/**
 * preserve 목록을 `DP_PRESERVE` 값으로 잇는다.
 *
 * @param names 배포본 사이로 옮길 이름들 (파일·폴더 모두 가능)
 * @returns 세미콜론으로 이은 문자열. 빈 목록이면 빈 문자열
 */
function joinPreserve(names) {
  const list = Array.isArray(names) ? names : [];

  for (const raw of list) {
    const name = String(raw);
    if (SPLITTERS.test(name)) {
      throw new Error(
        `preserve 이름에 공백·쉼표·세미콜론을 쓸 수 없습니다: "${name}"\n` +
        `  스크립트가 그 자리에서 목록을 쪼개므로 이름이 둘로 갈라지고,\n` +
        `  갈라진 이름은 "없음" 으로 건너뛰어져 **배포는 성공하고 데이터만 사라집니다.**`
      );
    }
    if (WILDCARD.test(name)) {
      throw new Error(
        `preserve 이름에 와일드카드를 쓸 수 없습니다: "${name}"\n` +
        `  cmd 의 for 가 경로로 펼쳐 엉뚱한 항목이 섞입니다. 이름을 그대로 적으십시오.`
      );
    }
  }

  return list.join(';');
}

module.exports = { joinPreserve };
