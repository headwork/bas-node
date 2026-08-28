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
const CSharpBuildStage = require('./stages/CSharpBuildStage');
const LocalDeployMacroStage = require('./stages/LocalDeployMacroStage');
const LocalRollbackMacroStage = require('./stages/LocalRollbackMacroStage');
const OtherServerStage = require('./stages/OtherServerStage');
const ConfluenceStage = require('./stages/ConfluenceStage');

class PipelineEngine {
  constructor(initialParams = {}) {
    this.initialParams = initialParams;
    this.context = {
      variables: {},
      environment: initialParams.environment || 'dev',
      backup: {}, // YAML 루트의 backup: 블록 (백업 보관 정책)
      preserve: [] // YAML 루트의 preserve: 블록 (운영 중 생성 항목 보존)
    };
    
    // 레지스트리에 Stage 핸들러 매핑 (확장성)
    this.stageHandlers = {
      'sync': new CommandStage(this),
      'build': new CommandStage(this),
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
      'c#_build': new CSharpBuildStage(this),
      'local_deploy': new LocalDeployMacroStage(this),
      'local_rollback': new LocalRollbackMacroStage(this),
      'other_server': new OtherServerStage(this),
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

  async run(yamlPath, overrideParams = {}, options = {}) {
    console.log(`[Pipeline] Starting pipeline from ${yamlPath}...`);
    const doc = this.loadYaml(yamlPath);

    // 1. 환경 결정. 외부 파라미터가 YAML 보다 우선한다 (D01.04)
    this.context.environment =
      overrideParams.environment || this.initialParams.environment || doc.environment || this.context.environment;

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

    // 4. target[environment] 프로파일을 평평하게 펼쳐 덮어쓴다.
    //    base 를 기준으로 먼저 치환해야 `deploy_path: "${deploy_path}/MFM.SHORE_QA"` 처럼
    //    루트값을 참조하는 항목이 자기 자신을 가리키는 재귀가 되지 않는다.
    let targetVars = {};
    const targetDef = doc.target ? doc.target[this.context.environment] : null;
    if (targetDef && typeof targetDef === 'object') {
      targetVars = this.interpolateObject(targetDef, baseVars);
      console.log(`[Pipeline] Applied target profile: '${this.context.environment}'`);
    } else if (doc.target) {
      // 프로파일이 안 잡히면 스테이지들이 빈 변수로 돌기 시작한다. 조용히 넘기지 않는다.
      throw new Error(
        `Target profile '${this.context.environment}' not found in YAML. ` +
        `Available: ${Object.keys(doc.target).join(', ')}`
      );
    }

    // 5. 최종 병합 — 외부 파라미터가 끝까지 최우선이다.
    this.context.variables = {
      ...baseVars,
      ...targetVars,
      ...overrideParams,
      environment: this.context.environment
    };
    for (let i = 0; i < 3; i++) {
      this.context.variables = this.interpolateObject(this.context.variables);
    }

    // 백업 보관 정책도 변수 치환을 거친다 (YAML 에서 ${...} 로 쓸 수 있게)
    this.context.backup = this.interpolateObject(doc.backup || {});
    // 운영 중 생성되어 배포 뒤에도 유지해야 하는 항목 (EDMS · Temp · 운영 web.config 등)
    this.context.preserve = this.interpolateObject(doc.preserve || []);

    // 치환이 끝난 값을 그대로 찍으면 ${env.*} 로 감춘 의미가 없다 (#P001-REQ8)
    const secretKeys = collectSecretKeys(rootVars, doc.variables, targetDef);
    console.log(`[Pipeline] Merged Context Variables:`, maskVariables(this.context.variables, secretKeys));

    const basePath = path.dirname(yamlPath);

    if (options.dryRun) {
      this.printPlan(doc, secretKeys);
      return;
    }

    try {
      if (doc.stages && Array.isArray(doc.stages)) {
        for (const stage of doc.stages) {
          await this.executeStage(stage, basePath);
        }
      }
      console.log(`[Pipeline] Pipeline finished successfully.`);
    } catch (err) {
      console.error(`\n[Pipeline Error] Pipeline failed: ${err.message}`);
      await this.executeRollback(doc, basePath);
      throw err;
    }
  }

  /**
   * 실행하지 않고 계획만 보여준다 (--dry-run).
   * 사람이 눈으로 확인하는 용도이므로, 무엇이 어떤 값으로 해석됐는지와
   * 등록되지 않은 스테이지가 있는지를 드러내는 것이 목적이다.
   */
  printPlan(doc, secretKeys) {
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

    if (Array.isArray(doc.stages)) describe(doc.stages, '실행 계획');
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
  async executeRollback(doc, basePath) {
    if (!doc.rollback) {
      console.log(`[Rollback] No rollback configuration found. Skipping rollback.`);
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
