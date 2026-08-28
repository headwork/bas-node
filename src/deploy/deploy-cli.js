require('dotenv').config(); // `.env` 파일 로드 지원
const PipelineEngine = require('./PipelineEngine');
const { DeployState, generateKey } = require('./deployState');
const { loadConfig, resolveStatePath } = require('../config');
const yaml = require('js-yaml');
const path = require('path');
const fs = require('fs');

const USAGE = `
사용법: node deploy-cli.js --yaml=<경로> [옵션]

  --yaml=<경로>          파이프라인 정의 (필수)
  --params='{"k":"v"}'   외부 파라미터. cmd 에서는 --params="{\\"k\\":\\"v\\"}"
  --dry-run              실행하지 않고 계획만 출력

  --only=<그룹>          해당 group 의 스테이지만 실행 (젠킨스 단계 분할용)
  --deploy-key=<키>      실행 식별자. 단계를 나눠 부를 때 같은 키를 넘겨야 상태가 이어진다
  --project=<이름>       설정 프로젝트. 생략하면 YAML 의 project 를 쓴다
  --config-dir=<경로>    설정 폴더 직접 지정

  --cancel               해당 키의 실행에 취소를 요청한다 (스테이지 경계에서 멈춘다)
  --unlock               해당 키의 락을 해제한다
  --force-unlock         보유자와 무관하게 락을 해제한다
  --status               현재 락·최근 실행 상태를 출력한다
`;

function parseArgs(argv) {
  const a = {
    yamlFile: null, params: {}, dryRun: false,
    only: null, deployKey: null, project: null, configDir: null,
    cancel: false, unlock: false, forceUnlock: false, status: false
  };

  for (const arg of argv) {
    if (arg.startsWith('--yaml=')) a.yamlFile = arg.slice('--yaml='.length);
    else if (arg.startsWith('--only=')) a.only = arg.slice('--only='.length);
    else if (arg.startsWith('--deploy-key=')) a.deployKey = arg.slice('--deploy-key='.length);
    else if (arg.startsWith('--project=')) a.project = arg.slice('--project='.length);
    else if (arg.startsWith('--config-dir=')) a.configDir = arg.slice('--config-dir='.length);
    else if (arg === '--dry-run') a.dryRun = true;
    else if (arg === '--cancel') a.cancel = true;
    else if (arg === '--unlock') a.unlock = true;
    else if (arg === '--force-unlock') { a.unlock = true; a.forceUnlock = true; }
    else if (arg === '--status') a.status = true;
    else if (arg.startsWith('--params=')) {
      try {
        a.params = JSON.parse(arg.slice('--params='.length));
      } catch (e) {
        console.error(`--params 가 올바른 JSON 이 아닙니다: ${arg.slice('--params='.length)}`);
        console.error(`  cmd 에서는 따옴표를 이스케이프해야 합니다: --params="{\\"environment\\":\\"qa\\"}"`);
        process.exit(1);
      }
    }
  }
  return a;
}

/**
 * 상태·락을 준비한다.
 * 설정 폴더가 없어 실패하면 상태 없이 진행한다 — 기존 호출 방식을 깨지 않기 위함이다.
 * 다만 상태를 전제로 하는 옵션이 쓰였다면 그대로 실패시킨다.
 */
function openState(args, doc, environment) {
  const needsState = !!(args.only || args.deployKey || args.cancel || args.unlock || args.status);

  let config;
  try {
    config = loadConfig({ project: args.project || doc.project, configDir: args.configDir });
  } catch (err) {
    if (needsState) throw err;
    console.log(`[state] 설정을 찾지 못해 상태 기록 없이 진행합니다: ${err.message.split('\n')[0]}`);
    return null;
  }

  const statePath = resolveStatePath(config, args.yamlFile);
  const base = path.basename(statePath, '.json');
  const lockPath = path.join(path.dirname(statePath), `${base}.${environment}.lock`);

  return new DeployState({
    statePath,
    lockPath,
    keep: config.get('deploy.state_keep', 10),
    ttlMinutes: config.get('deploy.lock_ttl_min', 60)
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.yamlFile) {
    console.error(USAGE);
    process.exit(1);
  }

  const yamlPath = path.resolve(process.cwd(), args.yamlFile);
  if (!fs.existsSync(yamlPath)) {
    console.error(`YAML 파일이 없습니다: ${yamlPath}`);
    process.exit(1);
  }

  // 상태 경로를 정하려면 project·environment 가 먼저 필요하다. 엔진과 같은 우선순위를 쓴다.
  const doc = yaml.load(fs.readFileSync(yamlPath, 'utf8')) || {};
  const environment = args.params.environment || doc.environment || 'dev';

  let state;
  try {
    state = openState(args, doc, environment);
  } catch (err) {
    console.error(`[state] ${err.message}`);
    process.exit(1);
  }

  // ---- 상태만 다루는 명령들 (파이프라인을 돌리지 않는다) ----

  if (args.status) {
    const holder = state.readLock();
    console.log(holder ? `[lock] 보유 중: ${JSON.stringify(holder)}` : `[lock] 없음`);
    const runs = state.load().runs.slice(0, 5);
    if (!runs.length) console.log(`[state] 기록 없음`);
    for (const r of runs) {
      console.log(`  ${r.key}  ${r.status.padEnd(9)} ${r.environment}  ${r.started_at}  groups=${Object.keys(r.groups || {}).join(',') || '-'}`);
    }
    return;
  }

  if (args.cancel) {
    if (!args.deployKey) { console.error(`--cancel 에는 --deploy-key 가 필요합니다.`); process.exit(1); }
    const ok = state.requestCancel(args.deployKey);
    console.log(ok
      ? `[state] 취소를 요청했습니다 (key=${args.deployKey}). 진행 중인 스테이지가 끝나면 멈춥니다.`
      : `[state] 해당 키의 실행 기록이 없습니다: ${args.deployKey}`);
    process.exit(ok ? 0 : 1);
  }

  if (args.unlock) {
    try {
      const released = state.releaseLock(args.deployKey, { force: args.forceUnlock });
      console.log(released ? `[lock] 해제했습니다.` : `[lock] 잡혀 있는 락이 없습니다.`);
    } catch (err) {
      console.error(`[lock] ${err.message}`);
      process.exit(1);
    }
    return;
  }

  // ---- 파이프라인 실행 ----

  const deployKey = args.deployKey || (state ? generateKey(environment) : null);
  if (state && !args.deployKey) {
    console.log(`[state] deploy_key 를 생성했습니다: ${deployKey}`);
  }

  let locked = false;
  if (state && !args.dryRun) {
    try {
      const r = state.acquireLock({ key: deployKey, stage: args.only || '(전체)' });
      locked = true;
      if (r.reentered) console.log(`[lock] 같은 키의 락을 이어받습니다 (key=${deployKey})`);
    } catch (err) {
      console.error(`\n[lock] ${err.message}`);
      process.exit(1);
    }
  }

  // Ctrl+C 는 잡을 수 있다. 젠킨스 Abort(강제 종료)는 잡히지 않으므로
  // 그쪽은 post{always} 의 --unlock 과 락 TTL 로 처리한다.
  const onSigint = () => {
    console.log(`\n[Pipeline] 중단 요청(Ctrl+C) - 락을 해제하고 종료합니다.`);
    try { if (locked) state.releaseLock(deployKey, { force: true }); } catch { /* 무시 */ }
    try { if (state) state.finish(deployKey, 'cancelled'); } catch { /* 무시 */ }
    process.exit(130);
  };
  process.on('SIGINT', onSigint);

  try {
    const engine = new PipelineEngine(args.params);
    await engine.run(yamlPath, args.params, {
      dryRun: args.dryRun,
      only: args.only,
      deployKey,
      state
    });

    // 실행이 아직 running 이면 다음 그룹이 남았다는 뜻이라 락을 유지한다.
    if (locked) {
      const run = state.find(deployKey);
      if (!run || run.status !== 'running') {
        state.releaseLock(deployKey, { force: true });
        console.log(`[lock] 해제했습니다 (key=${deployKey})`);
      } else {
        console.log(`[lock] 다음 그룹을 위해 락을 유지합니다 (key=${deployKey})`);
      }
    }
  } catch (err) {
    console.error("Pipeline failed with error:", err.message);
    if (locked) {
      try { state.releaseLock(deployKey, { force: true }); } catch { /* 무시 */ }
    }
    process.exit(1);
  }
}

main();
