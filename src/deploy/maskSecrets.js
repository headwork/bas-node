/**
 * 민감 정보가 콘솔 로그로 새는 것을 막는다 (#P001-REQ8).
 *
 * YAML 에 평문으로 두지 않아도, `${env.*}` 가 치환된 뒤의 값을 그대로 출력하면
 * Jenkins 콘솔 로그에 그대로 남는다. 출력 직전에 가린다.
 */

const MASK = '***(masked)';

/** 원본 YAML 값에 `${env.*}` 참조가 있던 키 이름을 모은다. */
function collectSecretKeys(...sources) {
  const keys = new Set();
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'string' && value.includes('${env.')) {
        keys.add(key);
      }
    }
  }
  return keys;
}

/** 로그용 사본을 만든다. 원본 컨텍스트는 건드리지 않는다. */
function maskVariables(variables, secretKeys) {
  const printable = {};
  for (const [key, value] of Object.entries(variables || {})) {
    printable[key] = secretKeys.has(key) ? MASK : value;
  }
  return printable;
}

/** URL 에 박힌 자격증명(user:password@host)을 가린다. */
function maskUrlCredentials(url) {
  if (typeof url !== 'string') return url;
  return url.replace(/(\/\/)([^/@\s]+):([^/@\s]*)@/g, `$1$2:${MASK}@`);
}

module.exports = { MASK, collectSecretKeys, maskVariables, maskUrlCredentials };
