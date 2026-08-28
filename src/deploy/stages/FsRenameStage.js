const BaseStage = require('./BaseStage');
const fs = require('fs');
const path = require('path');

class FsRenameStage extends BaseStage {
  async execute(stageConfig, basePath) {
    const src = stageConfig.src;
    const dest = stageConfig.dest;

    if (!src || !dest) {
      throw new Error("FsRenameStage requires 'src' and 'dest' parameters.");
    }

    console.log(`[FsRenameStage] Renaming ${src} -> ${dest}`);

    if (!fs.existsSync(src)) {
      console.log(`[FsRenameStage] Warning: Source path ${src} does not exist. Skipping rename.`);
      return;
    }
    
    if (fs.existsSync(dest)) {
      // If the destination exists, rename it with a timestamp or delete it.
      // Usually, backup logic handles it, but just in case:
      console.log(`[FsRenameStage] Destination ${dest} already exists. Removing it first.`);
      fs.rmSync(dest, { recursive: true, force: true });
    }

    try {
      fs.renameSync(src, dest);
    } catch (err) {
      // EXDEV (cross-device link) error handling
      if (err.code === 'EXDEV') {
        console.log(`[FsRenameStage] Cross-device rename detected. Using fallback copy & delete.`);
        fs.cpSync(src, dest, { recursive: true });
        fs.rmSync(src, { recursive: true, force: true });
      } else {
        throw err;
      }
    }
    console.log(`[FsRenameStage] Successfully renamed to ${dest}.`);
  }
}

module.exports = FsRenameStage;
