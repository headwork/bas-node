const BaseStage = require('./BaseStage');
const fs = require('fs');

class ExtractStage extends BaseStage {
  async execute(stageConfig, basePath) {
    const file = stageConfig.file;
    const dest = stageConfig.dest;

    if (!file || !dest) {
      throw new Error("ExtractStage requires 'file' and 'dest' parameters.");
    }

    if (!fs.existsSync(dest)) {
      console.log(`[ExtractStage] Destination directory does not exist. Creating ${dest}...`);
      fs.mkdirSync(dest, { recursive: true });
    }

    // Windows 10+ 및 Linux 환경에서 기본 제공되는 tar 명령어 활용
    // -xf 로 둔다(-xzf 는 gzip 전용). bsdtar 가 .gz / .zip 을 확장자·매직으로 자동 판별한다.
    // 기존 흐름은 MFM.Shore.gz 를, archive 스테이지는 .zip 을 만든다 — 둘 다 받아야 한다.
    // strip: 1 이면 아카이브의 최상위 폴더 한 겹을 벗긴다.
    // archive 스테이지가 만든 zip 은 <name>/... 배치라 1 이 필요하고,
    // './' 접두어로 만들어진 옛 아카이브·gz 는 0(기본)이다.
    // ⚠️ 옛 아카이브에 1 을 주면 루트 파일이 통째로 빠지는데 tar 는 에러를 내지 않는다.
    const strip = Number(stageConfig.strip || 0);
    const stripOpt = strip > 0 ? ` --strip-components=${strip}` : '';
    const cmd = `tar -xf "${file}" -C "${dest}"${stripOpt}`;
    console.log(`[ExtractStage] Executing: ${cmd}`);
    this.engine.runCommand(cmd, basePath);
  }
}

module.exports = ExtractStage;
