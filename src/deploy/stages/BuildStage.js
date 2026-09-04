const BaseStage = require('./BaseStage');
const fs = require('fs');
const path = require('path');

/**
 * 빌드 단계. **언어를 가리지 않는다** — 무엇으로 짓는지는 `build_cmd` 가 정한다.
 * dotnet 이든 gradle 이든 python 이든 이 스테이지에는 명령 문자열일 뿐이다.
 *
 * 소스와 산출물이 다른 자리에 있다.
 *   source_path   : git 체크아웃
 *   build_cwd     : 명령을 돌릴 위치 (보통 소스 아래의 프로젝트 폴더)
 *   build_cmd     : 실행할 명령. 길어지면 스크립트 파일로 빼고 그것을 부른다
 *   build_path    : 산출물이 쌓이는 곳
 *
 * 이 스테이지가 하는 일은 둘뿐이다.
 *   1. build_cmd 를 build_cwd 에서 돌린다
 *   2. **산출물이 실제로 갱신됐는지 확인한다** (성공 신호를 액면가로 받지 않는다)
 *
 * 게시 프로파일(.NET 의 pubxml) 설치는 **여기 없다.** 그건 .NET 만의 사정이라
 * 빌드 스크립트가 한다 — 스테이지가 알면 언어가 하나 늘 때마다 여기가 늘어난다.
 * yaml 은 `build_profile` 을 build_cmd 의 인자로 넘길 뿐이다.
 */
class BuildStage extends BaseStage {
  async execute(stageConfig, basePath) {
    const vars = this.engine.context.variables;
    const pick = (key) => stageConfig[key] !== undefined ? stageConfig[key] : vars[key];

    const sourcePath = pick('source_path');
    const buildPath = pick('build_path');

    // 명령을 돌릴 위치. cwd > build_cwd(변수) > source_path > build_path 순.
    // 소스와 산출물이 갈린 뒤로 build_path 에서 도는 것은 틀렸다 — 거기엔 .csproj 가 없다.
    //
    // 빌드 명령·작업폴더는 **빌드서버 블록**에 둔다(`build_cwd`·`build_cmd`).
    // "이 서버에서 이 프로젝트를 어떻게 짓는가"는 환경이 아니라 빌드축이라,
    // target 세 곳에 같은 문자열을 복사하면 한 곳만 고쳐지는 날이 온다.
    const cwd = stageConfig.cwd || pick('build_cwd') || sourcePath || buildPath;

    if (!cwd) {
      throw new Error("BuildStage requires 'build_cwd' (또는 'source_path' / 'build_path').");
    }
    if (!fs.existsSync(cwd)) {
      throw new Error(`빌드 경로가 없습니다: ${cwd}`);
    }

    // 스테이지 진입 전에 이미 한 번 치환됐지만, 변수에서 온 build_cmd 는 그때
    // 대상이 아니었다. 여기서 한 번 더 돌린다.
    const buildCmd = this.engine.interpolate(stageConfig.cmd || pick('build_cmd') || 'dotnet build -c Release');

    if (/\$\{[A-Za-z0-9_]+\}/.test(buildCmd)) {
      // 치환되지 않은 자리가 남았다. 그대로 실행하면 셸이 이상한 인자를 받는다.
      throw new Error(`빌드 명령에 해석되지 않은 변수가 있습니다: ${buildCmd}`);
    }

    if (buildPath && !fs.existsSync(buildPath)) {
      fs.mkdirSync(buildPath, { recursive: true });
      console.log(`[BuildStage] 산출물 폴더를 만들었습니다: ${buildPath}`);
    }

    console.log(`\n[BuildStage] Starting build process...`);
    if (sourcePath) console.log(`- Source Path : ${sourcePath}`);
    console.log(`- Working Dir : ${cwd}`);
    if (buildPath) console.log(`- Output Path : ${buildPath}`);
    console.log(`- Command     : ${buildCmd}`);

    const startedAt = Date.now();
    this.engine.runCommand(buildCmd, cwd);

    if (buildPath) this.#verifyOutput(buildPath, startedAt);

    // 산출물에서 빼야 할 것을 지운다. 설정 파일이 그 대상이다 —
    // 소스의 appsettings.json 에는 DB·SMTP 비밀번호가 들어 있고, 그대로 배포하면
    // 서버 설정을 덮는다. 여기서 지우면 **서버까지 가지도 않는다.**
    // 라이브 설정은 배포 스테이지가 preserve_config 로 옮긴다.
    const exclude = stageConfig.exclude || this.engine.context.exclude || [];
    if (buildPath && exclude.length > 0) this.#applyExclude(buildPath, exclude);

    console.log(`[BuildStage] Build completed successfully.`);
  }

  /**
   * 산출물 루트에서 패턴에 맞는 파일을 지운다.
   *
   * **하위 폴더는 훑지 않는다.** 규칙이 단순해야 무엇이 지워질지 예측할 수 있고,
   * 산출물 깊은 곳까지 글롭으로 지우는 것은 사고의 지름길이다.
   */
  #applyExclude(buildPath, patterns) {
    // ⚠️ 여기는 이 도구에서 **파일을 지우는 유일한 자리**다. 산출물 폴더라 다시 만들어지지만,
    //    build_path 를 라이브 폴더로 잘못 적으면 서비스 중인 설정을 지운다.
    //    두 경로가 같은 일은 이 파이프라인에 없다(라이브는 rename 으로 갈아끼운다).
    const livePath = this.engine.context.variables.web_deploy_path;
    if (livePath && path.resolve(livePath) === path.resolve(buildPath)) {
      throw new Error(
        `build_path 가 라이브 폴더와 같습니다. exclude 를 실행하지 않습니다: ${buildPath}\n` +
        `  산출물 폴더(build_path)와 배포 폴더(web_deploy_path)는 달라야 합니다.`
      );
    }

    console.log(`[BuildStage] 산출물에서 제외 (${patterns.length}개 패턴)`);

    const entries = fs.readdirSync(buildPath, { withFileTypes: true })
      .filter(e => e.isFile())
      .map(e => e.name);

    for (const pattern of patterns) {
      const re = globToRegExp(pattern);
      const matched = entries.filter(name => re.test(name));

      if (matched.length === 0) {
        // 프로젝트마다 있는 파일이 다르다. 없는 것은 실패가 아니다.
        console.log(`  [exclude] ${pattern} - 해당 없음`);
        continue;
      }

      for (const name of matched) {
        fs.rmSync(path.join(buildPath, name), { force: true });
        console.log(`  [exclude] ${name}`);
      }
    }
  }

  /**
   * 산출물이 실제로 갱신됐는지 확인한다.
   *
   * 게시가 조용히 건너뛰어져도 exit 0 으로 끝나는 경우가 있다(위 NETSDK1198).
   * 그대로 두면 **옛 배포본이 새것인 척 배포된다.** 빌드 시작 이후에 쓰인 파일이
   * 하나도 없으면 그것을 실패로 본다.
   */
  #verifyOutput(buildPath, startedAt) {
    if (!fs.existsSync(buildPath)) {
      throw new Error(`빌드가 끝났는데 산출물 폴더가 없습니다: ${buildPath}`);
    }

    const newest = this.#newestMtime(buildPath, 0);
    if (newest === 0) {
      throw new Error(`산출물 폴더가 비어 있습니다: ${buildPath}`);
    }

    // 파일시스템 시각 해상도와 시계 오차를 감안해 5초 여유를 둔다.
    if (newest < startedAt - 5000) {
      throw new Error(
        `빌드는 성공했지만 산출물이 갱신되지 않았습니다: ${buildPath}\n` +
        `  가장 최근 파일: ${new Date(newest).toISOString()} (빌드 시작: ${new Date(startedAt).toISOString()})\n` +
        `  게시가 건너뛰어졌을 수 있습니다. 로그에서 NETSDK1198(게시 프로필을 찾을 수 없음)을 확인하십시오.`
      );
    }

    console.log(`[BuildStage] 산출물 확인됨 (최종 수정 ${new Date(newest).toLocaleString()})`);
  }

  /** 하위를 훑어 가장 최근 수정시각을 찾는다. 깊이를 제한해 비용을 묶는다. */
  #newestMtime(dir, depth) {
    if (depth > 3) return 0;
    let newest = 0;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          newest = Math.max(newest, this.#newestMtime(full, depth + 1));
        } else {
          newest = Math.max(newest, fs.statSync(full).mtimeMs);
        }
      } catch { /* 접근 불가 항목은 건너뛴다 */ }
    }
    return newest;
  }
}

/** 글롭 하나를 정규식으로. `*` 와 `?` 만 받는다 — 그 이상은 필요한 적이 없었다. */
function globToRegExp(pattern) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');   // 윈도우 파일명은 대소문자를 안 가린다
}

module.exports = BuildStage;
