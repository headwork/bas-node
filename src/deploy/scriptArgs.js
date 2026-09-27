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

/**
 * 분류를 스크립트가 받을 목록으로 옮긴다. (#P003-TASK5)
 *
 * **스크립트는 분류를 모른다.** 분류 이름이 bat 안에 들어가면 정책이 스크립트로 새고,
 * 그때부터는 정책을 바꿀 때마다 배포서버의 스크립트를 함께 고쳐야 한다 (`[D10]` 경계).
 * 그래서 Node 가 여기서 **용도별 목록**으로 바꿔 넘긴다.
 *
 * | 변수 | 값 | 쓰는 쪽 |
 * |---|---|---|
 * | `DP_EXCLUDE` | `config` | copy — 복사에서 뺀다. 산출물의 설정이 서버 설정을 덮지 않게 |
 * | `DP_DELTA`   | `temp` + `data` | swap — 스왑 뒤 `_org_` 에서 따라잡는다 |
 *
 * `temp`·`data` 가 `DP_EXCLUDE` 에 없는 것은 실수가 아니다 — **산출물에 그 이름이 없어서**
 * 충돌 자체가 일어나지 않는다. robocopy 는 미러가 아니면 원본에 없는 파일을 지우지 않는다.
 * 없는 위험을 막는 설정을 적어 두면 읽는 사람이 "왜 이게 필요하지" 를 매번 다시 묻게 된다.
 */
function preserveScriptArgs(classified) {
  const kinds = classified || {};
  return {
    DP_EXCLUDE: joinPreserve(kinds.config || []) || undefined,
    DP_DELTA: joinPreserve([...(kinds.temp || []), ...(kinds.data || [])]) || undefined
  };
}

module.exports = { joinPreserve, preserveScriptArgs };
