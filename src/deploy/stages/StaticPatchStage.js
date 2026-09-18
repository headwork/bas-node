const BaseStage = require('./BaseStage');
const path = require('path');
const fs = require('fs');
const ArchiveStage = require('./ArchiveStage');
const { stampNow } = require('../backupRetention');
const { makeSshRunner } = require('../sshRunner');
const { syncRemoteScripts, assertScript, defaultScriptDir, defaultRemoteScriptDir } = require('../scriptSync');
const { PATCH, reasonFor } = require('../scriptExit');
const { assertRemotePath } = require('../remoteEnv');

/**
 * 정적 배포 — 바뀐 파일만 라이브에 덮어쓴다. (`if: changed_static_only`)
 *
 *   1. 바뀐 파일 목록     git diff git_from..git_to   (삭제는 빼고)
 *   2. 그 파일만 모은다    <build_path>_patch/        (build_cwd 기준 상대경로 = 라이브 안의 자리)
 *   3. 압축 · 업로드 · 해제  원격일 때만. zip 은 `<이름>_patch.zip` — 전체 배포 zip 을 덮지 않는다
 *   4. 라이브에 덮어쓰기   patch.bat
 *
 * 빌드도, 웹서버 정지도, 백업·스왑도 없다. `.cshtml` 은 런타임 컴파일이고 자산은 요청마다
 * 읽으므로 파일을 바꾸면 그것으로 배포가 끝난다.
 *
 * ## git 을 믿는다
 *
 * 이 단계는 산출물을 검사하지 않는다. 믿는 근거는 **비교 기준**이다 — `git_from` 은
 * 작업 폴더의 HEAD 가 아니라 **이 환경의 마지막 성공 배포 커밋**이다(GitSyncStage).
 * 그래서 실패한 배포의 변경은 다음 배포에 누적되어 함께 나가고, 중간에 끊긴 복사는
 * 다음 실행이 같은 범위를 다시 덮는다. 기준이 없으면 GitSyncStage 가 정적 판정을
 * 하지 않으므로(전체 배포) 이 단계에 오지 않는다.
 *
 * ## 헬스체크는 재시작했을 때만
 *
 * 서버가 살아 있으면 건드리지 않는다 — 재시작이 없으니 헬스체크도 없다.
 * 멈춰 있으면 복사 뒤에 시작하고(patch.bat 종료코드 6), 그때만 `server_restarted` 를 켠다.
 *
 * ⚠️ 롤백을 무장하지 않는다. 백업을 만들지 않으므로 되돌릴 대상이 없다.
 */
class StaticPatchStage extends BaseStage {
  async execute(stageConfig, basePath) {
    const config = stageConfig && typeof stageConfig === 'object' ? stageConfig : {};
    const vars = this.engine.context.variables;
    const cfg = (key) => config[key] !== undefined ? config[key] : vars[key];

    const sourcePath = cfg('source_path');
    const cwd = cfg('build_cwd') || sourcePath;
    const buildPath = cfg('build_path');
    const from = vars.git_from;
    const to = vars.git_to;

    const missing = [];
    if (!sourcePath) missing.push('source_path');
    if (!buildPath) missing.push('build_path');
    if (!from || !to) missing.push('git_from·git_to (git_sync 가 먼저 돌아야 한다)');
    if (missing.length) {
      throw new Error(`StaticPatchStage 에 필요한 값이 없습니다: ${missing.join(', ')}`);
    }

    const files = this.#changedFiles(sourcePath, from, to);
    console.log(`\n[StaticPatch] ${from.slice(0, 8)} -> ${to.slice(0, 8)} : 복사할 파일 ${files.length}건`);
    if (files.length === 0) {
      // 삭제만 있었다. 삭제는 서버에 반영하지 않는다(2026-08-27 결정).
      console.log(`[StaticPatch] 복사할 파일이 없습니다 (삭제는 반영하지 않습니다).`);
      vars.server_restarted = false;
      return;
    }

    const staged = this.#stage(files, { sourcePath, cwd, buildPath });

    const remote = this.engine.isTruthy('deploy_remote');
    const r = remote
      ? await this.#patchRemote(staged, cfg, basePath)
      : this.#patchLocal(staged, cfg, basePath);

    const out = (r.output || '').trim();
    if (out) out.split(/\r?\n/).forEach(line => console.log(`  ${line}`));

    if (r.code === 6) {
      vars.server_restarted = true;
      console.log(`[StaticPatch] 웹서버가 멈춰 있어 시작했습니다 - 헬스체크를 합니다.`);
    } else if (r.code === 0) {
      vars.server_restarted = false;
      console.log(`[StaticPatch] 웹서버는 그대로입니다 - 재시작·헬스체크 없음.`);
    } else {
      const why = reasonFor(PATCH, r.code);
      console.error(`\n[StaticPatch] 정적 배포 실패`);
      console.error(`  사유     : ${why}`);
      console.error(`  종료코드 : ${r.code}`);
      throw new Error(`정적 배포 실패: ${why} (종료코드 ${r.code})`);
    }

    console.log(`[StaticPatch] Completed.`);
  }

  /**
   * 바뀐 파일 목록. **삭제는 뺀다** — 없는 파일은 복사할 수 없고, 서버에서 지우지도 않는다.
   * 이름 바꾸기는 새 이름만 나온다(옛 이름의 파일은 서버에 남는다. 삭제와 같은 규칙).
   */
  #changedFiles(sourcePath, from, to) {
    const r = this.engine.runCommand(
      `git -c core.quotepath=false diff --name-only --diff-filter=d ${from} ${to}`,
      sourcePath, { capture: true, allowFailure: true }
    );
    if (r.code !== 0) {
      throw new Error(`바뀐 파일 목록을 구하지 못했습니다 (${from.slice(0, 8)}..${to.slice(0, 8)}): ${(r.output || '').trim()}`);
    }
    return (r.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
  }

  /**
   * 바뀐 파일만 `<build_path>_patch` 에 모은다. 자리는 **build_cwd 기준 상대경로**다 —
   * `MFM.Shore/Web/Views/a.cshtml` 은 라이브의 `Views/a.cshtml` 이 된다.
   *
   * build_cwd 밖의 파일은 라이브 안의 자리를 모른다. 추측하지 않고 멈춘다 —
   * static_paths 가 게시되지 않는 폴더를 가리키고 있다는 뜻이다.
   */
  #stage(files, { sourcePath, cwd, buildPath }) {
    const staged = path.resolve(`${String(buildPath).replace(/[\\/]+$/, '')}_patch`);
    fs.rmSync(staged, { recursive: true, force: true });
    fs.mkdirSync(staged, { recursive: true });

    for (const file of files) {
      const abs = path.resolve(sourcePath, file);
      const rel = path.relative(path.resolve(cwd), abs);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(
          `build_cwd 밖의 파일이라 라이브 안의 자리를 알 수 없습니다: ${file}\n` +
          `  build_cwd: ${cwd}\n` +
          `  git_sync 의 static_paths 는 build_cwd 아래의 게시되는 폴더만 가리켜야 합니다.`
        );
      }
      const dest = path.join(staged, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(abs, dest);
      console.log(`  [patch] ${rel.replace(/\\/g, '/')}`);
    }

    return staged;
  }

  /** 로컬: 모은 폴더를 그대로 넘긴다. 압축하지 않는다. */
  #patchLocal(staged, cfg, basePath) {
    const deployPath = cfg('web_deploy_path');
    if (!deployPath) throw new Error(`StaticPatchStage 에 필요한 값이 없습니다: web_deploy_path`);

    const scriptDir = cfg('script_dir') || defaultScriptDir(this.engine.context.variables);
    const script = path.join(scriptDir, 'patch.bat');
    assertScript(script, scriptDir);

    const ws = this.#webServer(cfg, deployPath);
    console.log(`[StaticPatch] 라이브에 덮어쓰기 (patch.bat)`);
    console.log(`  live   ${deployPath}`);
    console.log(`  source ${staged}`);

    // 계약에 있는 키는 빈 값으로라도 전부 적는다 — 부모(젠킨스)의 같은 이름이 새어 들지 않게.
    return this.engine.runCommand(`"${script}"`, basePath, {
      capture: true,
      allowFailure: true,
      env: {
        PT_LIVE: deployPath,
        PT_SOURCE: staged,
        WS_SKIP: ws.manage ? '' : '1',
        WS_TYPE: ws.manage ? ws.type : '',
        WS_NAME: ws.manage ? ws.name : '',
        WS_POOL: ws.manage && ws.pool ? ws.pool : ''
      }
    });
  }

  /** 원격: 압축 → 업로드 → 해제 → patch.bat. 해제한 임시 폴더는 결과와 무관하게 지운다. */
  async #patchRemote(staged, cfg, basePath) {
    const si = this.engine.context.serverInfo || {};
    const host = cfg('host');
    const user = cfg('user');
    const port = cfg('port') || null;
    const keyPath = cfg('key_path');
    const uploadPath = cfg('remote_upload_path') || si.upload_path || cfg('upload_path');
    const deployPath = cfg('remote_deploy_path') || si.web_deploy_path || cfg('web_deploy_path');

    const missing = [];
    if (!host) missing.push('host');
    if (!uploadPath) missing.push('upload_path');
    if (!deployPath) missing.push('web_deploy_path');
    if (missing.length) throw new Error(`StaticPatchStage 에 필요한 값이 없습니다: ${missing.join(', ')}`);

    const win = (p) => String(p).replace(/\//g, '\\');
    const livePath = win(deployPath);
    const scriptDir = cfg('remote_script_dir')
      || defaultRemoteScriptDir(uploadPath, this.engine.context.environment);
    const target = user ? `${user}@${host}` : host;
    const ssh = makeSshRunner(this.engine, { target, port, keyPath, basePath });

    if (cfg('sync_scripts') !== false) {
      syncRemoteScripts(this.engine, {
        ssh, localDir: cfg('script_dir') || defaultScriptDir(this.engine.context.variables),
        remoteDir: scriptDir, target, port, keyPath, basePath
      });
    }

    // 압축은 archive 스테이지와 같은 방식이다(최상위 폴더 한 겹). 이름이 `_patch` 로 끝나
    // 전체 배포 zip 과 겹치지 않는다 — 롤백 뒤 다시 앞으로 갈 때 쓰는 것이 그 zip 이다.
    await new ArchiveStage(this.engine).execute({ src: staged }, basePath);
    const zipPath = this.engine.context.variables.archive_path;

    const scpPort = port ? `-P ${port}` : '';
    const keyArg = keyPath ? `-i "${keyPath}"` : '';
    this.engine.runCommand(
      `scp ${scpPort} -o StrictHostKeyChecking=no ${keyArg} "${zipPath}" ${target}:"${uploadPath}"`,
      basePath
    );

    const remoteZip = `${win(uploadPath)}\\${path.basename(zipPath)}`;
    const tempPath = `${livePath}_patch_${stampNow()}`;
    assertRemotePath(tempPath, '원격 임시 폴더');
    assertRemotePath(`${scriptDir}\\patch.bat`);

    const ws = this.#webServer(cfg, livePath);
    try {
      ssh(`if not exist ${tempPath} mkdir ${tempPath}`);
      ssh(`tar -xf ${remoteZip} -C ${tempPath} --strip-components=1`);

      console.log(`[StaticPatch] 라이브에 덮어쓰기 (patch.bat)`);
      return ssh(`${scriptDir}\\patch.bat`, {
        capture: true,
        allowFailure: true,
        env: {
          PT_LIVE: livePath,
          PT_SOURCE: tempPath,
          WS_SKIP: ws.manage ? undefined : '1',
          WS_TYPE: ws.manage ? ws.type : undefined,
          WS_NAME: ws.manage ? ws.name : undefined,
          WS_POOL: ws.manage ? ws.pool : undefined
        }
      });
    } finally {
      ssh(`if exist ${tempPath} rmdir /s /q ${tempPath}`, { capture: true, allowFailure: true });
    }
  }

  /** 웹서버 대상. 배포 매크로와 같은 규칙 — 명시값 우선, 없으면 라이브 폴더 이름. */
  #webServer(cfg, livePath) {
    const type = cfg('web_server_type') || 'iis';
    return {
      manage: cfg('manage_iis') !== false && type !== 'none',
      type,
      name: cfg('web_server_name') || cfg('iis_site') || path.basename(String(livePath).replace(/[\\/]+$/, '')),
      pool: cfg('web_server_pool')
    };
  }
}

module.exports = StaticPatchStage;
