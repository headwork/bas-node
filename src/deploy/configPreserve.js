/**
 * 서버 설정 보전 규칙. 로컬·원격이 같은 판단을 쓰도록 여기 한 곳에 둔다
 * (백업 보관 정책과 같은 방식 — 목록만 받아 오고 판단은 순수 함수가 한다).
 *
 * 규칙은 하나다.
 *
 *   config 백업의 파일이 **라이브의 파일보다 최근이면** 그쪽이 이긴다.
 *   그 외에는 라이브가 이긴다. 같은 시각은 "최근" 이 아니므로 라이브다.
 *
 * 예외는 없다. 다른 PC 에서 복사해 온 파일은 수정시각이 과거라 안 들어가는데,
 * 그것은 오류가 아니라 규칙이다. 넣으려면 서버에서 손대서 시각을 올린다.
 *
 * ⚠️ 배포는 설정 파일의 수정시각을 **절대 건드리지 않는다.** 복사하면서 배포 시각을
 *    찍으면 라이브가 언제나 최신이 되어, 개발자가 미리 올려둔 파일이 영영 못 이긴다.
 *    Windows 의 copy · copyFileSync 는 원본 시각을 그대로 물려준다(실측).
 *    그래서 이 파일들의 '수정한 날짜' 는 **설정이 마지막으로 바뀐 때**를 뜻한다.
 */

/**
 * 어느 쪽을 배포본에 넣을지 고른다.
 *
 * @param liveMs   라이브 파일의 수정시각(epoch ms). 없으면 null
 * @param configMs config 백업 파일의 수정시각(epoch ms). 없으면 null
 * @returns {'live'|'config'|'missing'}
 */
function decideConfigSource(liveMs, configMs) {
  if (liveMs === null && configMs === null) return 'missing';
  if (liveMs === null) return 'config';
  if (configMs === null) return 'live';
  return configMs > liveMs ? 'config' : 'live';
}

/**
 * 판정을 한 줄로 남긴다. 반영이 안 될 때 원인이 여기서 바로 보인다 —
 * 두 시각을 나란히 찍으므로 "내가 올린 파일이 더 오래됐구나" 가 즉시 읽힌다.
 */
function formatDecision(name, liveMs, configMs, winner) {
  const at = (ms) => {
    if (ms === null) return '없음';
    const d = new Date(ms);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
      `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const verdict = winner === 'config' ? 'config 우선' : '라이브 유지';
  return `${name}  라이브 ${at(liveMs)} / config ${at(configMs)}  -> ${verdict}`;
}

/** .NET 의 LastWriteTime.Ticks(0001-01-01 기준 100ns)를 epoch ms 로 옮긴다. */
const TICKS_AT_EPOCH = 621355968000000000n;
function ticksToEpochMs(raw) {
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return null;
  const ticks = BigInt(text);
  if (ticks <= 0n) return null;
  // Ticks 는 6.4e17 이라 Number 로 받으면 정밀도가 깨진다. BigInt 로 나눈 뒤 옮긴다.
  return Number((ticks - TICKS_AT_EPOCH) / 10000n);
}

module.exports = { decideConfigSource, formatDecision, ticksToEpochMs };
