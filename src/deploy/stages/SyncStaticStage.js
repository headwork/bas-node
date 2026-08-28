const BaseStage = require('./BaseStage');
const fs = require('fs');
const path = require('path');

class SyncStaticStage extends BaseStage {
  async execute(stageConfig, basePath) {
    const src = stageConfig.src;
    const dest = stageConfig.dest;
    const targets = stageConfig.targets;

    if (!src || !dest || !Array.isArray(targets)) {
      throw new Error("SyncStaticStage requires 'src', 'dest', and 'targets' (array) parameters.");
    }

    console.log(`[SyncStaticStage] Syncing static files from ${src} to ${dest}`);

    for (const target of targets) {
      const sourceDir = path.join(src, target);
      const destDir = path.join(dest, target);

      if (fs.existsSync(sourceDir)) {
        console.log(`[SyncStaticStage] Copying ${sourceDir} -> ${destDir}`);
        // fs.cpSync(src, dest) replaces xcopy. Requires Node 16.7+
        fs.cpSync(sourceDir, destDir, { recursive: true, force: true });
      } else {
        console.log(`[SyncStaticStage] Warning: Target directory ${sourceDir} not found in source. Skipping.`);
      }
    }
  }
}

module.exports = SyncStaticStage;
