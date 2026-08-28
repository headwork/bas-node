require('dotenv').config(); // `.env` 파일 로드 지원
const PipelineEngine = require('./PipelineEngine');
const path = require('path');

async function main() {
  const args = process.argv.slice(2);
  let yamlFile = null;
  let params = {};
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--yaml=')) {
      yamlFile = args[i].split('=')[1];
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i].startsWith('--params=')) {
      try {
        const jsonStr = args[i].substring('--params='.length);
        params = JSON.parse(jsonStr);
      } catch (e) {
        console.error("Invalid JSON provided to --params");
        process.exit(1);
      }
    }
  }

  if (!yamlFile) {
    console.error("Usage: node deploy-cli.js --yaml=<path> [--params='{\"key\":\"value\"}'] [--dry-run]");
    console.error("  --dry-run : 실행하지 않고 해석된 변수와 단계 계획만 출력");
    process.exit(1);
  }

  const targetPath = path.resolve(process.cwd(), yamlFile);

  try {
    const engine = new PipelineEngine();
    await engine.run(targetPath, params, { dryRun });
  } catch (err) {
    console.error("Pipeline failed with error:", err.message);
    process.exit(1);
  }
}

main();
