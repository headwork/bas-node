/**
 * 배포 방식(copy · swap)을 정하는 **한 곳**. (#P202609_003)
 *
 * 2026-09-23 — 원격·로컬 매크로가 각자 같은 규칙을 적어 두고 있었다. 거기에 로그용으로
 * 세 번째를 더하면 언젠가 갈린다. 갈리면 **로그가 말하는 방식과 실제 방식이 달라지는데,
 * 그것은 에러가 아니라 거짓말이라 아무도 눈치채지 못한다.** 실제로 그 일이 있었다:
 * QA 가 swap 으로 돌고 있었는데 `Merged Context Variables` 에 `deploy_mode` 가 없다는
 * 이유로 copy 라고 읽었다. 그래서 **출처까지 함께** 돌려준다.
 */

const MODES = ['copy', 'swap'];

/**
 * @param {object}  o
 * @param {*}       o.override     `--mode` (vars.deploy_mode_override)
 * @param {object}  o.stageConfig  해당 배포 스테이지의 설정
 * @param {object}  o.vars         컨텍스트 변수
 * @returns {{ mode: 'copy'|'swap', source: string }}
 */
function resolveDeployMode({ override, stageConfig, vars } = {}) {
  const given = (v) => v !== undefined && v !== null && v !== '';

  const found = [
    [override, '--mode'],
    [stageConfig && stageConfig.deploy_mode, 'YAML(스테이지)'],
    [vars && vars.deploy_mode, 'YAML(변수)']
  ].find(([v]) => given(v));

  const [raw, source] = found || ['copy', '기본값'];
  const mode = String(raw).toLowerCase();

  if (!MODES.includes(mode)) {
    // 오타를 기본값으로 흘려보내면 의도하지 않은 방식으로 배포되고 **에러도 안 난다.**
    throw new Error(`deploy_mode 는 copy 또는 swap 이어야 합니다: "${raw}" (출처: ${source})`);
  }
  return { mode, source };
}

/**
 * YAML 의 배포 스테이지 설정을 찾는다 — 엔진이 스테이지를 돌기 **전에** 방식을 알아야
 * 요약 로그에 찍을 수 있는데, 그 값이 스테이지 설정 안에 있기 때문이다.
 *
 * 원격·로컬 중 이번에 돌 쪽을 고른다. 둘 다 있으면 `deploy_remote` 가 가른다 —
 * YAML 이 `if: deploy_remote` / `unless: deploy_remote` 로 가르는 것과 같은 기준이다.
 */
function findDeployStageConfig(stages, remote) {
  const want = remote ? 'remote_deploy' : 'local_deploy';
  const hit = (stages || []).find(s => s && Object.keys(s)[0] === want);
  const cfg = hit ? hit[want] : null;
  return (cfg && typeof cfg === 'object') ? cfg : null;
}

module.exports = { resolveDeployMode, findDeployStageConfig, MODES };
