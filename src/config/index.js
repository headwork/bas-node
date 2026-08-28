const fs = require('fs');
const path = require('path');

/**
 * 범용 설정 로더.
 *
 *   config/
 *     app.json          공통 + 프로젝트 목록  { "projects": ["hlngs"] }
 *     <project>.json    프로젝트별 확장정보
 *
 * app.json 위에 <project>.json 을 덮는다. 값 안의 `${env.VAR}` 는 환경변수로 치환한다.
 *
 * 기존 src/util/common.js 의 설정 기구와 세 가지가 다르다.
 *   - import 시점에 아무것도 하지 않는다 (명시적으로 loadConfig 를 부른다)
 *   - Node 의 global 을 건드리지 않는다
 *   - 파일 없음·파싱 실패를 조용히 넘기지 않는다
 */

const APP_FILE = 'app.json';

/**
 * 설정 폴더를 찾는다. cwd 에 기대지 않는다 —
 * 런처가 cd 를 하거나 젠킨스가 다른 위치에서 부를 수 있기 때문이다.
 */
function resolveConfigDir(explicit) {
  // 번들과 소스는 __dirname 이 다르다.
  //   번들: <bundle>/bas-deploy.js  -> __dirname = <bundle>
  //   소스: <repo>/src/config/      -> __dirname = <repo>/src/config
  // 양쪽을 모두 후보에 넣는다. 하나만 넣으면 다른 쪽에서 설정을 통째로 못 찾는다.
  const candidates = [
    explicit,
    process.env.BAS_CONFIG_DIR,
    path.join(__dirname, 'config'),                     // 번들: <bundle>/config
    path.join(__dirname, '..', 'config'),
    path.join(__dirname, '..', '..', 'config'),
    path.join(__dirname, '..', '..', 'dist', 'config'), // 소스: <repo>/dist/config
    path.join(process.cwd(), 'config'),
  ].filter(Boolean);

  // app.json 이 아니라 폴더 존재로 판정한다.
  // app.json 은 git 추적 대상이 아니라 신규 클론에는 없을 수 있다 —
  // 그것을 기준으로 삼으면 설정 폴더를 통째로 못 찾는다.
  for (const dir of candidates) {
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return path.resolve(dir);
  }

  throw new Error(
    `설정 폴더를 찾지 못했습니다. 찾아본 경로:\n  ` +
    candidates.map(c => path.resolve(c)).join('\n  ') +
    `\n  BAS_CONFIG_DIR 환경변수나 --config-dir 로 지정할 수 있습니다.`
  );
}

function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`설정 파일을 읽지 못했습니다: ${file} - ${err.message}`);
  }

  // BOM 을 떼고 파싱한다. 편집기가 붙인 BOM 때문에 파싱이 깨지는 일이 잦다.
  try {
    return JSON.parse(raw.replace(/^﻿/, ''));
  } catch (err) {
    // 조용히 기본값으로 흘러가면 잘못된 설정으로 서비스가 뜬다. 여기서 멈춘다.
    throw new Error(`설정 파일이 올바른 JSON 이 아닙니다: ${file} - ${err.message}`);
  }
}

/** 문자열 안의 `${env.VAR}` 를 환경변수로 바꾼다. 값이 없으면 원문을 남긴다. */
function expandEnv(value) {
  if (typeof value === 'string') {
    return value.replace(/\$\{env\.([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name) => {
      const v = process.env[name];
      return v === undefined ? whole : v;
    });
  }
  if (Array.isArray(value)) return value.map(expandEnv);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandEnv(v);
    return out;
  }
  return value;
}

/** 얕지 않게 병합한다. 뒤가 앞을 덮되, 객체끼리는 키 단위로 합친다. */
function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(over)) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? merge(out[k], v) : v;
  }
  return out;
}

/**
 * @param {object}  opts
 * @param {string} [opts.project]    프로젝트 이름. 생략하면 app.json 이 결정한다.
 * @param {string} [opts.configDir]  설정 폴더 직접 지정
 */
function loadConfig(opts = {}) {
  const dir = resolveConfigDir(opts.configDir);

  // app.json 은 있으면 공통 기본값으로 깔고, 없어도 진행한다.
  const appFile = path.join(dir, APP_FILE);
  const app = fs.existsSync(appFile) ? readJson(appFile) : {};

  const projects = Array.isArray(app.projects) ? app.projects : [];
  const project = opts.project || app.defaultProject || (projects.length === 1 ? projects[0] : null);

  if (!project) {
    // 임의로 고르지 않는다. 잘못 고르면 다른 시스템 설정으로 배포한다.
    throw new Error(
      `프로젝트를 지정해야 합니다. YAML 의 project 키를 쓰십시오. 예) project: "hlngs"` +
      (projects.length ? `\n  ${APP_FILE} 에 등록된 프로젝트: ${projects.join(', ')}` : '')
    );
  }

  // app.json 에 목록이 있을 때만 소속을 검사한다. 목록이 없으면 yaml 의 선언을 믿는다.
  if (projects.length > 0 && !projects.includes(project)) {
    throw new Error(`등록되지 않은 프로젝트입니다: '${project}'. 등록된 프로젝트: ${projects.join(', ')}`);
  }

  const projectFile = path.join(dir, `${project}.json`);
  if (!fs.existsSync(projectFile)) {
    // projects 에 이름은 있는데 파일이 없다. 조용히 넘기면 기본값으로 도는데 아무도 모른다.
    throw new Error(`프로젝트 설정 파일이 없습니다: ${projectFile}`);
  }

  const merged = expandEnv(merge(app, readJson(projectFile)));

  // 어느 파일이 먹었는지 남긴다. 이게 없으면 "설정을 고쳤는데 반영이 안 된다"를 추적할 수 없다.
  console.log(`[config] dir=${dir} project=${project}`);

  return {
    dir,
    project,
    values: merged,
    /** get('deploy.state_path', 기본값) */
    get(keyPath, fallback) {
      const found = keyPath.split('.').reduce((o, k) => (o == null ? undefined : o[k]), merged);
      return found === undefined ? fallback : found;
    },
  };
}

/**
 * 배포 상태파일 경로를 결정한다.
 *
 *   1) deploy.state_path 설정값
 *   2) 없으면 <번들 폴더>/_state/<yaml 파일명>.json
 *
 * cwd 기준 상대경로를 기본값으로 쓰지 않는다 — 런처가 cd 를 하기 때문에
 * 실행 위치에 따라 다른 자리에 상태가 쌓인다.
 */
function resolveStatePath(config, yamlPath) {
  const base = path.basename(yamlPath).replace(/\.(ya?ml)$/i, '') + '.json';
  const configured = config.get('deploy.state_path');

  if (!configured) {
    return path.join(path.resolve(config.dir, '..'), '_state', base);
  }

  // 설정값은 파일로도 폴더로도 쓴다. 폴더면 yaml 이름을 붙인다.
  // 폴더를 파일 경로로 오인하면 쓰기 시점에 EISDIR 로 죽는데, 그때는
  // 이미 배포가 진행된 뒤라 늦다. 여기서 가른다.
  const resolved = path.resolve(configured);
  const looksLikeDir =
    /[\\/]$/.test(configured) ||
    path.extname(resolved) === '' ||
    (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory());

  return looksLikeDir ? path.join(resolved, base) : resolved;
}

module.exports = { loadConfig, resolveConfigDir, resolveStatePath, expandEnv, merge };
