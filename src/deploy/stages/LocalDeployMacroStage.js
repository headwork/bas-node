const BaseStage = require('./BaseStage');
const { stampNow, orgName, preserveName, backupDirFor } = require('../backupRetention');
const { resolveDeployMode } = require('../deployMode');
const { decideConfigSource, formatDecision } = require('../configPreserve');
const { deployReason } = require('../scriptExit');
const { preserveScriptArgs } = require('../scriptArgs');
const { classifyPreserve, allNames } = require('../preserveClassify');
const { assertScript, defaultScriptDir } = require('../scriptSync');
const { reportLockHolders } = require('../lockDiag');
const path = require('path');
const fs = require('fs');

/** 없으면 null. 판정 함수가 '없음' 과 '옛날' 을 가르는 기준이다. */
function mtimeOf(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

class LocalDeployMacroStage extends BaseStage {
  async execute(stageConfig, basePath) {
    // 라이브 폴더는 `web_deploy_path` 다 — IIS 가 바라보는 그 경로. 로컬이든 원격이든 같다.
    //
    // 예전에는 이 자리에서 `deploy_path` 를 읽었는데, 그 이름은 yaml 루트에서
    // **배포 폴더들의 루트**(D:/Deploy)라는 다른 뜻으로도 쓰였다. 서버 블록에서 값을
    // 빠뜨리면 루트값이 그대로 흘러들어와 D:/Deploy 통째를 라이브 폴더로 보는데,
    // 경로가 실재하고 형태가 멀쩡해 **에러가 나지 않는다.** 이름을 갈라 그 길을 끊었다.
    const deployPath = this.engine.context.variables.web_deploy_path || stageConfig.web_deploy_path;
    const buildPath = this.engine.context.variables.build_path || stageConfig.build_path;

    if (!deployPath || !buildPath) {
      throw new Error("LocalDeployMacroStage requires 'web_deploy_path' and 'build_path'.");
    }

    // IIS 사이트 이름. 명시값이 우선이고, 없으면 web_deploy_path 의 마지막 폴더명으로 유추한다.
    //
    // 유추는 "폴더명 = 사이트명 = 앱풀명" 이라는 관행에 기대고 있다. 그 관행이 깨지면
    // 없는 사이트를 찾다 실패하거나 — 더 나쁘게 — 같은 이름의 다른 사이트를 멈춘다.
    // 배포 경로만 바꾸고 IIS 는 그대로 두는 경우가 실제로 있으므로 명시 경로를 연다.
    const vars = this.engine.context.variables;
    const named = vars.web_server_name || stageConfig.web_server_name || vars.iis_site || stageConfig.iis_site;
    const siteName = named || path.basename(deployPath);
    const siteSource = named ? '명시' : 'web_deploy_path 에서 유추';

    // 웹서버 종류. 없으면 iis 로 본다 — 지금까지 이 도구가 다룬 것이 IIS 뿐이라
    // 기존 YAML 이 수정 없이 그대로 돌아야 한다 (#P002-REQ5).
    const wsType = vars.web_server_type || stageConfig.web_server_type || 'iis';
    // 공용 스크립트 자리. tool_home 은 PipelineEngine 이 주입한다.
    const scriptDir = vars.script_dir || stageConfig.script_dir || defaultScriptDir(vars);
    // 백업은 `backup_root` 에 모은다. 지정하지 않으면 예전처럼 라이브 옆에 만든다.
    //
    // ⚠️ backup_root 는 **라이브와 같은 볼륨**이어야 한다. rename 이 즉시 끝나는 것은
    //    같은 볼륨 안에서뿐이고, 다른 볼륨이면 690MB 복사가 IIS 정지 구간에 들어간다.
    // 원격과 같은 규칙 — `backup_root` 밑에 **웹서버 이름으로 한 겹** 판다 (#P003).
    const configuredRoot = this.engine.context.variables.backup_root || stageConfig.backup_root || null;
    const backupRoot = configuredRoot ? backupDirFor(configuredRoot, siteName) : null;
    if (backupRoot && !fs.existsSync(backupRoot)) {
      fs.mkdirSync(backupRoot, { recursive: true });
      console.log(`[LocalDeployMacroStage] 백업 폴더를 만들었습니다: ${backupRoot}`);
    }
    const tempPath = `${deployPath}_temp_deploy`;

    console.log(`\n[LocalDeployMacroStage] Starting automated local deployment...`);
    console.log(`- Web Server: ${siteName} (${siteSource}, type=${wsType})`);
    console.log(`- Target Deploy Path: ${deployPath}`);

    try {
      await this.deploy({
        deployPath, buildPath, tempPath, backupRoot,
        siteName, wsType, scriptDir, basePath, stageConfig
      });
    } catch (err) {
      // 스왑 전에 실패하면 temp 사본이 통째로 남는다(수백 MB). 치우고 나간다.
      // 스왑 후라면 tempPath 는 이미 live 로 이름이 바뀌어 존재하지 않으므로 안전하다.
      //
      // ⚠️ 종료코드 5(라이브 없음)일 때는 **아무것도 치우지 않는다.** 사람이 손으로
      //    고쳐야 하는 자리이고, 그 사람이 볼 것을 치워 버리면 안 된다.
      if (!err.keepEvidence && fs.existsSync(tempPath)) {
        console.log(`[LocalDeployMacroStage] 실패 - 임시 배포본 정리: ${tempPath}`);
        try {
          fs.rmSync(tempPath, { recursive: true, force: true });
        } catch (cleanupErr) {
          console.error(`[LocalDeployMacroStage] 임시 배포본 정리 실패(수동 삭제 필요): ${cleanupErr.message}`);
        }
      }
      throw err;
    }
  }

  async deploy({ deployPath, buildPath, tempPath, backupRoot, siteName, wsType, scriptDir, basePath, stageConfig }) {
    const manageIis = !(stageConfig && stageConfig.manage_iis === false);
    const vars = this.engine.context.variables;

    // 배포 방식. 원격과 **같은 함수**를 쓴다 (deployMode.js) — 규칙을 두 번 적지 않는다.
    const { mode } = resolveDeployMode({
      override: vars.deploy_mode_override, stageConfig, vars
    });

    // 분류된 preserve. 옛 형식도 여기서 같은 모양이 된다 (#P003-REQ2).
    const kinds = this.engine.context.preserveKinds
      || classifyPreserve(this.engine.context.preserve, this.engine.context.preserveConfig);
    const preserveConfig = kinds.config;
    const carryNames = [...kinds.temp, ...kinds.data];
    const backupNames = allNames(kinds);
    const configBackup = (stageConfig && stageConfig.config_backup) || vars.config_backup || null;

    const stamp = stampNow();
    const orgPath = path.join(path.dirname(deployPath), orgName(deployPath, stamp));
    const preserveBackup = path.join(backupRoot || path.dirname(deployPath), preserveName(deployPath, stamp));
    // 어댑터가 해석하는 값. deploy.bat 은 모르고 그대로 상속시킨다 (IIS 의 앱풀 등).
    const wsPool = this.engine.context.variables.web_server_pool
      || (stageConfig && stageConfig.web_server_pool);

    // 1. Copy build output to temp path (to avoid blocking the rename later)
    console.log(`[LocalDeployMacroStage] Step 1: Copying build artifacts to temp directory`);
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { recursive: true, force: true });
    // Assuming build output is in a subfolder or directly in buildPath. We'll copy the whole thing.
    fs.cpSync(buildPath, tempPath, { recursive: true });

    // 1.5 서버 설정 보전 (기존 wesys_restart_sub.bat 의 config/<env> 복원과 같은 역할)
    //
    //   서비스가 아직 살아 있는 동안 끝낸다. 설정 파일은 런타임에 아무도 쓰지 않으므로
    //   지금 떠도 안전하고, 정지 구간에는 이름 바꾸기 두 번만 남는다.
    //
    //   기존 bat 은 xcopy 병합이라 라이브의 appsettings.json 이 저절로 살아남았지만,
    //   여기는 폴더를 통째로 스왑하므로 옮겨 주지 않으면 사라진다.
    //   어느 쪽을 쓸지는 configPreserve 가 정한다 — 규칙은 그 파일에 적혀 있다.
    // copy 모드는 라이브를 그대로 두므로 설정이 사라지지 않는다. 산출물의 설정이
    // 라이브를 덮지 않게 하는 것이 전부이고, 그것은 `DP_EXCLUDE` 가 한다.
    if (mode === 'swap' && preserveConfig.length > 0) {
      console.log(`[LocalDeployMacroStage] Step 1.5: 서버 설정 보전 (${preserveConfig.length}건)`);
      if (configBackup) fs.mkdirSync(configBackup, { recursive: true });

      for (const name of preserveConfig) {
        const livePath = path.join(deployPath, name);
        const backupCopy = configBackup ? path.join(configBackup, name) : null;
        const liveMs = mtimeOf(livePath);
        const backupMs = backupCopy ? mtimeOf(backupCopy) : null;

        const winner = decideConfigSource(liveMs, backupMs);
        if (winner === 'missing') {
          // 산출물에서는 exclude 로 지웠고 여기에도 없다 = 설정 없는 배포본이 된다.
          // 라이브를 건드리기 전에 멈춘다.
          throw new Error(
            `설정 파일이 어디에도 없습니다: ${name}\n` +
            `  라이브: ${livePath}\n` +
            `  백업  : ${backupCopy || '(config_backup 미설정)'}`
          );
        }

        console.log(`  [config] ${formatDecision(name, liveMs, backupMs, winner)}`);
        // 복사는 수정시각을 보존한다. 여기서 시각을 찍으면 위 판정이 죽는다.
        fs.copyFileSync(winner === 'config' ? backupCopy : livePath, path.join(tempPath, name));

        // 라이브가 이겼으면 사본을 갱신해 둔다. config 가 이겼으면 이미 최신이다.
        if (winner === 'live' && backupCopy) fs.copyFileSync(livePath, backupCopy);
      }

      // 실제로 배포본에 들어갔는지 확인한다. 없으면 설정 없는 폴더가 라이브가 된다.
      for (const name of preserveConfig) {
        if (!fs.existsSync(path.join(tempPath, name))) {
          throw new Error(`설정 파일이 배포본에 없습니다: ${name} (${tempPath})`);
        }
      }
    }

    // 1.7 유지파일 백업 + 벌크 이월. **정지 전이다** (#P003-REQ2b).
    //     무거운 쪽을 서비스가 살아 있는 동안 끝내고, 그 사이 늘어난 것만 스왑 뒤에 따라잡는다.
    if (backupNames.length > 0) {
      console.log(`[LocalDeployMacroStage] Step 1.7: 유지파일 백업 (${backupNames.length}건) -> ${preserveBackup}`);
      fs.mkdirSync(preserveBackup, { recursive: true });
      for (const name of backupNames) {
        const from = path.join(deployPath, name);
        if (!fs.existsSync(from)) continue;    // 첫 배포에는 없다. 오류가 아니다.
        fs.cpSync(from, path.join(preserveBackup, name), { recursive: true });
      }

      if (mode === 'swap' && carryNames.length > 0) {
        console.log(`[LocalDeployMacroStage] Step 1.8: 벌크 이월 (${carryNames.length}건) -> 임시폴더`);
        for (const name of carryNames) {
          const from = path.join(preserveBackup, name);
          if (!fs.existsSync(from)) continue;
          fs.cpSync(from, path.join(tempPath, name), { recursive: true });
        }
      }
    }

    // 2. 정지 → 백업 → preserve → 스왑 → 시작. **스크립트 한 번이다** (#P002-TASK7).
    //
    //    예전에는 이 자리가 Node 코드 다섯 토막이었다. 원격은 그것이 ssh 왕복 다섯 번이라
    //    라이브가 비는 구간이 벌어지는 문제가 있었고, 로컬은 그 문제가 없다 —
    //    **그래서 로컬만 남겨 두면 스왑 순서가 두 곳에 살게 된다.**
    //    한쪽만 고쳐지는 날이 오고, 그것이 이 과제가 없애려는 바로 그 병이다.
    //
    //    로컬에서만 다른 것 둘:
    //      · 경로를 따옴표로 감싼다 — 로컬에는 공백 든 경로가 실제로 있다
    //      · 값을 `set` 체인이 아니라 **자식 프로세스 환경변수**로 넘긴다.
    //        그래서 공백 제약이 없다 (원격은 ssh 인용 때문에 못 쓴다)
    const script = path.join(scriptDir, 'deploy.bat');
    assertScript(script, scriptDir);

    console.log(`[LocalDeployMacroStage] Step 2: 정지 -> ${mode === 'swap' ? '스왑 -> 델타' : '복사'} -> 시작 (deploy.bat)`);
    console.log(`  mode   ${mode}`);
    console.log(`  live   ${deployPath}`);
    console.log(`  staged ${tempPath}`);
    if (mode === 'swap') console.log(`  org    ${orgPath}`);

    // 계약에 있는 키는 **하나도 빠짐없이 적는다.** 빈 값은 Windows 에서 변수 삭제다 —
    // 빠뜨리면 부모 프로세스(젠킨스)에 같은 이름이 있을 때 그 값이 그대로 흘러든다.
    // `WS_SKIP` 하나가 새어 들어오면 웹서버를 세우지 않고 폴더만 갈아치운다.
    const scriptLists = preserveScriptArgs(kinds);
    const r = this.engine.runCommand(`"${script}"`, basePath, {
      capture: true,
      allowFailure: true,
      env: {
        DP_MODE: mode,
        DP_LIVE: deployPath,
        DP_STAGED: tempPath,
        // 스왑으로 밀려난 옛 라이브가 갈 자리. 확정(헬스체크 통과) 때까지 산다.
        DP_ORG: mode === 'swap' ? orgPath : '',
        // 벌크는 이미 정지 전에 갔다. 스크립트는 그 사이 늘어난 것만 따라잡는다.
        DP_DELTA: mode === 'swap' ? (scriptLists.DP_DELTA || '') : '',
        DP_EXCLUDE: mode === 'copy' ? (scriptLists.DP_EXCLUDE || '') : '',
        WS_SKIP: manageIis ? '' : '1',
        WS_TYPE: manageIis ? wsType : '',
        WS_NAME: manageIis ? siteName : '',
        WS_POOL: (manageIis && wsPool) ? wsPool : ''
      }
    });

    const out = (r.output || '').trim();
    if (out) out.split(/\r?\n/).forEach(line => console.log(`  ${line}`));

    // 무장 여부는 종료코드가 정한다. 원격과 **같은 표**를 쓴다 (scriptExit.js).
    // 예전에는 백업 폴더가 생겼는지 `fs.existsSync` 로 확인했는데, 이제 그 중간 지점을
    // Node 가 보지 못한다 — 대신 스크립트가 코드로 말해 준다.
    const KNOWN = [0, 1, 2, 3, 4, 5];
    if (r.code === 0 || r.code === 5 || !KNOWN.includes(r.code)) {
      // 이력에 남긴다. 롤백은 폴더를 훑는 대신 이 값들을 읽는다.
      vars.deploy_mode_used = mode;
      if (mode === 'swap') vars.org_path = orgPath;
      vars.preserve_backup = preserveBackup;
      this.engine.armRollback(
        mode === 'swap'
          ? `옛 라이브: ${path.basename(orgPath)} (deploy.bat 종료코드 ${r.code})`
          : `직전 확정 빌드로 되돌릴 수 있습니다 (deploy.bat 종료코드 ${r.code})`);
    }

    if (r.code !== 0) {
      const why = deployReason(r.code, mode);
      console.error(`\n[LocalDeployMacroStage] 배포 실패 - ${siteName}`);
      console.error(`  사유     : ${why}`);
      console.error(`  종료코드 : ${r.code}`);
      // 폴더를 옮기지 못한 실패(`1`)는 대개 누가 잡고 있어서다. 누구인지 묻는다 (#P003-TASK2).
      if (r.code === 1) {
        reportLockHolders((cmd, opts) => this.engine.runCommand(cmd, basePath, opts), deployPath);
      }
      const err = new Error(`로컬 배포 실패: ${why} (종료코드 ${r.code})`);
      if (r.code === 5 && mode === 'swap') {
        console.error(`  ⚠️ 라이브 폴더가 없습니다. 직접 실행하십시오:`);
        console.error(`     move "${orgPath}" "${deployPath}"`);
        // 사람이 볼 것을 치우지 않는다 (바깥 catch 가 읽는다)
        err.keepEvidence = true;
      }
      if (r.code === 5 && mode === 'copy') {
        console.error(`  ⚠️ 라이브가 섞였습니다. 직전 확정 빌드로 되돌려야 합니다.`);
        err.keepEvidence = true;
      }
      throw err;
    }

    // 웹서버를 내렸다 올렸다. health_check 가 이 값을 보고 돈다 (manage_iis:false 면 안 건드렸다).
    vars.server_restarted = manageIis;

    // 확정 단계가 읽을 값들. **여기서 지우거나 이름을 바꾸지 않는다** —
    // 정리는 헬스체크 뒤에 `confirm` 이 한다 (#P003-REQ9). 그 전까지는 이것들이 복구 수단이다.
    vars.staged_path = tempPath;
    vars.release_source = vars.archive_path || '';
    vars.release_stamp = stamp;
    // 확정·롤백이 **다시 구하지 않게** 넘긴다 (원격과 같은 이유).
    vars.backup_dir = backupRoot || path.dirname(deployPath);

    console.log(`[LocalDeployMacroStage] 배포 완료. 확정은 헬스체크 뒤에 합니다 (confirm).`);
  }
}

module.exports = LocalDeployMacroStage;
