const BaseStage = require('./BaseStage');
const path = require('path');
const { stampNow, backupName, selectFromNames, selectLeftovers } = require('../backupRetention');
const { decideConfigSource, formatDecision, ticksToEpochMs } = require('../configPreserve');
const { makeSshRunner } = require('../sshRunner');
const { syncRemoteScripts, defaultScriptDir } = require('../scriptSync');
const { DEPLOY, reasonFor } = require('../scriptExit');
const { assertRemotePath } = require('../remoteEnv');
const { joinPreserve } = require('../scriptArgs');

/**
 * 원격 서버 배포 매크로. local_deploy 와 같은 순서를 SSH 너머에서 수행한다.
 *
 *   0. 공용 스크립트 동기화      scp   (#P002-TASK5)
 *   1. 압축파일 업로드           scp -P <port>
 *   2. 원격 임시폴더에 압축해제  ssh tar -xf
 *   3. 정지 → 백업 → 스왑 → 시작 ssh deploy.bat   ← **한 번이다** (#P002-TASK7)
 *   4. 오래된 백업 정리          ssh dir + rmdir
 *
 * **복사가 아니라 rename 이다.** 수천 개 파일을 원격으로 복사하면 오래 걸리고 중간에
 * 끊기면 반쪽짜리 배포본이 서비스된다. rename 은 같은 볼륨에서 사실상 원자적이라
 * 서비스 정지 시간이 초 단위로 끝난다.
 *
 * ## 3단계를 왜 쪼개지 않나 — 덩어리는 스크립트, 판단은 Node (`[D10]`)
 *
 * 두 rename 사이에는 **라이브 폴더가 존재하지 않는다.** 예전에는 그 구간이 ssh 왕복을
 * 사이에 두고 벌어져 있어서, 네트워크가 끊기는 순간이 곧 "라이브 없음" 이 되고 되돌릴
 * 주체가 아무도 없었다. 한 스크립트 안이면 되돌리기까지가 원격에서 끝난다.
 *
 * Node 가 계속 쥐는 것은 **판단**이다 — 무엇을 올릴지, 해제 결과가 비었는지,
 * 설정 파일 중 어느 쪽이 최신인지, 어떤 백업을 지울지, 그리고 **되돌릴 수 있는 상태인지**.
 *
 * ⚠️ 원격 명령은 ssh "..." 안에 통째로 들어간다. 경로에 공백이 있으면 따옴표 중첩으로
 *    깨진다. 공백 없는 경로를 쓰거나, 쓰려면 원격 스크립트 파일로 빼야 한다.
 */
class RemoteDeployMacroStage extends BaseStage {
  async execute(stageConfig, basePath) {
    const vars = this.engine.context.variables;
    const cfg = (key) => stageConfig[key] !== undefined ? stageConfig[key] : vars[key];

    const host = cfg('host');
    const user = cfg('user');
    const port = cfg('port') || null;
    const keyPath = cfg('key_path');
    // 라이브 폴더는 `web_deploy_path` — IIS 가 바라보는 그 경로다. **로컬 배포와 같은 이름**을
    // 쓴다. 같은 것에 이름이 둘이면 어느 쪽을 적어야 하는지가 매번 판단거리가 되고,
    // 한쪽만 채운 설정이 조용히 통과한다.
    //
    // 섞일 걱정은 없다 — 한 번의 실행에서 배포 대상은 `deploy_server` 블록 하나뿐이다.
    // 이름을 가르는 기준은 **뜻이 다른가**이지 로컬/원격이 아니다.
    // 그래서 갈라 놓은 것은 따로 있다: `deploy_root`(배포 폴더들의 루트)와 라이브 폴더.
    //
    // server_info 안에서는 접두어 없이 쓴다 — 그 블록 전체가 이미 "원격" 을 뜻한다.
    // 바깥에 직접 적을 때 쓰는 remote_ 접두어 형태도 계속 받는다.
    const si = this.engine.context.serverInfo || {};
    const uploadPath = cfg('remote_upload_path') || si.upload_path || cfg('upload_path');
    const deployPath = cfg('remote_deploy_path') || si.web_deploy_path || cfg('web_deploy_path');
    const archivePath = stageConfig.file || vars.archive_path;

    // user·key_path 는 필수가 아니다. ~/.ssh/config 에 Host 항목이 있으면
    // ssh/scp 가 User·IdentityFile 을 스스로 찾는다. 여기서 또 적으면 두 곳이
    // 어긋날 수 있고, 어긋나면 config 가 아니라 이 값이 이긴다.
    // 반면 포트는 config 에 없으면 22 로 나가므로, 없을 때는 넘겨야 한다.
    const missing = [];
    if (!host) missing.push('host');
    if (!uploadPath) missing.push('upload_path (또는 remote_upload_path)');
    if (!deployPath) missing.push('web_deploy_path (server_info 안의 원격 라이브 폴더)');
    if (!archivePath) missing.push('file (또는 archive 스테이지의 archive_path)');
    if (missing.length) {
      // 원격 배포는 값이 하나만 비어도 엉뚱한 곳을 지운다. 시작 전에 전부 확인한다.
      throw new Error(`RemoteDeployMacroStage 에 필요한 값이 없습니다: ${missing.join(', ')}`);
    }

    // 웹서버 대상 이름. local_deploy 와 같은 규약 — 명시값 우선, 없으면 배포경로 끝 폴더명.
    const siteName = cfg('web_server_name') || cfg('remote_iis_site') || si.iis_site
      || path.basename(deployPath.replace(/[\\/]+$/, ''));
    // `web_server.type` 이 없으면 iis 로 본다. 지금까지 이 도구가 다룬 것이 IIS 뿐이라,
    // 기존 YAML 이 수정 없이 그대로 돌아야 한다 (#P002-REQ5).
    const wsType = cfg('web_server_type') || 'iis';
    const wsPool = cfg('web_server_pool');
    // 원격 스크립트가 놓이는 자리. upload_path 가 이미 프로젝트별이라 격리가 따라온다.
    // ⚠️ `win()` 은 아래에서 선언되므로 여기서 부르면 TDZ 다. 직접 바꾼다.
    const scriptDir = cfg('remote_script_dir')
      || `${String(uploadPath).replace(/\//g, '\\')}\\_scripts\\windows`;
    // 그 원본이 있는 **도구 서버** 폴더. 로컬 매크로가 쓰는 값과 같은 것이다 —
    // 스크립트는 한 벌이고, 원격이냐 로컬이냐는 실행 경로의 차이일 뿐이다.
    const localScriptDir = cfg('script_dir') || defaultScriptDir(vars);
    const manageIis = stageConfig.manage_iis !== false && cfg('web_server_type') !== 'none';

    // 원격 명령은 cmd.exe 가 받는다. **cmd 의 mkdir·move·if not exist 는 슬래시 경로를
    // 거부한다** — `mkdir D:/x` 는 "명령 구문이 올바르지 않습니다" 로 죽는다(2026-09-01 실측).
    // yaml 은 경로를 슬래시로 적으므로(`web_deploy_path: "D:/Deploy/..."`) 여기서 바꾼다.
    // scp 는 반대로 슬래시를 그대로 받으므로 업로드 인자는 원문을 쓴다.
    const win = (p) => String(p).replace(/\//g, '\\');

    const stamp = stampNow();
    const livePath = win(deployPath);

    // 백업은 `backup_root` 에 모은다. 지정하지 않으면 라이브 옆에 만든다.
    // ⚠️ 라이브와 같은 볼륨이어야 한다 — cmd 의 move 도 볼륨이 다르면 복사가 된다.
    const backupRoot = cfg('backup_root') ? win(cfg('backup_root')) : null;
    const backupDir = backupName(livePath, stamp);
    const backupPath = backupRoot ? `${backupRoot}\\${backupDir}` : `${livePath}_${stamp}`;
    const tempPath = `${livePath}_temp_${stamp}`;
    const remoteFile = `${win(uploadPath)}\\${path.basename(archivePath)}`;

    // user 를 안 주면 ssh config 가 정한다. 어느 쪽인지 로그에 남겨야 인증 실패를 추적할 수 있다.
    const target = user ? `${user}@${host}` : host;

    console.log(`\n[RemoteDeploy] Starting remote deployment...`);
    console.log(`- Target   : ${target}${port ? `:${port}` : ' (포트: ssh config)'}`);
    if (!user) console.log(`- Account  : ssh config 의 User 를 따릅니다`);
    if (!keyPath) console.log(`- Key      : ssh config 의 IdentityFile 을 따릅니다`);
    console.log(`- Live     : ${livePath}`);
    console.log(`- IIS Site : ${siteName}`);
    console.log(`- Artifact : ${path.basename(archivePath)}`);

    const ssh = this.#sshRunner({ target, port, keyPath, basePath });

    // 0. 공용 스크립트를 원격에 맞춘다 (#P002-TASK5)
    //
    //    **아무것도 건드리기 전에 한다.** 스크립트가 없다는 사실을 Step 3(스왑)에서 만나면
    //    업로드와 압축해제를 다 하고 나서 실패한다. 여기서 멈추면 원격은 손도 대지 않은 상태다.
    //    사유는 scriptSync.js 에 적어 뒀다 — 요점은 "매번 덮어쓴다" 이다.
    //
    //    ⚠️ `manage_iis:false` 여도 건너뛰지 않는다. TASK7 이후 **폴더를 옮기는 것도**
    //       스크립트가 하므로, 웹서버를 안 만진다고 스크립트가 필요 없어지지 않는다.
    if (cfg('sync_scripts') !== false) {
      console.log(`[RemoteDeploy] Step 0: 공용 스크립트 동기화 -> ${scriptDir}`);
      syncRemoteScripts(this.engine, {
        ssh, localDir: localScriptDir, remoteDir: scriptDir, target, port, keyPath, basePath
      });
    }

    // 1. 업로드
    console.log(`\n[RemoteDeploy] Step 1: Uploading artifact`);
    const scpPort = port ? `-P ${port}` : '';           // scp 는 대문자 -P
    const keyArg = keyPath ? `-i "${keyPath}"` : '';
    this.engine.runCommand(
      `scp ${scpPort} -o StrictHostKeyChecking=no ${keyArg} "${archivePath}" ${target}:"${uploadPath}"`,
      basePath
    );

    // 2. 임시폴더에 압축해제
    //
    // ArchiveStage 는 **최상위 폴더 한 겹**을 담는다(`MFM.SHORE_QA/...`). 탐색기에서
    // 열리게 하려고 그렇게 만든 것이라, 푸는 쪽은 그 한 겹을 벗겨야 한다.
    // 벗기지 않으면 라이브가 `<live>\MFM.SHORE_QA\...` 로 한 단계 깊어지는데,
    // 배포는 **성공으로 끝나고** IIS 만 빈 폴더를 서비스한다. 그래서 기본값이 1 이다.
    console.log(`[RemoteDeploy] Step 2: Extracting to ${tempPath}`);
    ssh(`if not exist ${tempPath} mkdir ${tempPath}`);
    const stripRaw = stageConfig.strip !== undefined ? stageConfig.strip : vars.strip;
    const strip = stripRaw === undefined ? 1 : Number(stripRaw);
    const stripOpt = strip > 0 ? ` --strip-components=${strip}` : '';
    ssh(`tar -xf ${remoteFile} -C ${tempPath}${stripOpt}`);

    // 푼 결과가 비어 있는지 본다. tar 가 0 으로 끝나도 항목이 없을 수 있고,
    // 그대로 스왑하면 **빈 폴더가 라이브가 된다** — 그때는 되돌리는 것 말고 답이 없다.
    const listed = ssh(`dir /b ${tempPath}`, { capture: true, allowFailure: true });
    const entries = (listed.output || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (listed.code !== 0 || entries.length === 0) {
      throw new Error(
        `원격 압축해제 결과가 비어 있습니다: ${tempPath}\n` +
        `  아카이브(${path.basename(archivePath)})나 strip(${strip}) 값을 확인하십시오.`
      );
    }
    console.log(`  [extract] 최상위 항목 ${entries.length}개 (${entries.slice(0, 3).join(', ')}${entries.length > 3 ? ', ...' : ''})`);

    // 2.5 서버 설정 보전 (local_deploy 의 Step 1.5 와 같은 일)
    //
    //   폴더를 통째로 갈아끼우므로 라이브의 설정을 옮겨 주지 않으면 사라진다.
    //   예전 bat 은 xcopy 병합이라 저절로 살아남았다. 지금은 여기서 한다.
    //   어느 쪽을 쓸지는 configPreserve 가 정한다 — 규칙은 그 파일에 적혀 있다.
    //
    //   IIS 정지 **전**이다. 설정 파일은 런타임에 아무도 쓰지 않으므로 지금 떠도 되고,
    //   정지 구간에는 rename 두 번만 남는다.
    const preserveConfig = stageConfig.preserve_config || this.engine.context.preserveConfig || [];
    // 운영 중 생성되어 배포 뒤에도 유지해야 하는 항목. 스크립트가 **정지한 뒤에** 옮긴다 —
    // 서비스가 살아 있으면 파일이 쓰이는 중이라 사본이 깨진다.
    const preserve = stageConfig.preserve || this.engine.context.preserve || [];
    const configBackup = cfg('config_backup') ? win(cfg('config_backup')) : null;

    if (preserveConfig.length > 0) {
      console.log(`[RemoteDeploy] Step 2.5: 서버 설정 보전 (${preserveConfig.length}건)`);
      if (configBackup) ssh(`if not exist ${configBackup} mkdir ${configBackup}`);

      // 시각은 원격에서 받아 오고 **판단은 로컬에서** 한다 — 원격 백업 정리와 같은 방식이다.
      const livePaths = preserveConfig.map(n => `${livePath}\\${n}`);
      const backupPaths = configBackup ? preserveConfig.map(n => `${configBackup}\\${n}`) : [];
      const stamps = this.#remoteMtimes(ssh, [...livePaths, ...backupPaths]);

      for (let i = 0; i < preserveConfig.length; i++) {
        const name = preserveConfig[i];
        const liveMs = stamps[i];
        const backupMs = configBackup ? stamps[preserveConfig.length + i] : null;

        const winner = decideConfigSource(liveMs, backupMs);
        if (winner === 'missing') {
          // 산출물에서는 exclude 로 지웠고 원격에도 없다 = 설정 없는 배포본이 된다.
          // 라이브를 건드리기 전에 멈춘다.
          throw new Error(
            `원격에 설정 파일이 어디에도 없습니다: ${name}\n` +
            `  라이브: ${livePaths[i]}\n` +
            `  백업  : ${backupPaths[i] || '(config_backup 미설정)'}`
          );
        }

        console.log(`  [config] ${formatDecision(name, liveMs, backupMs, winner)}`);
        // cmd 의 copy 는 원본 시각을 그대로 물려준다(실측). 시각을 찍으면 위 판정이 죽는다.
        ssh(`copy /y ${winner === 'config' ? backupPaths[i] : livePaths[i]} ${tempPath}\\${name} > nul`);

        // 라이브가 이겼으면 사본을 갱신해 둔다. config 가 이겼으면 이미 최신이다.
        if (winner === 'live' && configBackup) {
          ssh(`copy /y ${livePaths[i]} ${backupPaths[i]} > nul`);
        }
      }

      // 실제로 들어갔는지 확인한다. ssh 너머의 copy 는 조용히 빗나갈 수 있고,
      // 그대로 스왑하면 설정 없는 폴더가 라이브가 된다.
      const placed = this.#remoteMtimes(ssh, preserveConfig.map(n => `${tempPath}\\${n}`));
      const missing = preserveConfig.filter((_, i) => placed[i] === null);
      if (missing.length > 0) {
        throw new Error(`설정 파일이 배포본에 없습니다: ${missing.join(', ')} (${tempPath})`);
      }
    }

    // 3. 정지 → 백업 → 스왑 → 시작. **ssh 한 번이다** (#P002-TASK7).
    //
    //    쪼개면 안 되는 이유는 왕복 비용이 아니라 **라이브가 비는 구간** 때문이다.
    //    두 move 사이에는 라이브 폴더가 존재하지 않는다. 그 사이에 ssh 왕복이 끼면
    //    네트워크가 끊기는 순간이 곧 "라이브 없음" 이 되고, 그때 되돌릴 주체가 없다.
    //    한 스크립트 안이면 두 move 가 같은 프로세스에서 붙어 있고, 실패하면 그 자리에서
    //    되돌린다 — 되돌리기까지가 원격에서 끝난다.
    //
    //    예전에는 여기가 ssh 5회(정지·mkdir·move·move·시작)였다.
    assertRemotePath(`${scriptDir}\\deploy.bat`);

    console.log(`[RemoteDeploy] Step 3: 정지 -> 백업 -> 스왑 -> 시작 (deploy.bat)`);
    console.log(`  live   ${livePath}`);
    console.log(`  staged ${tempPath}`);
    console.log(`  backup ${backupPath}`);

    const r = ssh(`${scriptDir}\\deploy.bat`, {
      capture: true,
      allowFailure: true,
      env: {
        DP_LIVE: livePath,
        DP_STAGED: tempPath,
        DP_BACKUP: backupPath,
        DP_BACKUP_ROOT: backupRoot || undefined,   // 없으면 안 싣는다. 스크립트가 없는 대로 판단한다
        // 운영 중 생성된 항목(업로드 폴더 등)을 새 배포본으로 옮긴다.
        // **원격에는 없던 기능이다** — 로컬 매크로에만 있었는데, 같은 스크립트를 쓰게 되면서
        // 따라왔다. 쪼개진 구현을 합치면 이런 것이 저절로 메워진다.
        DP_PRESERVE: joinPreserve(preserve) || undefined,
        // 웹서버 변수는 `deploy.bat` 이 해석하지 않고 어댑터로 **그대로 상속**시킨다.
        WS_SKIP: manageIis ? undefined : '1',
        WS_TYPE: manageIis ? wsType : undefined,
        WS_NAME: manageIis ? siteName : undefined,
        WS_POOL: manageIis ? wsPool : undefined
      }
    });

    const out = (r.output || '').trim();
    if (out) out.split(/\r?\n/).forEach(line => console.log(`  ${line}`));

    // 무장 여부는 **종료코드가 정한다.** 백업이 실재할 때만 무장해야 한다 —
    // 없는 폴더로 무장하면 롤백이 "이력에는 남아 있습니다. 누가 지웠는지 확인하십시오"
    // 라는 엉뚱한 말을 하고 멈춘다. 진짜 사고를 그 소음에 묻는 셈이다.
    //
    //   0      배포됨. 백업이 있다            -> 무장 (health check 가 실패하면 되돌린다)
    //   1      라이브가 살아 있다.            -> 무장하지 않는다
    //          백업은 만들어지지 않았거나 되돌리며 소비됐다
    //   2·3·4  아무것도 옮기기 전이다          -> 무장하지 않는다
    //   5      라이브가 없다. 백업이 유일한 사본 -> 무장 (되돌리는 것 말고 답이 없다)
    //   그 외  ssh 가 끊겼다. **상태를 모른다** -> 무장. 못 되돌리는 쪽이 더 나쁘다
    const KNOWN = [0, 1, 2, 3, 4, 5];
    if (r.code === 0 || r.code === 5 || !KNOWN.includes(r.code)) {
      // 경로는 이력으로 넘긴다 — 롤백이 폴더를 훑는 대신 이 값을 읽는다.
      vars.backup_path = backupPath;
      this.engine.armRollback(`원격 백업: ${backupPath} (deploy.bat 종료코드 ${r.code})`);
    }

    if (r.code !== 0) {
      const why = reasonFor(DEPLOY, r.code);
      console.error(`\n[RemoteDeploy] 배포 실패 - ${siteName}`);
      console.error(`  사유     : ${why}`);
      console.error(`  종료코드 : ${r.code}`);
      if (r.code === 5) {
        // 스크립트가 원복까지 실패한 자리. 사람이 칠 명령을 그대로 적어 준다.
        console.error(`  ⚠️ 라이브 폴더가 없습니다. 원격에서 직접 실행하십시오:`);
        console.error(`     move ${backupPath} ${livePath}`);
      }
      throw new Error(`원격 배포 실패: ${why} (종료코드 ${r.code})`);
    }

    // 7. 원격 백업 정리. 로컬과 같은 정책(`backup.keep_count`)을 쓴다.
    //    원격은 아무도 훑지 않아 배포마다 690MB 가 무한히 쌓이던 자리다.
    //    정리 실패는 배포 성공을 뒤집지 않는다 — 로그만 남기고 넘어간다.
    try {
      this.#cleanupRemote(ssh, { backupRoot, livePath, remoteFile });
    } catch (err) {
      console.error(`[RemoteDeploy] 원격 정리 실패(배포는 정상): ${err.message}`);
    }

    // 8. 롤백이 라이브 옆에 남긴 `_failed_`·`_replaced_` 정리.
    //    배포가 성공했으면 그 실패는 지나갔다 — 앞으로 갈 사본은 배포 zip 이다.
    try {
      this.#cleanupLeftovers(ssh, livePath);
    } catch (err) {
      console.error(`[RemoteDeploy] 롤백 잔여 폴더 정리 실패(배포는 정상): ${err.message}`);
    }

    console.log(`[RemoteDeploy] Completed. 백업: ${backupPath}`);
  }

  /**
   * 원격의 오래된 백업을 지운다. 목록만 ssh 로 받아 오고 **판단은 로컬에서** 한다 —
   * 보관 정책(selectBackups)이 부수효과 없는 순수 함수라 그대로 재사용된다.
   */
  #cleanupRemote(ssh, { backupRoot, livePath }) {
    const root = backupRoot || livePath.replace(/\\[^\\]+$/, '');
    const listed = ssh(`dir /b /ad ${root}`, { capture: true, allowFailure: true });
    if (listed.code !== 0) {
      console.log(`[RemoteDeploy] 원격 백업 목록을 읽지 못했습니다: ${root}`);
      return;
    }

    const names = (listed.output || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const policy = this.engine.context.backup || {};
    const { keep, remove } = selectFromNames(names, livePath, root, policy);

    console.log(`[RemoteDeploy] 원격 백업 ${keep.length + remove.length}건: 유지 ${keep.length}, 삭제 ${remove.length}`);
    for (const item of keep) console.log(`  [keep]   ${item.name}`);

    if (policy.dry_run) {
      for (const item of remove) console.log(`  [dry-run] would remove ${item.name}`);
      return;
    }

    for (const item of remove) {
      ssh(`rmdir /s /q ${root}\\${item.name}`, { capture: true, allowFailure: true });
      console.log(`  [remove] ${item.name}`);
    }
  }

  /**
   * 라이브 옆의 롤백 잔여 폴더를 지운다. 백업 정리와 같은 방식이다 — 목록만 받아 오고
   * 고르는 규칙(`selectLeftovers`)은 로컬과 같은 함수를 쓴다.
   */
  #cleanupLeftovers(ssh, livePath) {
    const policy = this.engine.context.backup || {};
    if (policy.enabled === false) return;

    const parent = livePath.replace(/\\[^\\]+$/, '');
    const listed = ssh(`dir /b /ad ${parent}`, { capture: true, allowFailure: true });
    if (listed.code !== 0) {
      console.log(`[RemoteDeploy] 라이브 상위 폴더 목록을 읽지 못했습니다: ${parent}`);
      return;
    }

    const names = (listed.output || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const targets = selectLeftovers(names, livePath);
    if (targets.length === 0) return;

    console.log(`[RemoteDeploy] 롤백 잔여 폴더 ${targets.length}건 삭제`);
    for (const name of targets) {
      if (policy.dry_run) {
        console.log(`  [dry-run] would remove ${name}`);
        continue;
      }
      ssh(`rmdir /s /q ${parent}\\${name}`, { capture: true, allowFailure: true });
      console.log(`  [remove] ${name}`);
    }
  }

  /**
   * 원격 파일들의 수정시각을 한 번에 받아 온다. 없는 파일은 null 이다.
   *
   * 출력은 **인자 순서대로 한 줄에 하나**다. 구분자를 쓰지 않는 이유는 원격이 cmd 라서다 —
   * `|` 를 넣으면 cmd 가 파이프로 먹고, 따옴표를 넣으면 ssh 의 따옴표와 겹친다.
   * 그래서 파이프라인 연산자 없이 foreach 로만 쓴다.
   */
  #remoteMtimes(ssh, paths) {
    if (paths.length === 0) return [];

    const list = paths.map(p => `'${p}'`).join(',');
    const r = ssh(
      // ⚠️ LastWriteTime**Utc** 이어야 한다. LastWriteTime 은 원격의 로컬시각이라
      //    epoch 로 옮기면 시간대만큼(KST 는 9시간) 밀린 시각이 로그에 찍힌다.
      //    비교는 양쪽이 같은 기준이라 멀쩡한데 **로그만 틀려서** 눈치채기 어렵다.
      `powershell -NoProfile -c foreach($p in @(${list})){if(Test-Path $p){(Get-Item $p).LastWriteTimeUtc.Ticks}else{0}}`,
      { capture: true, allowFailure: true }
    );

    const lines = (r.output || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    return paths.map((_, i) => ticksToEpochMs(lines[i]));
  }

  /** 원격 명령 실행기. 구현은 sshRunner.js 한 곳에 있다 (롤백 매크로와 공유). */
  #sshRunner(opts) {
    return makeSshRunner(this.engine, opts);
  }

}

module.exports = RemoteDeployMacroStage;
