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
 *   changed_commit_count 변경 커밋 수 (중복·Revert 정제 후)
 *   has_changes          변경이 있었는가
 *   changed_static_only  변경이 전부 정적 파일인가 (빌드·재기동 불필요)
 *   git_from · git_to    비교한 커밋
 *
 * 목록 자체(파일·커밋)는 변수가 아니라 컨텍스트에 실어 상태 파일로 넘긴다.
 * 배포가 끝난 뒤 텔레그램·컨플루언스가 그것을 읽어 공지한다.
 *
 * static_paths 를 지정하지 않으면 분류하지 않는다(항상 전체 배포).
 */
class GitSyncStage extends BaseStage {
  async execute(stageConfig, basePath) {
    const config = stageConfig && typeof stageConfig === 'object' ? stageConfig : {};
    const vars = this.engine.context.variables;

    const gitUrl = vars.git_url || config.git_url;
    const branch = vars.branch || config.branch || 'main';

    // 소스 위치와 빌드 산출물 위치는 다르다.
    //   source_path : git 체크아웃 (여기서 pull 한다)
    //   build_path  : publish 결과가 쌓이는 곳
    // source_path 가 없으면 예전처럼 build_path 를 소스로 본다 — 기존 yaml 을 깨지 않는다.
    const explicitSource = vars.source_path || config.source_path;
    const buildPath = explicitSource || vars.build_path || config.build_path;
    const staticPaths = config.static_paths || vars.static_paths || null;

    if (!gitUrl || !buildPath) {
      throw new Error("GitSyncStage requires 'git_url' and 'source_path' (또는 'build_path').");
    }

    console.log(`\n[GitSyncStage] Starting synchronization...`);
    console.log(`- Target Branch: ${branch}`);
    console.log(`- Local Path: ${buildPath}`);

    const isExisting = fs.existsSync(path.join(buildPath, '.git'));

    // 폴백이 걸린 채 clone 으로 넘어가는 것을 막는다.
    // source_path 를 빠뜨리면 위에서 build_path 로 떨어지는데, 거기는 publish 산출물
    // 폴더다. 그대로 두면 **빌드 결과가 쌓이는 자리에 저장소를 통째로 clone** 하고,
    // 게시 프로파일의 DeleteExistingFiles 가 매번 그것을 지운다. 에러는 나지 않는다.
    if (!isExisting && !explicitSource) {
      throw new Error(
        `source_path 가 없어 build_path 를 소스로 보고 있는데 거기에 .git 이 없습니다: ${buildPath}\n` +
        `  그대로 두면 빌드 산출물 폴더에 저장소를 clone 합니다.\n` +
        `  target 이 참조하는 build_server 블록에 source_path 를 지정하십시오.`
      );
    }

    const before = isExisting ? this.revParse(buildPath) : null;

    if (isExisting) {
      console.log(`[GitSyncStage] Found existing .git repository. Executing git pull...`);
      // fetch 를 대상 브랜치로 좁힌다. `git fetch origin` 은 master 를 포함해 전부 받아와서
      // 로그에 master 갱신 줄이 섞여 "master 와 비교하나?" 로 읽힌다. 비교는 언제나
      // 이 브랜치의 pull 전/후 커밋 사이에서만 한다.
      const cmd = `git stash && git fetch origin ${branch} && git checkout ${branch} && git pull origin ${branch}`;
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
      vars.changed_commit_count = 0;
      vars.changed_static_only = false;
      return;
    }

    if (before === after) {
      console.log(`[GitSyncStage] 변경 없음 (${before.slice(0, 8)})`);
      vars.has_changes = false;
      vars.changed_count = 0;
      vars.changed_commit_count = 0;
      vars.changed_static_only = false;
      return;
    }

    // core.quotepath 기본값(true)은 한글 경로를 \353\260\260 처럼 8진 이스케이프로 내놓는다.
    // 그대로 공지에 실리면 사람이 읽을 수 없고, 정적 파일 판정(prefix 비교)도 빗나간다.
    const r = this.engine.runCommand(
      `git -c core.quotepath=false diff --name-only ${before} ${after}`,
      buildPath, { capture: true, allowFailure: true }
    );
    if (r.code !== 0) {
      // 분류에 실패하면 안전한 쪽(전체 배포)으로 간다. 조용히 정적으로 판정하지 않는다.
      console.error(`[GitSyncStage] 변경 목록 조회 실패 - 전체 배포로 진행합니다.`);
      vars.has_changes = true;
      vars.changed_count = 0;
      vars.changed_commit_count = 0;
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

    this.collectCommits(buildPath, before, after);

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

  /**
   * 배포 공지에 실을 커밋 목록을 뽑는다.
   *
   * 젠킨스 잡이 `git log --oneline HEAD..origin/<branch>` 로 하던 일을 옮긴 것이다.
   * 다른 점은 둘 — **같은 제목의 중복**과 **Revert 쌍**을 걷어낸다.
   *
   * Revert 판정은 제목(`Revert "..."`)이 아니라 본문의 `This reverts commit <sha>` 로 한다.
   * 제목으로 맞추면 우연히 제목이 같은 다른 커밋까지 함께 사라진다.
   * 되돌린 원본이 **이 범위 안에 있을 때만** 상쇄한다 — 지난 배포분을 되돌린 커밋은
   * 이번 배포의 실제 변경이므로 남겨야 한다.
   *
   * 상쇄된 쌍은 지우지 않고 `revertedCommits` 로 따로 넘긴다. 공지에서 "되돌림"으로
   * 밝힐 수 있어야 한다 — 목록에서 사라지기만 하면 왜 없는지 아무도 모른다.
   */
  collectCommits(buildPath, before, after) {
    const US = '\u001f';   // 필드 구분
    const RS = '\u001e';   // 레코드 구분. 커밋 본문에 개행이 있어 줄 단위로는 자를 수 없다.
    const fmt = '%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%b%x1e';

    const r = this.engine.runCommand(
      `git log --no-merges --pretty=format:"${fmt}" ${before}..${after}`,
      buildPath, { capture: true, allowFailure: true }
    );

    if (r.code !== 0) {
      // 배포를 막지는 않는다. 다만 조용히 비우면 "변경 없는 배포" 로 공지된다.
      console.error(`[GitSyncStage] 커밋 목록 조회 실패 - 공지의 변경 내역이 비게 됩니다.`);
      this.engine.context.changedCommits = [];
      this.engine.context.revertedCommits = [];
      return { commits: [], reverted: [], duplicates: [] };
    }

    const all = (r.stdout || '').split(RS)
      .filter(rec => rec.trim())
      .map(rec => {
        const f = rec.replace(/^[\r\n]+/, '').split(US);
        return {
          sha: (f[0] || '').trim(),
          short: (f[1] || '').trim(),
          author: (f[2] || '').trim(),
          date: (f[3] || '').trim(),
          subject: (f[4] || '').trim(),
          body: (f[5] || '').trim()
        };
      })
      .filter(c => c.sha);

    // ① Revert 상쇄
    const shas = all.map(c => c.sha);
    const bySha = new Map(all.map(c => [c.sha, c]));
    const cancelled = new Set();
    const reverted = [];

    for (const c of all) {
      const m = /This reverts commit ([0-9a-f]{7,40})\./.exec(c.body);
      if (!m) continue;
      const target = shas.find(sha => sha.startsWith(m[1]));
      if (!target) continue;                       // 범위 밖을 되돌림 - 실제 변경이다
      if (cancelled.has(c.sha) || cancelled.has(target)) continue;
      cancelled.add(c.sha);
      cancelled.add(target);
      reverted.push({
        revert: c.short,
        origin: bySha.get(target).short,
        subject: bySha.get(target).subject
      });
    }

    // ② 같은 제목의 중복. git log 는 최신이 앞이므로 첫 등장(=최신)을 남긴다.
    const seen = new Set();
    const commits = [];
    const duplicates = [];

    for (const c of all) {
      if (cancelled.has(c.sha)) continue;
      if (seen.has(c.subject)) { duplicates.push(c.short); continue; }
      seen.add(c.subject);
      commits.push(c);
    }

    this.engine.context.changedCommits = commits;
    this.engine.context.revertedCommits = reverted;
    this.engine.context.variables.changed_commit_count = commits.length;

    const dropped = [];
    if (duplicates.length) dropped.push(`중복 제목 ${duplicates.length}건`);
    if (reverted.length) dropped.push(`Revert 상쇄 ${reverted.length}쌍`);
    console.log(
      `[GitSyncStage] 커밋 ${commits.length}건` +
      (dropped.length ? ` (제외: ${dropped.join(', ')})` : '') +
      ` / 원본 ${all.length}건`
    );
    for (const c of commits) console.log(`    ${c.short} ${c.subject}`);
    for (const p of reverted) console.log(`    [상쇄] ${p.origin} -> ${p.revert} ${p.subject}`);

    return { commits, reverted, duplicates };
  }
}

module.exports = GitSyncStage;
