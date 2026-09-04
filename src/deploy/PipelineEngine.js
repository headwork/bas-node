const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const child_process = require('child_process');
const CommandStage = require('./stages/CommandStage');
const ChainStage = require('./stages/ChainStage');
const ExtractStage = require('./stages/ExtractStage');
const IisControlStage = require('./stages/IisControlStage');
const FsRenameStage = require('./stages/FsRenameStage');
const SyncStaticStage = require('./stages/SyncStaticStage');
const HealthCheckStage = require('./stages/HealthCheckStage');
const BackupCleanupStage = require('./stages/BackupCleanupStage');
const ArchiveStage = require('./stages/ArchiveStage');
const { collectSecretKeys, maskVariables, maskUrlCredentials } = require('./maskSecrets');

// Macro Stages
const GitSyncStage = require('./stages/GitSyncStage');
const BuildStage = require('./stages/BuildStage');
const LocalDeployMacroStage = require('./stages/LocalDeployMacroStage');
const LocalRollbackMacroStage = require('./stages/LocalRollbackMacroStage');
const OtherServerStage = require('./stages/OtherServerStage');
const RemoteDeployMacroStage = require('./stages/RemoteDeployMacroStage');
const RemoteRollbackMacroStage = require('./stages/RemoteRollbackMacroStage');
const ConfluenceStage = require('./stages/ConfluenceStage');

class PipelineEngine {
  constructor(initialParams = {}) {
    this.initialParams = initialParams;
    this.context = {
      variables: {},
      // 기본 환경을 정하지 않는다. 'dev' 같은 이름을 코드가 들고 있으면
      // yaml 이 환경을 빠뜨렸을 때 **에러 없이** 그 환경으로 배포된다.
      environment: initialParams.environment || null,
      backup: {}, // YAML 루트의 backup: 블록 (백업 보관 정책)
      preserve: [], // YAML 루트의 preserve: 블록 (운영 중 생성 항목 보존)
      preserveConfig: [], // YAML 루트의 preserve_config: 블록 (서버 설정 보전)
      exclude: [], // YAML 루트의 exclude: 블록 (빌드 산출물에서 제외)
      // 라이브 폴더를 실제로 치웠는가. 이게 false 면 롤백하지 않는다 — 되돌릴 것이 없다.
      rollbackArmed: false
    };
    
    // 레지스트리에 Stage 핸들러 매핑 (확장성)
    this.stageHandlers = {
      'sync': new CommandStage(this),
      'upload': new CommandStage(this),
      'chain_call': new ChainStage(this),
      'extract': new ExtractStage(this),
      'iis_control': new IisControlStage(this),
      'fs_rename': new FsRenameStage(this),
      'sync_static': new SyncStaticStage(this),
      'health_check': new HealthCheckStage(this),
      'backup_cleanup': new BackupCleanupStage(this),
      'archive': new ArchiveStage(this),
      // Macros
      'git_sync': new GitSyncStage(this),
      // 언어를 이름에 박지 않는다. 무엇으로 짓는지는 build_cmd 가 정한다 —
      // java·python 이 들어와도 스테이지 이름은 그대로다.
      'build': new BuildStage(this),
      'local_deploy': new LocalDeployMacroStage(this),
      'local_rollback': new LocalRollbackMacroStage(this),
      'other_server': new OtherServerStage(this),
      'remote_deploy': new RemoteDeployMacroStage(this),
      'remote_rollback': new RemoteRollbackMacroStage(this),
      'confluence': new ConfluenceStage(this)
    };
  }

  // YAML 파일 읽기 및 파싱
  loadYaml(filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`YAML file not found: ${filePath}`);
    }
    const fileContent = fs.readFileSync(filePath, 'utf8');
    return yaml.load(fileContent);
  }

  // 문자열 내의 변수 치환 (${env.VAR}, ${VAR})
  interpolate(str, localVars = {}) {
    if (typeof str !== 'string') return str;

    const mergedVars = { ...this.context.variables, ...localVars };
    
    let result = str.replace(/\$\{env\.([a-zA-Z0-9_]+)\}/g, (match, p1) => {
      return process.env[p1] || '';
    });

    result = result.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (match, p1) => {
      if (p1.startsWith('env.')) return match;
      return mergedVars[p1] !== undefined ? mergedVars[p1] : match;
    });

    return result;
  }

  // 객체 내의 문자열(Value)을 재귀적으로 순회하며 변수 치환
  interpolateObject(obj, localVars = {}) {
    if (typeof obj === 'string') {
      return this.interpolate(obj, localVars);
    } else if (Array.isArray(obj)) {
      return obj.map(item => this.interpolateObject(item, localVars));
    } else if (obj !== null && typeof obj === 'object') {
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.interpolateObject(value, localVars);
      }
      return result;
    }
    return obj;
  }

  /**
   * target 이 가리키는 서버 블록(build_server · deploy_server)을 풀어 변수로 만든다.
   *
   * 참조는 두 가지로 쓸 수 있다.
   *
   *   build_server: *local_server   YAML 앵커. **없는 이름이면 파서가 죽인다**
   *   build_server: "local"         루트 카탈로그에서 이름으로 찾는다
   *
   * 앵커 쪽이 안전하다 — 오타가 조용히 빈 값으로 넘어가지 않고 파싱 단계에서 걸린다.
   * 이름 방식은 여기서 직접 막는다. 못 찾은 채 진행하면 source_path 가 비고,
   * GitSyncStage 가 산출물 폴더를 소스로 착각한다.
   *
   * ⚠️ 별칭(`*name`)은 복사가 아니라 **같은 객체**다 (js-yaml 실측).
   *    interpolateObject 가 새 객체를 만들어 돌려주므로 원본이 오염되지 않는다.
   *    그 성질에 기대고 있으니 여기에 제자리 수정을 넣지 말 것.
   */
  resolveServer(doc, section, targetDef, scope) {
    const ref = targetDef[section];
    if (ref === undefined || ref === null) return {};

    // 카탈로그는 `server_list` 하나다 — 서버는 서버일 뿐이고,
    // 빌드용이냐 배포용이냐는 target 이 어느 자리에 꽂느냐로 정해진다.
    const catalogs = [doc.server_list].filter(c => c && typeof c === 'object');
    let def = null;
    let name = null;

    if (typeof ref === 'string') {
      const hit = catalogs.find(c => c[ref]);
      if (!hit) {
        const available = catalogs.flatMap(c => Object.keys(c));
        throw new Error(
          `${section}: '${ref}' 를 찾을 수 없습니다 (target.${this.context.environment} 가 참조). ` +
          `사용 가능: ${available.length ? available.join(', ') : '(카탈로그 없음)'}`
        );
      }
      def = hit[ref];
      name = ref;
    } else if (typeof ref === 'object' && !Array.isArray(ref)) {
      def = ref;
      // 앵커로 받으면 이름이 없다. 별칭은 동일 참조이므로 카탈로그와 === 로 되찾는다.
      for (const c of catalogs) {
        name = Object.keys(c).find(k => c[k] === ref) || name;
        if (name) break;
      }
    } else {
      throw new Error(
        `${section} 은 이름(문자열)이거나 서버 블록(객체)이어야 합니다: ${JSON.stringify(ref)}`
      );
    }

    let flat = this.interpolateObject(this.expandMergeKeys(def), scope);

    // ssh: { host, port } 처럼 묶어 적은 접속 정보를 평평하게 편다.
    // 스테이지는 host·port 라는 이름으로 읽는다(RemoteDeployMacroStage 의 cfg('host')).
    // 중첩인 채로 두면 값이 있는데도 못 찾아 "필요한 값이 없습니다" 로 멈춘다.
    if (flat.ssh && typeof flat.ssh === 'object' && !Array.isArray(flat.ssh)) {
      const { ssh, ...rest } = flat;
      flat = { ...ssh, ...rest };   // 바깥에 직접 적은 값이 이긴다
    }

    console.log(`[Pipeline] ${section}: ${name ? `'${name}'` : '(인라인)'}`);
    return flat;
  }

  /**
   * `<<:` (머지키)를 손으로 펼친다.
   *
   * 이 파서는 머지키를 해석하지 않고 `"<<"` 를 **리터럴 키로 남긴다**(실측).
   * 그대로 두면 `prod: { <<: *qa_server, ... }` 가 upload_path·ssh 를 못 받는데
   * **에러가 나지 않는다** — 원격 배포가 값이 빈 채로 시작한다.
   *
   * YAML 스펙과 같은 뜻으로 편다 — **명시한 키가 병합된 키를 이긴다.**
   * `<<: [*a, *b]` 형태도 받는다(앞선 것이 이긴다).
   */
  expandMergeKeys(obj, depth = 0) {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return obj;
    if (depth > 10) return obj;   // 별칭이 서로를 가리켜도 여기서 멈춘다

    const merged = {};
    const raw = obj['<<'];
    if (raw !== undefined) {
      for (const src of (Array.isArray(raw) ? raw : [raw])) {
        const raised = this.expandMergeKeys(src, depth + 1);
        if (!raised || typeof raised !== 'object') continue;
        for (const [k, v] of Object.entries(raised)) {
          if (!(k in merged)) merged[k] = v;
        }
      }
    }

    const out = { ...merged };
    for (const [k, v] of Object.entries(obj)) {
      if (k === '<<') continue;
      out[k] = this.expandMergeKeys(v, depth + 1);
    }
    return out;
  }

  /**
   * 배포 갈래를 정하는 플래그를 확정한다.
   *
   * **환경 이름(dev·qa·prod)을 보지 않는다.** 코드가 이름을 알면 환경이 하나 늘 때마다
   * 코드를 고쳐야 하고, 이름만 바꾼 target 이 조용히 다른 길로 간다.
   * 판단 근거는 yaml 에 적힌 설정값뿐이다.
   *
   *   deploy_remote  생략 시 true(원격). 빠뜨린 설정이 라이브를 갈아치우는 것보다
   *                  host 가 없어 멈추는 편이 옳다.
   *   compress       생략 시 true(압축). 원격 배포는 zip 하나로 보내므로 끌 수 없다.
   *
   * 값을 `deployVars` 에 확정해 둔다. target 에 직접 적은 값은 병합 순서상 어차피
   * 마지막에 다시 이기므로, 여기서 정하는 것은 **적지 않았을 때의 값**이다.
   */
  applyDeployFlags(targetDef, buildVars, deployVars) {
    const pick = (key, fallback) => {
      if (targetDef[key] !== undefined) return targetDef[key];
      if (deployVars[key] !== undefined) return deployVars[key];
      return fallback;
    };

    const deployRemote = pick('deploy_remote', true);
    if (targetDef.deploy_remote === undefined && deployVars.deploy_remote === undefined) {
      console.log(`[Pipeline] deploy_remote 미지정 - 기본값 true(원격 배포)로 봅니다`);
    }

    const compress = pick('compress', true);
    if (deployRemote && compress === false) {
      // 원격 배포는 zip 을 scp 로 올려 원격에서 푼다. 압축을 끄면 올릴 것이 없는데,
      // remote_deploy 가 시작한 뒤에야 그것을 알게 된다. 시작 전에 멈춘다.
      throw new Error(
        `compress: false 는 원격 배포와 함께 쓸 수 없습니다 (target.${this.context.environment}).\n` +
        `  원격 배포는 배포본을 zip 하나로 보냅니다. 압축을 끄려면 deploy_remote: false 여야 합니다.`
      );
    }

    // 로컬 배포인데 빌드서버와 배포서버가 다른 블록이면 알린다.
    // 막지는 않는다 — 원격접속 없이 이 서버의 그 경로로 배포되긴 한다.
    // 다만 그 조합은 대개 오타이고, 경로가 실재하면 **에러 없이** 엉뚱한 폴더를 갈아치운다.
    if (!deployRemote && buildVars.server_name && deployVars.server_name &&
        buildVars.server_name !== deployVars.server_name) {
      console.log(
        `[Pipeline] 경고: 로컬 배포(deploy_remote:false)인데 빌드서버와 배포서버가 다릅니다 - ` +
        `build='${buildVars.server_name}' deploy='${deployVars.server_name}'`
      );
      console.log(`[Pipeline]   이 서버의 파일시스템에 '${deployVars.web_deploy_path}' 로 배포됩니다.`);
    }

    deployVars.deploy_remote = deployRemote;
    deployVars.compress = compress;
  }

  async run(yamlPath, overrideParams = {}, options = {}) {
    console.log(`[Pipeline] Starting pipeline from ${yamlPath}...`);
    const doc = this.loadYaml(yamlPath);
    const { secretKeys } = this.prepareContext(doc, overrideParams, options);
    return this.#runStages(doc, yamlPath, secretKeys, options);
  }

  /**
   * 롤백만 단독으로 실행한다 (`--rollback=N`). 젠킨스 롤백 잡이 부르는 자리다.
   *
   * 파이프라인 실패로 도는 롤백과 다른 점은 둘이다.
   *   - 무장(arm) 검사를 하지 않는다. 이번 프로세스는 아무것도 배포하지 않았으니
   *     그 값은 언제나 거짓이다. 여기서는 **백업이 실제로 있는가**로 판단한다.
   *   - 백업을 소비하지 않는다. 복사해서 되돌리므로 몇 번이든 다시 부를 수 있다.
   */
  async runRollback(yamlPath, overrideParams = {}, options = {}) {
    const doc = this.loadYaml(yamlPath);
    this.prepareContext(doc, overrideParams, options);

    if (!doc.rollback) {
      throw new Error(`이 YAML 에는 rollback 정의가 없습니다: ${yamlPath}`);
    }

    const lastDeploy = Number(options.lastDeploy || 0);
    if (!(lastDeploy > 0)) {
      throw new Error(`--rollback 에는 1 이상의 번호가 필요합니다 (1 = 직전 성공 배포).`);
    }
    this.context.variables.last_deploy = lastDeploy;

    console.log(`\n[Rollback] 강제 롤백 - 환경 ${this.context.environment}, lastDeploy=${lastDeploy}`);

    if (options.dryRun) {
      // 어느 백업으로 갈지만 보여준다. 젠킨스 잡에서 확인용으로 쓴다.
      this.#printRollbackPlan();
      return { dryRun: true };
    }

    const basePath = path.dirname(yamlPath);
    const stages = Array.isArray(doc.rollback) ? doc.rollback : (doc.rollback.stages || []);
    for (const stage of stages) {
      await this.executeStage(stage, basePath);
    }
    return { rolledBack: true };
  }

  /** 강제 롤백 대상 후보를 출력한다 (--rollback --dry-run). */
  #printRollbackPlan() {
    const state = this.deployState;
    if (!state) {
      console.log(`[Rollback] 배포 이력을 읽을 수 없습니다 (설정 폴더 없음).`);
      return;
    }
    const candidates = state.rollbackCandidates(this.context.environment);
    console.log(`\n[Rollback] 되돌릴 수 있는 배포 (${candidates.length}건)`);
    candidates.forEach((run, i) => {
      const backup = run.variables.backup_path;
      // 원격 배포의 백업은 저쪽 디스크에 있다. 여기서 fs 로 보면 언제나 "없음" 이라
      // 멀쩡한 백업을 지워진 것으로 보고하게 된다. 원격은 판정하지 않는다 —
      // 실제 존재 확인은 롤백이 ssh `if exist` 로 하고, 없으면 그때 멈춘다.
      const remote = run.variables.deploy_remote === true;
      const note = remote
        ? '   (원격 - 실행 시 확인)'
        : (fs.existsSync(backup) ? '' : '   <-- 폴더 없음(사람이 지움)');
      console.log(`  ${i + 1}. ${path.basename(backup)}${note}`);
      console.log(`     키 ${run.key} / 커밋 ${(run.variables.git_to || '').slice(0, 8) || '-'}` +
        ` / ${run.finished_at || run.started_at}`);
    });
    if (candidates.length === 0) {
      console.log(`  (없음) 백업이 남아 있는 성공 배포가 있어야 합니다.`);
    }
  }

  /**
   * YAML 을 읽어 컨텍스트 변수를 세운다. 배포와 롤백이 같은 값을 봐야 하므로 공용이다.
   */
  prepareContext(doc, overrideParams = {}, options = {}) {
    // 스테이지가 이력을 읽을 수 있게 둔다 (롤백이 백업 경로를 여기서 찾는다).
    this.deployState = options.state || this.deployState || null;

    // 1. 환경 결정. 외부 파라미터가 YAML 보다 우선한다 (D01.04)
    this.context.environment =
      overrideParams.environment || this.initialParams.environment || doc.environment || this.context.environment;

    if (!this.context.environment) {
      // 임의로 고르지 않는다. 어느 target 으로 배포할지가 정해지지 않은 것이다.
      throw new Error(
        `environment 가 정해지지 않았습니다. YAML 의 environment 키를 적거나 ` +
        `--params={"environment":"<이름>"} 로 넘기십시오.` +
        (doc.target ? `\n  정의된 target: ${Object.keys(doc.target).join(', ')}` : '')
      );
    }

    // 2. 루트의 단순 설정값(git_url, deploy_path, name 등)을 변수로 올린다.
    //    구조 키와 객체/배열은 변수가 아니므로 제외한다.
    const STRUCTURAL_KEYS = ['stages', 'target', 'variables', 'rollback', 'backup'];
    const rootVars = {};
    for (const [key, value] of Object.entries(doc)) {
      if (STRUCTURAL_KEYS.includes(key)) continue;
      if (value !== null && typeof value === 'object') continue;
      rootVars[key] = value;
    }

    // 3. 기본 컨텍스트 조립. 자기 참조 및 다중 계층 해석을 위해 3회 반복 치환
    let baseVars = {
      ...rootVars,
      ...(doc.variables || {}),
      ...overrideParams,
      environment: this.context.environment
    };
    for (let i = 0; i < 3; i++) {
      baseVars = this.interpolateObject(baseVars);
    }

    // 4. 서버 프로파일 -> target 순으로 깐다.
    //
    //    축이 둘이다. **어디서 빌드하나**(git 체크아웃·산출물 루트·게시 프로파일)와
    //    **어디에 배포하나**(라이브 폴더·IIS·원격 접속)는 서로 독립이다.
    //    같은 빌드서버가 만든 산출물이 dev·qa·prod 로 갈려 나간다.
    //    target 은 그 둘을 잇는 조합표다.
    //
    //    base 를 기준으로 먼저 치환해야 `web_deploy_path: "${deploy_root}/MFM.SHORE_QA"` 처럼
    //    루트값을 참조하는 항목이 제대로 풀린다.
    let targetVars = {};
    const targetDef = doc.target ? doc.target[this.context.environment] : null;
    if (doc.target && (!targetDef || typeof targetDef !== 'object')) {
      // 프로파일이 안 잡히면 스테이지들이 빈 변수로 돌기 시작한다. 조용히 넘기지 않는다.
      throw new Error(
        `Target profile '${this.context.environment}' not found in YAML. ` +
        `Available: ${Object.keys(doc.target).join(', ')}`
      );
    }

    // 축은 둘이고, 둘 다 target 이 명시한다. 엔진은 승계·추론을 하지 않는다 —
    // 어디에 배포하는지는 `deploy_server` 가, 원격인지는 `deploy_remote` 가 정한다.
    const buildVars = targetDef ? this.resolveServer(doc, 'build_server', targetDef, baseVars) : {};
    const deployVars = targetDef
      ? this.resolveServer(doc, 'deploy_server', targetDef, { ...baseVars, ...buildVars })
      : {};

    if (targetDef) {
      this.applyDeployFlags(targetDef, buildVars, deployVars);
      targetVars = this.interpolateObject(targetDef, { ...baseVars, ...buildVars, ...deployVars });
      // 참조 자체는 변수가 아니다. 객체인 채로 올라가면 ${...} 치환 대상으로 보인다.
      delete targetVars.build_server;
      delete targetVars.deploy_server;
      console.log(`[Pipeline] Applied target profile: '${this.context.environment}'`);
    }

    // 배포 대상 서버의 기술(host·경로·IIS)이 곧 이것이다. 스테이지가 참조한다.
    this.context.serverInfo = Object.keys(deployVars).length > 0 ? deployVars : null;

    // 5. 최종 병합 — 외부 파라미터가 끝까지 최우선이다.
    this.context.variables = {
      ...baseVars,
      ...buildVars,
      ...deployVars,
      ...targetVars,      // target 에 직접 적은 값이 서버 블록을 이긴다 (머지키 대용)
      ...overrideParams,
      environment: this.context.environment
    };
    for (let i = 0; i < 3; i++) {
      this.context.variables = this.interpolateObject(this.context.variables);
    }

    // 백업 보관 정책도 변수 치환을 거친다 (YAML 에서 ${...} 로 쓸 수 있게)
    this.context.backup = this.interpolateObject(doc.backup || {});
    // 운영 중 생성되어 배포 뒤에도 유지해야 하는 항목 (EDMS · Temp 등)
    this.context.preserve = this.interpolateObject(doc.preserve || []);
    // 서버 설정 파일. 위 preserve 와 시점이 다르다 — IIS 정지 전에, 라이브에서 가져온다.
    this.context.preserveConfig = this.interpolateObject(doc.preserve_config || []);
    // 빌드 산출물에서 지울 것. 소스의 설정 파일이 서버까지 가지 않게 한다.
    this.context.exclude = this.interpolateObject(doc.exclude || []);

    // 치환이 끝난 값을 그대로 찍으면 ${env.*} 로 감춘 의미가 없다 (#P001-REQ8)
    const secretKeys = collectSecretKeys(rootVars, doc.variables, targetDef);
    console.log(`[Pipeline] Merged Context Variables:`, maskVariables(this.context.variables, secretKeys));

    return { secretKeys, targetDef };
  }

  async #runStages(doc, yamlPath, secretKeys, options) {
    const basePath = path.dirname(yamlPath);
    const allStages = Array.isArray(doc.stages) ? doc.stages : [];

    // 그룹 선택 (--only). 젠킨스가 단계별로 나눠 부를 때 쓴다.
    const plan = this.selectStages(allStages, options.only);

    if (options.only) {
      console.log(`[Pipeline] 그룹 '${options.only}' 만 실행합니다 (${plan.selected.length}/${allStages.length}단계)`);
      if (plan.ungrouped.length > 0) {
        // group 이 없는 스테이지는 --only 로는 영영 실행되지 않는다. 조용히 빠지면 안 된다.
        console.log(`[Pipeline] 경고: group 이 없어 실행되지 않는 스테이지 - ${plan.ungrouped.join(', ')}`);
      }
    }

    if (options.dryRun) {
      this.printPlan(doc, secretKeys, plan);
      return;
    }

    const state = options.state || null;
    const key = options.deployKey || null;

    // 이전 단계의 판정을 이어받는다. 없으면 changed_static_only 가 undefined 가 되어
    // `unless:` 가 통과하고 전체 빌드가 도는데, 에러가 나지 않아 아무도 모른다.
    if (state && key) {
      const prior = state.find(key);

      if (options.only && plan.firstGroup && options.only !== plan.firstGroup && !prior) {
        throw new Error(
          `이어받을 상태가 없습니다 (key=${key}, group=${options.only}).\n` +
          `  첫 그룹은 '${plan.firstGroup}' 입니다. 앞 단계가 실행되지 않았거나 --deploy-key 가 다릅니다.`
        );
      }

      const { run, resumed } = state.begin({
        key, yamlPath, environment: this.context.environment, project: doc.project
      });
      if (resumed && run.variables) {
        Object.assign(this.context.variables, run.variables);
        const names = Object.keys(run.variables);
        if (names.length) console.log(`[state] 이전 단계에서 이월: ${names.join(', ')}`);
      }
    }

    const groupLabel = options.only || '(전체)';
    const startedAt = Date.now();

    try {
      for (const stage of plan.selected) {
        if (state && key && state.isCancelRequested(key)) {
          // 스테이지 경계에서만 멈춘다. 진행 중인 압축을 중간에 끊지는 못한다.
          console.log(`\n[Pipeline] 취소 요청이 확인되어 중단합니다 (key=${key})`);
          if (state) {
            state.recordGroup(key, groupLabel, {
              status: 'cancelled', elapsedMs: Date.now() - startedAt, variables: this.context.variables
            });
            state.finish(key, 'cancelled');
          }
          return { cancelled: true };
        }
        await this.executeStage(stage, basePath);
      }

      if (state && key) {
        state.recordGroup(key, groupLabel, {
          status: 'success',
          elapsedMs: Date.now() - startedAt,
          variables: this.context.variables,
          changedFiles: this.context.changedFiles,
          changedCommits: this.context.changedCommits,
          revertedCommits: this.context.revertedCommits
        });
        // 마지막 그룹까지 끝났을 때만 실행 자체를 종료 처리한다.
        if (!options.only || options.only === plan.lastGroup) state.finish(key, 'success');
      }

      console.log(`[Pipeline] Pipeline finished successfully.`);
      return { cancelled: false };
    } catch (err) {
      console.error(`\n[Pipeline Error] Pipeline failed: ${err.message}`);
      if (state && key) {
        state.recordGroup(key, groupLabel, {
          status: 'failed', error: err.message,
          elapsedMs: Date.now() - startedAt, variables: this.context.variables
        });
        state.finish(key, 'failed', err.message);
      }
      await this.executeRollback(doc, basePath);
      throw err;
    }
  }

  /**
   * 스테이지를 그룹으로 가른다.
   *   - only 가 없으면 전부 실행한다 (기존 동작 그대로)
   *   - only 가 있으면 그 group 만 골라 YAML 순서대로 실행한다
   */
  selectStages(stages, only) {
    const groupOf = s => {
      const name = Object.keys(s)[0];
      const cfg = s[name];
      return (cfg && typeof cfg === 'object' && cfg.group) ? String(cfg.group) : null;
    };

    const groups = [];
    const ungrouped = [];
    for (const s of stages) {
      const g = groupOf(s);
      if (g) { if (!groups.includes(g)) groups.push(g); }
      else ungrouped.push(Object.keys(s)[0]);
    }

    const firstGroup = groups[0] || null;
    const lastGroup = groups[groups.length - 1] || null;

    if (!only) return { selected: stages, groups, firstGroup, lastGroup, ungrouped };

    if (!groups.includes(only)) {
      // 오타를 조용히 "0단계 실행"으로 넘기면 성공으로 보인다.
      throw new Error(
        `'${only}' 그룹이 YAML 에 없습니다. 정의된 그룹: ${groups.length ? groups.join(', ') : '(없음)'}`
      );
    }

    return { selected: stages.filter(s => groupOf(s) === only), groups, firstGroup, lastGroup, ungrouped };
  }

  /**
   * 실행하지 않고 계획만 보여준다 (--dry-run).
   * 사람이 눈으로 확인하는 용도이므로, 무엇이 어떤 값으로 해석됐는지와
   * 등록되지 않은 스테이지가 있는지를 드러내는 것이 목적이다.
   */
  printPlan(doc, secretKeys, plan = null) {
    const line = '='.repeat(70);
    console.log(`\n${line}`);
    console.log(`  DRY RUN - 실행하지 않습니다`);
    console.log(line);

    console.log(`\n[환경] ${this.context.environment}`);

    console.log(`\n[해석된 변수]`);
    const printable = maskVariables(this.context.variables, secretKeys);
    const width = Math.max(...Object.keys(printable).map(k => k.length));
    for (const [key, value] of Object.entries(printable)) {
      console.log(`  ${key.padEnd(width)} = ${value}`);
    }

    if (this.context.preserve.length > 0) {
      console.log(`\n[운영 중 생성 항목 보존] IIS 정지 후 이전 배포본에서 가져온다`);
      for (const name of this.context.preserve) {
        console.log(`  ${name}`);
      }
    }

    if (Object.keys(this.context.backup).length > 0) {
      console.log(`\n[백업 보관 정책]`);
      for (const [key, value] of Object.entries(this.context.backup)) {
        console.log(`  ${key} = ${value}`);
      }
    }

    const unknown = [];
    const describe = (list, label) => {
      console.log(`\n[${label}] ${list.length}단계`);
      list.forEach((stageDef, index) => {
        const stage = this.interpolateObject(stageDef);
        const stageName = Object.keys(stage)[0];
        const stageConfig = stage[stageName];
        const known = !!this.stageHandlers[stageName] ||
          (stageConfig && typeof stageConfig === 'object' && stageConfig.chain);
        if (!known) unknown.push(stageName);

        let cond = '';
        if (stageConfig && typeof stageConfig === 'object') {
          if (stageConfig.if !== undefined) cond = `   [조건] ${stageConfig.if} 이 참일 때만`;
          else if (stageConfig.unless !== undefined) cond = `   [조건] ${stageConfig.unless} 이 참이면 건너뜀`;
        }
        console.log(`\n  ${index + 1}. ${stageName}${known ? '' : '   <-- 등록되지 않은 스테이지'}${cond}`);
        if (stageConfig && typeof stageConfig === 'object') {
          for (const [key, value] of Object.entries(stageConfig)) {
            console.log(`       ${key}: ${value}`);
          }
        } else if (stageConfig !== undefined && stageConfig !== null && stageConfig !== '') {
          console.log(`       ${stageConfig}`);
        }
      });
    };

    if (plan && plan.groups.length > 0) {
      console.log(`\n[그룹] ${plan.groups.join(' -> ')}`);
      if (plan.ungrouped.length > 0) {
        console.log(`  group 없음(--only 로는 실행되지 않음): ${plan.ungrouped.join(', ')}`);
      }
    }

    if (plan && plan.selected) describe(plan.selected, '실행 계획');
    else if (Array.isArray(doc.stages)) describe(doc.stages, '실행 계획');
    if (Array.isArray(doc.rollback)) describe(doc.rollback, '실패 시 롤백');
    else if (doc.rollback) console.log(`\n[실패 시 롤백] 명령형 정의 있음`);
    else console.log(`\n[실패 시 롤백] 없음 - 실패해도 되돌리지 않는다`);

    console.log(`\n${line}`);
    if (unknown.length > 0) {
      console.log(`  경고: 등록되지 않은 스테이지 ${unknown.length}개 - ${unknown.join(', ')}`);
      console.log(`  실행하면 명령 문자열로 취급되어 실패합니다.`);
    } else {
      console.log(`  모든 스테이지가 등록되어 있습니다.`);
    }
    console.log(`${line}\n`);
  }

  /** 컨텍스트 변수를 참/거짓으로 읽는다. 문자열 'false' · '0' · 빈 문자열은 거짓이다. */
  isTruthy(name) {
    const value = this.context.variables[name];
    if (value === undefined || value === null) return false;
    if (typeof value === 'boolean') return value;
    const s = String(value).trim().toLowerCase();
    return s !== '' && s !== 'false' && s !== '0';
  }

  /** 건너뛸 사유를 돌려준다. 실행해야 하면 null. */
  shouldSkip(stageName, stageConfig) {
    if (stageConfig.if !== undefined && !this.isTruthy(stageConfig.if)) {
      return `조건 '${stageConfig.if}' 이 거짓`;
    }
    if (stageConfig.unless !== undefined && this.isTruthy(stageConfig.unless)) {
      return `조건 '${stageConfig.unless}' 이 참`;
    }
    return null;
  }

  async executeStage(stageDef, basePath) {
    const stage = this.interpolateObject(stageDef);
    const stageName = Object.keys(stage)[0];
    const stageConfig = stage[stageName];
    
    // 조건부 실행. 컨텍스트 변수 이름을 받아 참/거짓으로 판정한다.
    //   if:     그 값이 참일 때만 실행
    //   unless: 그 값이 참이면 건너뜀
    if (stageConfig && typeof stageConfig === 'object') {
      const skip = this.shouldSkip(stageName, stageConfig);
      if (skip) {
        console.log(`\n--- [Stage: ${stageName}] 건너뜀 - ${skip} ---`);
        return;
      }
      delete stageConfig.if;
      delete stageConfig.unless;
      delete stageConfig.group;   // 실행 선택용 메타. 스테이지 설정이 아니다.
    }

    console.log(`\n--- [Stage: ${stageName}] ---`);

    // 체인 속성이 있으면 기본적으로 ChainStage 처리
    if (stageConfig && typeof stageConfig === 'object' && stageConfig.chain) {
      const chainStage = new ChainStage(this);
      await chainStage.execute(stageConfig, basePath);
      return;
    }

    const handler = this.stageHandlers[stageName];
    if (handler) {
      await handler.execute(stageConfig, basePath);
    } else {
      console.log(`[Warning] No specific handler for '${stageName}', treating as command.`);
      const cmdHandler = new CommandStage(this);
      await cmdHandler.execute(stageConfig, basePath);
    }
  }

  /**
   * 롤백 정의는 세 가지 형태를 받는다.
   *   1) 스테이지 목록  rollback: [ - local_rollback: {} ]  (또는 rollback: { stages: [...] })
   *   2) 원격 스크립트  rollback: { script_dir: "...", rollback_cmd: "..." }
   *   3) 단일 명령      rollback: "restore.bat"
   */
  /**
   * 롤백을 무장한다. **라이브 폴더를 실제로 치운 직후에만** 부른다.
   *
   * @param {string} reason  무엇을 되돌릴 수 있는지 (로그용)
   */
  armRollback(reason) {
    if (this.context.rollbackArmed) return;
    this.context.rollbackArmed = true;
    this.context.variables.rollback_armed = true;   // 그룹을 나눠 실행해도 이월되도록
    console.log(`[Rollback] 무장됨 - ${reason}`);
  }

  async executeRollback(doc, basePath) {
    if (!doc.rollback) {
      console.log(`[Rollback] No rollback configuration found. Skipping rollback.`);
      return;
    }

    // 배포가 라이브를 건드리기 전에 실패했으면 되돌릴 것이 없다.
    //
    // 예전에는 파이프라인이 어디서 죽든 롤백이 돌았다. 그래서 `c#_build` 가 솔루션을
    // 못 찾아 죽은 것만으로 멀쩡한 라이브 폴더를 _failed_ 로 밀어내고 백업을 끌어다 썼다
    // (2026-08-28 젠킨스 빌드 #1·#2). 백업 두 개가 그렇게 소진됐고, 그 다음 실패는
    // 되돌릴 백업이 없어 라이브가 사라진 채로 끝났을 것이다.
    //
    // 무장은 `local_deploy`·`remote_deploy` 가 라이브를 백업으로 옮긴 **직후**에만 한다.
    // 그 시점 이전의 실패는 라이브가 그대로이므로 손대지 않는 것이 옳다.
    const armed = this.context.rollbackArmed || this.context.variables.rollback_armed === true;
    if (!armed) {
      console.log(`\n[Rollback] 건너뜁니다 - 배포가 라이브 폴더를 건드리기 전에 실패했습니다.`);
      console.log(`[Rollback]   되돌릴 것이 없습니다. 백업은 그대로 보존됩니다.`);
      return;
    }

    console.log(`\n--- [Rollback Stage Initiated] ---`);
    const rollbackDef = this.interpolateObject(doc.rollback);

    try {
      if (typeof rollbackDef === 'string') {
        console.log(`[Rollback] Executing rollback command: ${rollbackDef}`);
        this.runCommand(rollbackDef);
      } else if (Array.isArray(rollbackDef) || Array.isArray(rollbackDef.stages)) {
        const stages = Array.isArray(rollbackDef) ? rollbackDef : rollbackDef.stages;
        console.log(`[Rollback] Executing ${stages.length} rollback stage(s)`);
        for (const stage of stages) {
          await this.executeStage(stage, basePath);
        }
      } else if (rollbackDef.script_dir && rollbackDef.rollback_cmd) {
        console.log(`[Rollback] Executing rollback_cmd in ${rollbackDef.script_dir}`);
        this.runCommand(rollbackDef.rollback_cmd, rollbackDef.script_dir);
      } else {
        // 정의는 있는데 어느 형태에도 맞지 않는다. 조용히 넘어가면 롤백이 없는 것과 같다.
        console.error(`[Rollback] CRITICAL: Unrecognized rollback definition. Nothing was executed.`);
        console.error(`[Rollback] Expected a stage list, {script_dir, rollback_cmd}, or a command string.`);
        return;
      }
      console.log(`[Rollback] Rollback completed successfully.`);
    } catch (e) {
      // 롤백 실패가 원래 배포 에러를 덮지 않도록 여기서 삼키고 로그만 남긴다.
      console.error(`[Rollback] CRITICAL: Rollback failed! Manual intervention required.`);
      console.error(`[Rollback] Reason: ${e.message}`);
    }
  }

  /**
   * OS 분기 및 쉘 스크립트 실행기.
   *
   * options.capture      : 출력을 화면으로 흘리지 않고 잡아서 돌려준다.
   *                        결과를 코드가 판단해야 하는 명령(appcmd 등)에 쓴다.
   *                        기본값(false)은 stdio:'inherit' 라 사람만 볼 수 있다.
   * options.allowFailure : capture 와 함께 쓴다. 실패해도 던지지 않고
   *                        { code, stdout, stderr, output } 을 돌려준다.
   */
  runCommand(cmd, cwd, options = {}) {
    const execOptions = { shell: true };
    if (options.capture) {
      execOptions.stdio = ['ignore', 'pipe', 'pipe'];
      execOptions.encoding = 'utf8';
    } else {
      execOptions.stdio = 'inherit';
    }
    if (cwd) {
      execOptions.cwd = path.normalize(cwd);
    }

    try {
      const stdout = child_process.execSync(cmd, execOptions);
      if (options.capture) {
        const out = stdout || '';
        return { code: 0, stdout: out, stderr: '', output: out };
      }
      return { code: 0 };
    } catch (e) {
      if (options.capture && options.allowFailure) {
        const stdout = e.stdout || '';
        const stderr = e.stderr || '';
        return {
          code: e.status === undefined ? -1 : e.status,
          stdout, stderr,
          output: `${stdout}${stderr}`
        };
      }
      console.error(`\n======================================================`);
      console.error(`[CRITICAL ERROR] Command Execution Failed`);
      console.error(`======================================================`);
      console.error(`- Command: ${maskUrlCredentials(cmd)}`);
      console.error(`- Directory: ${cwd || 'default'}`);
      console.error(`- Status Code: ${e.status}`);
      if (e.stderr) {
        console.error(`- Error Output:\n${e.stderr.toString()}`);
      } else {
        console.error(`- Message: ${e.message}`);
      }
      console.error(`======================================================\n`);
      throw new Error(`Command Execution Failed: ${cmd}`);
    }
  }
}

module.exports = PipelineEngine;
