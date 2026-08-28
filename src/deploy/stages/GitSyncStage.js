const BaseStage = require('./BaseStage');
const { maskUrlCredentials } = require('../maskSecrets');
const fs = require('fs');
const path = require('path');

/**
 * Git 동기화 + 변경 내용 분류.
 *
 * 동기화 전후의 커밋을 비교해 무엇이 바뀌었는지 컨텍스트에 실어 둔다.
 * 뒤따르는 스테이지가 `if:` / `unless:` 로 이 값을 보고 건너뛸 수 있다.
 *
 *   changed_count        변경 파일 수
 *   has_changes          변경이 있었는가
 *   changed_static_only  변경이 전부 정적 파일인가 (빌드·재기동 불필요)
 *   git_from · git_to    비교한 커밋
 *
 * static_paths 를 지정하지 않으면 분류하지 않는다(항상 전체 배포).
 */
class GitSyncStage extends BaseStage {
  async execute(stageConfig, basePath) {
    const config = stageConfig && typeof stageConfig === 'object' ? stageConfig : {};
    const vars = this.engine.context.variables;

    const gitUrl = vars.git_url || config.git_url;
    const branch = vars.branch || config.branch || 'main';
    const buildPath = vars.build_path || config.build_path;
    const staticPaths = config.static_paths || vars.static_paths || null;

    if (!gitUrl || !buildPath) {
      throw new Error("GitSyncStage requires 'git_url' and 'build_path'.");
    }

    console.log(`\n[GitSyncStage] Starting synchronization...`);
    console.log(`- Target Branch: ${branch}`);
    console.log(`- Local Path: ${buildPath}`);

    const isExisting = fs.existsSync(path.join(buildPath, '.git'));
    const before = isExisting ? this.revParse(buildPath) : null;

    if (isExisting) {
      console.log(`[GitSyncStage] Found existing .git repository. Executing git pull...`);
      const cmd = `git stash && git fetch origin && git checkout ${branch} && git pull origin ${branch}`;
      this.engine.runCommand(cmd, buildPath);
    } else {
      // URL 에 박힌 자격증명은 가리고 출력한다 (#P001-REQ8)
      console.log(`[GitSyncStage] Repository not found locally. Cloning from ${maskUrlCredentials(gitUrl)}...`);
      if (!fs.existsSync(buildPath)) {
        fs.mkdirSync(buildPath, { recursive: true });
      }
      const cmd = `git clone -b ${branch} "${gitUrl}" .`;
      this.engine.runCommand(cmd, buildPath);
    }

    const after = this.revParse(buildPath);
    console.log(`[GitSyncStage] Git synchronization completed successfully.`);

    this.classify(buildPath, before, after, staticPaths);
  }

  revParse(cwd) {
    const r = this.engine.runCommand('git rev-parse HEAD', cwd, { capture: true, allowFailure: true });
    return r.code === 0 ? (r.stdout || '').trim() : null;
  }

  classify(buildPath, before, after, staticPaths) {
    const vars = this.engine.context.variables;
    vars.git_from = before || '';
    vars.git_to = after || '';

    // 최초 클론이면 비교 대상이 없다. 전체 배포로 본다.
    if (!before) {
      console.log(`[GitSyncStage] 최초 클론 - 변경 분류 없이 전체 배포로 진행합니다.`);
      vars.has_changes = true;
      vars.changed_count = 0;
      vars.changed_static_only = false;
      return;
    }

    if (before === after) {
      console.log(`[GitSyncStage] 변경 없음 (${before.slice(0, 8)})`);
      vars.has_changes = false;
      vars.changed_count = 0;
      vars.changed_static_only = false;
      return;
    }

    const r = this.engine.runCommand(
      `git diff --name-only ${before} ${after}`, buildPath, { capture: true, allowFailure: true }
    );
    if (r.code !== 0) {
      // 분류에 실패하면 안전한 쪽(전체 배포)으로 간다. 조용히 정적으로 판정하지 않는다.
      console.error(`[GitSyncStage] 변경 목록 조회 실패 - 전체 배포로 진행합니다.`);
      vars.has_changes = true;
      vars.changed_count = 0;
      vars.changed_static_only = false;
      return;
    }

    const files = (r.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
    vars.has_changes = files.length > 0;
    vars.changed_count = files.length;

    // 목록 자체는 변수가 아니라 컨텍스트에 둔다. 상태 파일이 이걸 받아
    // 다음 단계·다음 실행으로 넘긴다(공지·재공지용). 변수에 넣으면 치환·마스킹 대상이 된다.
    this.engine.context.changedFiles = files;

    console.log(`[GitSyncStage] ${before.slice(0, 8)} -> ${after.slice(0, 8)} : 변경 ${files.length}건`);

    if (!staticPaths || staticPaths.length === 0) {
      // 분류 기준을 안 줬으면 판정하지 않는다.
      vars.changed_static_only = false;
      return;
    }

    const normalized = staticPaths.map(p => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/?$/, '/'));
    const nonStatic = files.filter(f => {
      const p = f.replace(/\\/g, '/');
      return !normalized.some(prefix => p.startsWith(prefix));
    });

    vars.changed_static_only = files.length > 0 && nonStatic.length === 0;

    if (vars.changed_static_only) {
      console.log(`[GitSyncStage] 정적 파일만 변경됨 - 빌드·스왑·재기동을 건너뛸 수 있습니다.`);
      for (const f of files.slice(0, 10)) console.log(`    ${f}`);
      if (files.length > 10) console.log(`    ... 외 ${files.length - 10}건`);
    } else {
      console.log(`[GitSyncStage] 정적 외 변경 ${nonStatic.length}건 - 전체 배포가 필요합니다.`);
      for (const f of nonStatic.slice(0, 10)) console.log(`    ${f}`);
      if (nonStatic.length > 10) console.log(`    ... 외 ${nonStatic.length - 10}건`);
    }
  }
}

module.exports = GitSyncStage;
