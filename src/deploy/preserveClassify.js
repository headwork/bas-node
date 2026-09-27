/**
 * preserve 분류. (#P202609_003 REQ2)
 *
 * 예전에는 목록이 둘이었다 — `preserve`(운영 중 생성 항목)와 `preserve_config`(서버 설정).
 * 그 가름이 **시점**만 나눴기 때문에, 크기도 복구 가능성도 전혀 다른 것들이 한 줄에 섞였다.
 * 업로드 폴더와 캐시 폴더가 같은 취급을 받는 것이 문제다.
 *
 *   temp    다시 만들어진다            → 백업할 가치는 없지만 **새 배포본에는 있어야 한다**
 *   data    유실되면 복구 불가          → 반드시 옮긴다
 *   config  없으면 서비스가 안 뜬다     → 옮기고, `config_backup` 사본도 갱신한다
 *
 * ## 기준은 "백업할 가치"가 아니라 "새 배포본에 있어야 하는가"다
 *
 * `_preserve_<stamp>` 는 백업이면서 **이월 원본**이다(`EX_D01_01` §3). 그래서 재생성 가능한
 * `temp` 도 담는다. 백업 관점만 보면 빼는 게 맞지만, 그러면 이월할 원본이 사라진다.
 *
 * ## 하위호환 — 조용히 달라지지 않게
 *
 * 운영 중인 YAML 이 있다(#P002-REQ5 와 같은 원칙). 옛 형식은 **승격**해서 받는다.
 *
 *   preserve: ["uploads", "Temp"]        → data (전부)
 *   preserve_config: ["web.config"]      → config
 *
 * 옛 `preserve` 를 `temp` 로 보내지 않는 이유: 둘을 가를 정보가 없고, `temp` 로 잘못 넣으면
 * **백업에서 빠지는 쪽**이라 데이터가 사라질 수 있다. 판단이 안 서면 잃지 않는 쪽으로 둔다.
 */

const KINDS = ['temp', 'data', 'config'];

/** cmd 의 `for` 가 토큰을 가르는 문자들 — scriptArgs 와 같은 규칙이다. */
const SPLITTERS = /[\s,;]/;
const WILDCARD = /[*?]/;

function assertName(name, kind) {
  if (SPLITTERS.test(name)) {
    throw new Error(
      `preserve.${kind} 이름에 공백·쉼표·세미콜론을 쓸 수 없습니다: "${name}"\n` +
      `  스크립트가 그 자리에서 목록을 쪼개므로 이름이 갈라지고,\n` +
      `  갈라진 이름은 "없음" 으로 건너뛰어져 **배포는 성공하고 데이터만 사라집니다.**`
    );
  }
  if (WILDCARD.test(name)) {
    throw new Error(
      `preserve.${kind} 이름에 와일드카드를 쓸 수 없습니다: "${name}"\n` +
      `  cmd 의 for 가 경로로 펼쳐 엉뚱한 항목이 섞입니다. 이름을 그대로 적으십시오.`
    );
  }
}

function toList(value) {
  if (value === null || value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map(String).filter(s => s.length > 0);
}

/**
 * YAML 의 `preserve` · `preserve_config` 를 분류로 정규화한다.
 *
 * @param preserve       새 형식({temp,data,config}) 또는 옛 평면 배열
 * @param preserveConfig 옛 `preserve_config` 배열
 * @returns {{temp: string[], data: string[], config: string[], promoted: string[]}}
 *          `promoted` 는 승격이 일어난 자리를 사람이 읽을 문장으로 담는다 (--dry-run 출력용)
 */
function classifyPreserve(preserve, preserveConfig) {
  const out = { temp: [], data: [], config: [], promoted: [] };

  const isClassified = preserve && !Array.isArray(preserve) && typeof preserve === 'object';

  if (isClassified) {
    const unknown = Object.keys(preserve).filter(k => !KINDS.includes(k));
    if (unknown.length > 0) {
      // 조용히 무시하면 그 목록이 통째로 사라진다 — 배포는 성공하고 데이터만 없어진다.
      throw new Error(
        `preserve 에 알 수 없는 분류가 있습니다: ${unknown.join(', ')}\n` +
        `  쓸 수 있는 분류는 ${KINDS.join(' · ')} 입니다.`
      );
    }
    for (const kind of KINDS) out[kind] = toList(preserve[kind]);
  } else {
    const legacy = toList(preserve);
    if (legacy.length > 0) {
      out.data = legacy;
      out.promoted.push(`preserve: [${legacy.join(', ')}] -> data (옛 형식)`);
    }
  }

  const legacyConfig = toList(preserveConfig);
  if (legacyConfig.length > 0) {
    // 새 형식과 같이 쓰면 합친다. 어느 한쪽만 읽으면 나머지가 조용히 빠진다.
    out.config = [...out.config, ...legacyConfig.filter(n => !out.config.includes(n))];
    out.promoted.push(`preserve_config: [${legacyConfig.join(', ')}] -> config (옛 형식)`);
  }

  for (const kind of KINDS) for (const name of out[kind]) assertName(name, kind);

  const seen = new Map();
  for (const kind of KINDS) {
    for (const name of out[kind]) {
      if (seen.has(name)) {
        // 같은 이름이 두 분류에 있으면 어느 정책을 따라야 하는지 정할 수 없다.
        throw new Error(
          `preserve 에 같은 이름이 두 분류에 있습니다: "${name}" (${seen.get(name)} · ${kind})\n` +
          `  분류마다 백업·복사 정책이 다르므로 한 곳에만 적어야 합니다.`
        );
      }
      seen.set(name, kind);
    }
  }

  return out;
}

/** 전부 합친 목록. 백업(`_preserve_<stamp>`)이 담을 것이 이것이다. */
function allNames(classified) {
  return KINDS.flatMap(kind => classified[kind]);
}

/** 옛 형식으로 읽혔는지. `--dry-run` 이 승격 결과를 보여 줄지 정한다. */
function wasPromoted(classified) {
  return classified.promoted.length > 0;
}

module.exports = { KINDS, classifyPreserve, allNames, wasPromoted };
