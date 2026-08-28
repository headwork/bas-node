const BaseStage = require('./BaseStage');
const path = require('path');
const fs = require('fs');

/**
 * 배포 산출물을 압축한다 (#P001-REQ3).
 *
 *   - archive:
 *       src:  "D:/Deploy/build/_publish/MFM.SHORE_QA"   # 기본: build_path
 *       dest: "D:/Deploy/build/_artifacts"              # 기본: <src>/../_artifacts
 *       name: "MFM.SHORE_QA"                            # 기본: src 의 basename
 *                                                       # 실제 파일명: <name>_<yyyyMMdd_HHmmss>.zip
 *
 * Windows 는 tar.exe(bsdtar) 로 먼저 시도하고 실패하면 Compress-Archive 로 되돌아간다.
 * bsdtar 가 훨씬 빠르지만 zip 쓰기 지원이 빌드에 따라 다르다.
 */
class ArchiveStage extends BaseStage {
  async execute(stageConfig, basePath) {
    const config = stageConfig && typeof stageConfig === 'object' ? stageConfig : {};
    const vars = this.engine.context.variables;

    const src = config.src || vars.build_path;
    if (!src) {
      throw new Error("ArchiveStage requires 'src' (stage config or build_path variable).");
    }
    if (!fs.existsSync(src)) {
      throw new Error(`Archive source does not exist: ${src}`);
    }

    // 아카이브 안에는 최상위 폴더 하나를 둔다 (<srcName>/...).
    // 예전에는 `-C <src> .` 로 내용만 담았는데, 그러면 엔트리 이름이 전부 './' 로
    // 시작한다. tar·.NET 은 정규화해서 정상 해제되지만 윈도우 탐색기(zipfldr)는
    // 리터럴로 다뤄 루트 항목을 0개로 계산한다 — 더블클릭하면 빈 창이 뜨고
    // '압축 풀기'를 눌러도 아무것도 안 나온다. 배포는 돌아가고 사람이 열어볼 때만
    // 실패하므로 조용히 넘어간다. 최상위 폴더를 두면 './' 가 사라진다.
    // 푸는 쪽은 extract 스테이지의 strip: 1 로 이 한 겹을 벗긴다.
    const srcResolved = path.resolve(src);
    const srcParent = path.dirname(srcResolved);
    const srcName = path.basename(srcResolved);

    const destDir = config.dest || path.join(path.dirname(src), '_artifacts');
    const baseName = config.name || srcName;
    const stamp = timestamp();
    const zipPath = path.join(destDir, `${baseName}_${stamp}.zip`);

    fs.mkdirSync(destDir, { recursive: true });
    if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });

    console.log(`\n[ArchiveStage] Packaging deployment artifact...`);
    console.log(`- Source : ${src}`);
    console.log(`- Archive: ${zipPath}`);

    const startedAt = Date.now();

    if (process.platform === 'win32') {
      const tarExe = path.join(process.env.windir || 'C:\\Windows', 'System32', 'tar.exe');
      let done = false;

      if (fs.existsSync(tarExe)) {
        try {
          // -C <부모> <폴더명> : 최상위 폴더 하나를 담는다. 멤버 인자가 1개라
          // cmd.exe 8191자 한계에도 걸리지 않는다 (최상위 항목은 188개다).
          this.engine.runCommand(`"${tarExe}" -a -c -f "${zipPath}" -C "${srcParent}" "${srcName}"`);
          done = true;
        } catch (e) {
          console.log(`[ArchiveStage] tar.exe failed, falling back to Compress-Archive.`);
          if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });
        }
      }

      if (!done) {
        // 와일드카드(\*) 를 붙이지 않는다 — 폴더 자체를 담아야 tar 경로와 같은
        // 배치(<srcName>/...)가 나온다. 붙이면 내용만 평평하게 들어가 strip 이 어긋난다.
        const psCmd = `Compress-Archive -Path '${srcResolved}' -DestinationPath '${zipPath}' -Force`;
        this.engine.runCommand(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psCmd}"`);
      }
    } else {
      this.engine.runCommand(`zip -qr "${zipPath}" "${srcName}"`, srcParent);
    }

    if (!fs.existsSync(zipPath)) {
      // 명령이 0 으로 끝나도 산출물이 없으면 성공이 아니다.
      throw new Error(`Archive command finished but no archive was produced: ${zipPath}`);
    }

    const sizeMb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[ArchiveStage] Archive created: ${sizeMb} MB in ${elapsed}s`);

    // 후속 스테이지가 참조할 수 있도록 컨텍스트에 실어 둔다.
    this.engine.context.variables.archive_path = zipPath;
  }
}

function timestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

module.exports = ArchiveStage;
