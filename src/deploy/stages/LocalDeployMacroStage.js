const BaseStage = require('./BaseStage');
const IisControlStage = require('./IisControlStage');
const FsRenameStage = require('./FsRenameStage');
const { applyRetention } = require('../backupRetention');
const path = require('path');
const fs = require('fs');

class LocalDeployMacroStage extends BaseStage {
  async execute(stageConfig, basePath) {
    const deployPath = this.engine.context.variables.deploy_path || stageConfig.deploy_path;
    const buildPath = this.engine.context.variables.build_path || stageConfig.build_path;

    if (!deployPath || !buildPath) {
      throw new Error("LocalDeployMacroStage requires 'deploy_path' and 'build_path'.");
    }

    // IIS 사이트 이름 자동 유추: deploy_path의 마지막 디렉터리 이름
    const siteName = path.basename(deployPath);
    const backupPath = `${deployPath}_backup_${Date.now()}`;
    const tempPath = `${deployPath}_temp_deploy`;

    console.log(`\n[LocalDeployMacroStage] Starting automated local deployment...`);
    console.log(`- IIS Site Name: ${siteName}`);
    console.log(`- Target Deploy Path: ${deployPath}`);

    const iisStage = new IisControlStage(this.engine);
    const renameStage = new FsRenameStage(this.engine);

    try {
      await this.deploy({ iisStage, renameStage, deployPath, buildPath, tempPath, backupPath, siteName, basePath, stageConfig });
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

  async deploy({ iisStage, renameStage, deployPath, buildPath, tempPath, backupPath, siteName, basePath, stageConfig }) {
    const manageIis = !(stageConfig && stageConfig.manage_iis === false);
    // 서버 고유 설정 보관 위치. 지정하지 않으면 덮어쓰기를 하지 않는다.
    const configDir = (stageConfig && stageConfig.config_dir) || this.engine.context.variables.config_dir || null;
    // 운영 중 생성되어 배포 뒤에도 유지해야 하는 항목 (폴더·파일 모두 가능)
    const preserve = (stageConfig && stageConfig.preserve) || this.engine.context.preserve || [];

    // 1. Copy build output to temp path (to avoid blocking the rename later)
    console.log(`[LocalDeployMacroStage] Step 1: Copying build artifacts to temp directory`);
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { recursive: true, force: true });
    // Assuming build output is in a subfolder or directly in buildPath. We'll copy the whole thing.
    fs.cpSync(buildPath, tempPath, { recursive: true });

    // 1.5 서버 고유 설정 덮어쓰기 (기존 wesys_restart_sub.bat 의 config/<env> 복원과 같은 역할)
    //
    //   서비스가 아직 살아 있는 동안 끝낸다. 정지 구간에는 이름 바꾸기 두 번만 남기기 위함이다.
    //   기존 bat 은 xcopy 병합이라 라이브의 appsettings.json 이 저절로 살아남았지만,
    //   여기는 폴더를 통째로 스왑하므로 그냥 두면 publish 기본값이 서버 설정을 덮어쓴다.
    if (configDir) {
      console.log(`[LocalDeployMacroStage] Step 1.5: Applying server-specific config from ${configDir}`);

      if (!fs.existsSync(configDir)) {
        // 조용히 건너뛰면 잘못된 설정으로 서비스가 뜬다. 배포 자체를 실패시킨다.
        throw new Error(`Config directory not found: ${configDir}`);
      }

      const files = fs.readdirSync(configDir, { withFileTypes: true }).filter(e => e.isFile());
      if (files.length === 0) {
        throw new Error(`Config directory is empty: ${configDir}`);
      }

      // 설정 파일의 수정시각을 배포 시각으로 찍는다.
      //
      //   탐색기의 기본 열이 '수정한 날짜'(mtime)라, 원본 시각이 그대로 남으면
      //   배포 직후 확인할 때 몇 년 전 날짜가 보여 "복사가 안 됐다"로 읽힌다.
      //   배포 시점에 사람이 묻는 것은 "이번 배포로 반영됐나"이므로 그 답이
      //   기본 열에 있어야 한다. 설정이 실제로 마지막에 바뀐 시각은 백업 폴더가
      //   그대로 들고 있다 — 라이브는 복사가 아니라 rename 으로 백업이 되기 때문이다.
      //
      //   ⚠️ utimesSync 를 빼면 안 된다. copyFileSync 는 Windows 에서 CopyFileEx 를 쓰므로
      //   원본의 수정시각을 그대로 물려준다(측정 확인). 복사만으로는 시각이 갱신되지 않는다.
      const stampedAt = new Date();

      for (const entry of files) {
        const dest = path.join(tempPath, entry.name);
        fs.copyFileSync(path.join(configDir, entry.name), dest);
        fs.utimesSync(dest, stampedAt, stampedAt);
        console.log(`  [config] ${entry.name}`);
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
      applyRetention(deployPath, retentionConfig);
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
