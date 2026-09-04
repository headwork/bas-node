const BaseStage = require('./BaseStage');
const IisControlStage = require('./IisControlStage');
const FsRenameStage = require('./FsRenameStage');
const { applyRetention, stampNow } = require('../backupRetention');
const { decideConfigSource, formatDecision } = require('../configPreserve');
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
    const siteName =
      this.engine.context.variables.iis_site || stageConfig.iis_site || path.basename(deployPath);
    const siteSource =
      (this.engine.context.variables.iis_site || stageConfig.iis_site) ? '명시' : 'web_deploy_path 에서 유추';
    // 백업은 `backup_root` 에 모은다. 지정하지 않으면 예전처럼 라이브 옆에 만든다.
    //
    // ⚠️ backup_root 는 **라이브와 같은 볼륨**이어야 한다. rename 이 즉시 끝나는 것은
    //    같은 볼륨 안에서뿐이고, 다른 볼륨이면 690MB 복사가 IIS 정지 구간에 들어간다.
    const backupRoot = this.engine.context.variables.backup_root || stageConfig.backup_root || null;
    const backupName = `${path.basename(deployPath)}_backup_${stampNow()}`;
    if (backupRoot && !fs.existsSync(backupRoot)) {
      fs.mkdirSync(backupRoot, { recursive: true });
      console.log(`[LocalDeployMacroStage] 백업 폴더를 만들었습니다: ${backupRoot}`);
    }
    const backupPath = backupRoot ? path.join(backupRoot, backupName) : `${deployPath}_backup_${stampNow()}`;
    const tempPath = `${deployPath}_temp_deploy`;

    console.log(`\n[LocalDeployMacroStage] Starting automated local deployment...`);
    console.log(`- IIS Site Name: ${siteName} (${siteSource})`);
    console.log(`- Target Deploy Path: ${deployPath}`);
    console.log(`- Backup Path: ${backupPath}`);

    const iisStage = new IisControlStage(this.engine);
    const renameStage = new FsRenameStage(this.engine);

    try {
      await this.deploy({ iisStage, renameStage, deployPath, buildPath, tempPath, backupPath, backupRoot, siteName, basePath, stageConfig });
    } catch (err) {
      // 스왑 전에 실패하면 temp 사본이 통째로 남는다(수백 MB). 치우고 나간다.
      // 스왑 후라면 tempPath 는 이미 live 로 이름이 바뀌어 존재하지 않으므로 안전하다.
      if (fs.existsSync(tempPath)) {
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

  async deploy({ iisStage, renameStage, deployPath, buildPath, tempPath, backupPath, backupRoot, siteName, basePath, stageConfig }) {
    const manageIis = !(stageConfig && stageConfig.manage_iis === false);
    // 이 서버의 설정 파일. 라이브의 것을 새 배포본으로 옮긴다.
    const preserveConfig = (stageConfig && stageConfig.preserve_config) || this.engine.context.preserveConfig || [];
    const configBackup = (stageConfig && stageConfig.config_backup) || this.engine.context.variables.config_backup || null;
    // 운영 중 생성되어 배포 뒤에도 유지해야 하는 항목 (폴더·파일 모두 가능)
    const preserve = (stageConfig && stageConfig.preserve) || this.engine.context.preserve || [];

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
    if (preserveConfig.length > 0) {
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

    // 2. Stop IIS
    //    manage_iis: false 로 두면 IIS 제어를 건너뛴다. IIS 가 아닌 대상이거나
    //    파일 교체만 확인하려는 경우에 쓴다. 기본값은 제어함(true)이다 —
    //    서비스를 세우지 않고 파일을 갈아치우는 것이 기본값이어서는 안 된다.
    if (manageIis) {
      console.log(`[LocalDeployMacroStage] Step 2: Stopping IIS Service`);
      await iisStage.execute({ action: 'stop', site: siteName }, basePath);
    } else {
      console.log(`[LocalDeployMacroStage] Step 2: IIS 제어 건너뜀 (manage_iis: false)`);
    }

    // 3. Rename existing live to backup
    console.log(`[LocalDeployMacroStage] Step 3: Backing up live directory`);
    await renameStage.execute({ src: deployPath, dest: backupPath }, basePath);

    // 여기서부터 라이브가 비어 있다. 이 지점을 지난 실패만 롤백 대상이다.
    // 백업이 실제로 생겼는지 확인하고 무장한다 — 되돌릴 대상이 없는데 무장하면
    // 롤백이 라이브를 _failed_ 로 밀어내고 복구는 못 하는 최악이 된다.
    if (fs.existsSync(backupPath)) {
      // 이력에 남긴다. 롤백은 폴더를 훑는 대신 이 경로를 읽는다.
      this.engine.context.variables.backup_path = backupPath;
      this.engine.armRollback(`백업 생성됨: ${path.basename(backupPath)}`);
    } else {
      console.error(`[LocalDeployMacroStage] 경고: 백업 경로가 없습니다 (${backupPath}). 롤백을 무장하지 않습니다.`);
    }

    // 3.5 운영 중 생성된 항목을 새 배포본으로 가져온다 (EDMS · Temp · 운영 web.config 등)
    //
    //   서버를 내린 뒤에 한다. 서비스가 살아 있으면 파일이 쓰이는 중이라 사본이 깨진다.
    //   스왑 전에 temp 로 옮겨 놓으므로 라이브는 이름 변경 한 번으로 완성된다.
    //   config_dir(Step 1.5)로 넣은 파일과 겹치면 이쪽이 이긴다 — 운영본이 우선이다.
    if (preserve.length > 0) {
      console.log(`[LocalDeployMacroStage] Step 3.5: Preserving ${preserve.length} item(s) from previous deployment`);
      const startedAt = Date.now();

      for (const name of preserve) {
        const from = path.join(backupPath, name);
        const to = path.join(tempPath, name);

        if (!fs.existsSync(from)) {
          // 최초 배포에는 없는 것이 정상이다. 실패시키지 않되 조용히 넘기지도 않는다.
          console.log(`  [preserve] ${name} - 이전 배포본에 없음 (건너뜀)`);
          continue;
        }

        const stat = fs.statSync(from);
        if (stat.isDirectory()) {
          fs.cpSync(from, to, { recursive: true, force: true });
          const count = countFiles(to);
          console.log(`  [preserve] ${name}/ (${count}개 파일)`);
        } else {
          fs.copyFileSync(from, to);
          console.log(`  [preserve] ${name} (${stat.size}B)`);
        }
      }

      console.log(`  보존 소요 ${((Date.now() - startedAt) / 1000).toFixed(1)}초`);
    }

    // 4. Rename temp to live
    console.log(`[LocalDeployMacroStage] Step 4: Swapping temp to live`);
    await renameStage.execute({ src: tempPath, dest: deployPath }, basePath);

    // 5. Start IIS
    if (manageIis) {
      console.log(`[LocalDeployMacroStage] Step 5: Starting IIS Service`);
      await iisStage.execute({ action: 'start', site: siteName }, basePath);
    } else {
      console.log(`[LocalDeployMacroStage] Step 5: IIS 제어 건너뜀 (manage_iis: false)`);
    }

    // 6. 백업 보관 정책 적용 (#P001-OQ2)
    //    정리 실패는 배포 성공을 뒤집지 않는다 — 로그만 남기고 넘어간다.
    console.log(`[LocalDeployMacroStage] Step 6: Applying backup retention policy`);
    try {
      const retentionConfig = {
        ...(this.engine.context.backup || {}),
        ...(stageConfig && stageConfig.backup ? stageConfig.backup : {})
      };
      applyRetention(deployPath, retentionConfig, console, backupRoot);
    } catch (err) {
      console.error(`[LocalDeployMacroStage] Backup retention failed (deployment is unaffected): ${err.message}`);
    }

    console.log(`[LocalDeployMacroStage] Automated deployment completed successfully.`);
  }
}

function countFiles(dir) {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countFiles(path.join(dir, entry.name));
    else count++;
  }
  return count;
}

module.exports = LocalDeployMacroStage;
