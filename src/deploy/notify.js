const axios = require('axios');
const https = require('https');

/**
 * 배포 공지 (텔레그램).
 *
 * 기존 젠킨스 `telegram` 잡이 하던 일을 옮긴 것이다. 다른 점은 내용이다 —
 * 기존은 "[QA]서버 배포!" 한 줄이었고, 여기서는 **무엇이 배포됐는지**를 싣는다.
 * 재료(커밋·파일 목록)는 GitSyncStage 가 이미 만들어 상태 파일에 넣어 두었다.
 *
 * 보내는 길은 둘이고, config 의 `telegram.job_name` 이 고른다.
 *   있으면  젠킨스 잡을 호출한다 -> 봇 토큰이 젠킨스 자격증명 안에만 있다
 *   없으면  도구가 텔레그램 API 를 직접 친다 -> 젠킨스 없이도 돈다
 * 문안을 만드는 쪽(buildMessage)은 어느 길이든 같다.
 *
 * **보낼지**는 yaml(target 의 `telegram:`)이, **어떻게 보낼지**는 config 가 정한다.
 * 잡 이름·접속정보·토큰은 서버마다 다른 인프라 정보라 파이프라인 정의에 두지 않는다 —
 * yaml 은 프로젝트를 따라다니고 config 는 서버에 남는다.
 *
 * ⚠️ 목록은 `engine.context` 가 아니라 **상태 파일**에서 읽는다.
 *    젠킨스가 그룹을 나눠 부르면(`--only`) 매번 새 프로세스라 컨텍스트가 비어 있다.
 *    git_check 에서 만든 목록은 deploy 그룹의 메모리에 없다.
 *
 * ⚠️ 전송 실패가 배포를 뒤집지 않는다. 삼키고 경고만 남긴다 —
 *    공지가 안 갔다고 성공한 배포를 실패로 만들 이유가 없다.
 */

const MAX_COMMITS = 20;     // 초과분은 "... 외 N건" 으로 접는다
const MAX_FILES = 30;
const MAX_TEXT = 4000;      // 텔레그램 상한은 4096. 여유를 둔다
const SEP = '======================';

/**
 * 공지 문안을 만든다. 전송과 분리해 둔 것은 `--dry-run` 에서 이것만 찍어 보기 위해서다.
 *
 * parse_mode 를 쓰지 않는다(평문 전송). 커밋 제목에 `_` `*` `{` 같은 문자가 흔한데
 * (`{doc_no:26PTSM00875 }`), 마크다운으로 보내면 텔레그램이 파싱 오류로 **전송 자체를
 * 거절한다.** 서식보다 도착이 중요하다.
 */
function buildMessage({
  tag, environment, status, group, error,
  commits = [], files = [],
  commitsTruncated = 0, filesTruncated = 0,
  gitFrom, gitTo, hasChanges
}) {
  const env = String(environment || '').toUpperCase();
  const head = `[${tag}${env ? `-${env}` : ''}]`;
  const lines = [];

  if (status === 'success') {
    lines.push(`${head} 배포`);
  } else {
    // 실패는 무엇이 언제 깨졌는지가 먼저다. 변경 목록은 그 아래에 참고로 붙인다.
    lines.push(`${head} 배포 실패`);
    if (group) lines.push(`단계: ${group}`);
    if (error) lines.push(`사유: ${String(error).slice(0, 300)}`);
  }

  // 변경이 없으면 목록 두 칸이 빈 채로 나가는데, 그러면 "왜 비었지"를 매번 확인하게 된다.
  // 비었다는 사실 자체를 한 줄로 적는다.
  if (hasChanges === false || (!commits.length && !files.length)) {
    const at = gitTo ? ` (${String(gitTo).slice(0, 9)})` : '';
    lines.push('', `변경 없음${at}`);
    return clamp(lines.join('\n'));
  }

  lines.push('', `변경내용${SEP}`);
  if (commits.length) {
    for (const c of commits.slice(0, MAX_COMMITS)) {
      lines.push(`${c.short || (c.sha || '').slice(0, 9)} ${c.subject || ''}`.trim());
    }
    const rest = Math.max(0, commits.length - MAX_COMMITS) + commitsTruncated;
    if (rest > 0) lines.push(`... 외 ${rest}건`);
  } else {
    lines.push('(커밋 정보 없음)');
  }

  lines.push('', `변경파일${SEP}`);
  if (files.length) {
    for (const f of files.slice(0, MAX_FILES)) lines.push(f);
    const rest = Math.max(0, files.length - MAX_FILES) + filesTruncated;
    if (rest > 0) lines.push(`... 외 ${rest}건`);
  } else {
    lines.push('(변경 파일 없음)');
  }

  return clamp(lines.join('\n'));
}

/** 상한을 넘으면 잘린 사실을 남기고 자른다. 조용히 사라지면 목록이 짧은 줄 안다. */
function clamp(text) {
  if (text.length <= MAX_TEXT) return text;
  const cut = '\n... (메시지가 길어 잘림)';
  return text.slice(0, MAX_TEXT - cut.length) + cut;
}

/** 실제 전송. 실패해도 던지지 않는다 — 호출부가 배포 결과를 뒤집지 않게. */
async function send({ token, chatId, text }) {
  try {
    const res = await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: chatId, text },
      { timeout: 10000 }
    );
    return { ok: true, messageId: res.data && res.data.result && res.data.result.message_id };
  } catch (err) {
    // 텔레그램은 거절 사유를 본문에 담아 준다. 상태코드만으로는 원인을 못 찾는다.
    const detail = err.response && err.response.data
      ? JSON.stringify(err.response.data).slice(0, 300)
      : err.message;
    return { ok: false, error: detail };
  }
}

/**
 * 젠킨스 잡을 거쳐 보낸다. 도착지는 같고, 다른 것은 **토큰이 어디 있느냐**다 —
 * 잡을 쓰면 봇 토큰이 젠킨스 자격증명 안에만 있고 배포 도구는 만지지 않는다.
 *
 * 잡과의 계약은 파라미터 이름 세 개로 고정한다. 새 잡을 만들 때도 이 이름을 쓴다.
 *   TAG_DEPLOY   QA | PROD  — 잡의 choice 목록이다. 목록에 없는 값을 보내면
 *                             젠킨스가 파라미터를 만들지 못하고 500 으로 되튄다
 *   MSG          본문
 *   FILE_PATH    첨부 경로. 배포 공지는 비워 둔다
 *
 * 큐에 들어간 것까지만 확인하고 빌드 결과는 기다리지 않는다 —
 * 공지 하나 때문에 배포를 붙잡아 둘 이유가 없다. 잡 이름 오타·파라미터 불일치는
 * 큐에 넣는 시점(404·500)에 드러나므로 흔한 실패는 여기서 잡힌다.
 */
async function sendViaJenkins({ url, user, token, jobName, tag, text, filePath = '' }) {
  const base = String(url).replace(/\/+$/, '') + '/';
  const common = {
    timeout: 15000,
    headers: { Authorization: 'Basic ' + Buffer.from(`${user}:${token}`).toString('base64') },
    // 자체서명 인증서를 쓰는 젠킨스가 흔하다. 여기서 막히면 공지가 통째로 사라진다.
    httpsAgent: new https.Agent({ rejectUnauthorized: false })
  };

  try {
    // 크럼은 세션에 묶인다. 쿠키를 함께 보내지 않으면 403 No valid crumb 이 난다.
    const extra = {};
    try {
      const c = await axios.get(`${base}crumbIssuer/api/json`, common);
      extra[c.data.crumbRequestField] = c.data.crumb;
      const cookie = (c.headers['set-cookie'] || []).map(v => v.split(';')[0]).join('; ');
      if (cookie) extra.Cookie = cookie;
    } catch {
      // 크럼을 끈 젠킨스도 있다. 없으면 없는 대로 보낸다 - 정말 필요하면 다음 요청이 403 으로 답한다.
    }

    // URLSearchParams 가 UTF-8 로 퍼센트 인코딩한다. 한글 본문이 그대로 간다.
    const form = new URLSearchParams({ TAG_DEPLOY: tag, MSG: text, FILE_PATH: filePath });
    const res = await axios.post(
      `${base}job/${encodeURIComponent(jobName)}/buildWithParameters`,
      form.toString(),
      {
        ...common,
        headers: {
          ...common.headers, ...extra,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
        }
      }
    );
    // 큐 적재는 201 Created 다. 200 이 오면 로그인 화면 등 다른 것을 받은 것이다.
    if (res.status !== 201) return { ok: false, error: `예상과 다른 응답 HTTP ${res.status}` };
    return { ok: true, queue: res.headers.location };
  } catch (err) {
    const detail = err.response
      ? `HTTP ${err.response.status} ${String(err.response.statusText || '')}`.trim()
      : err.message;
    return { ok: false, error: detail };
  }
}

/**
 * 설정 로더는 값이 없는 `${env.X}` 를 **원문 그대로 남긴다**(config/index.js expandEnv).
 * 비어 있지 않으니 존재 검사는 통과하고, 그 문자열이 토큰인 척 전송에 실려 나간다.
 * 여기서 걸러야 "켜 뒀는데 안 온다"가 이유와 함께 로그에 남는다.
 */
function missing(value) {
  return !value || (typeof value === 'string' && value.includes('${env.'));
}

/**
 * 잡을 부를 젠킨스 접속정보. config 의 `jenkins` 블록(URL·USER·API_TOKEN)을 쓴다.
 * 다른 서버의 잡을 부르려면 telegram.job_server 에 블록 이름을 적는다 (예: "jenkins_dev").
 */
function resolveJenkins(engine, cfg) {
  const name = cfg.job_server || 'jenkins';
  const jk = (engine.config && engine.config.get) ? (engine.config.get(name, null) || {}) : {};
  if (missing(jk.URL) || missing(jk.USER) || missing(jk.API_TOKEN)) {
    return { error: `config 의 '${name}' 블록에 URL·USER·API_TOKEN 이 필요합니다 (telegram.job_name 을 쓸 때).` };
  }
  return { url: jk.URL, user: jk.USER, token: jk.API_TOKEN };
}

/**
 * 잡의 TAG_DEPLOY 로 넘길 값. 잡의 choice 는 QA·PROD 둘뿐이라
 * dev 를 포함한 나머지 환경은 QA 로 접는다 — 목록에 없는 값은 젠킨스가 거절한다.
 * 어느 환경인지는 본문 머리말(`[WESYS-QA]`)이 이미 정확히 말해 준다.
 */
function resolveDeployTag(environment) {
  return String(environment || '').toLowerCase() === 'prod' ? 'PROD' : 'QA';
}

/**
 * 파이프라인 종료 시점에 호출한다.
 *
 * 부르는 자리가 스테이지가 아닌 이유 — 실패하면 스테이지 목록을 끝까지 돌지 않는다.
 * 특히 라이브를 건드리기 전에 깨지면(빌드 실패 등) 롤백조차 돌지 않아서,
 * `rollback:` 에 넣어 두어도 그런 실패는 영영 공지되지 않는다.
 */
async function announce(engine, { state, key, status, group, error, dryRun }) {
  const vars = engine.context.variables || {};

  // 스위치는 yaml 이 쥔다. target 의 `telegram: true/false` 를 그대로 쓴다.
  if (String(vars.telegram).toLowerCase() !== 'true') return;

  const cfg = (engine.config && engine.config.get)
    ? (engine.config.get('telegram', null) || {})
    : {};

  // 길을 고르는 것은 config 다. 잡 이름이 있으면 젠킨스를 거친다.
  const jobName = missing(cfg.job_name) ? null : cfg.job_name;

  // 상태 파일이 목록의 정본이다. 없을 때만 컨텍스트로 물러선다(단일 프로세스 실행).
  const run = (state && key) ? state.find(key) : null;
  const commits = (run && run.changed_commits) || engine.context.changedCommits || [];
  const files = (run && run.changed_files) || engine.context.changedFiles || [];

  const text = buildMessage({
    tag: resolveTag(engine),
    environment: engine.context.environment,
    status, group, error,
    commits, files,
    commitsTruncated: (run && run.changed_commits_truncated) || 0,
    filesTruncated: (run && run.changed_files_truncated) || 0,
    gitFrom: vars.git_from,
    gitTo: vars.git_to,
    hasChanges: vars.has_changes
  });

  const via = jobName ? `젠킨스 잡 '${jobName}'` : '텔레그램 API 직접';

  if (dryRun) {
    console.log(`\n[Notify] --dry-run: ${via} 경로. 아래 내용을 보내지 않고 출력만 합니다.`);
    console.log('----------------------------------------');
    console.log(text);
    console.log('----------------------------------------');
    return;
  }

  // 그룹을 나눠 부르면 같은 실행을 여러 번 종료 처리하게 된다. 한 번만 보낸다.
  if (run && run.announced) {
    console.log(`[Notify] 이미 공지된 실행입니다 (key=${key}).`);
    return;
  }

  // 설정이 없다고 배포를 실패시키지 않는다. 다만 조용히 넘기지도 않는다 —
  // "켜 두었는데 안 온다" 를 로그에서 바로 찾을 수 있어야 한다.
  let r;
  if (jobName) {
    const jk = resolveJenkins(engine, cfg);
    if (jk.error) {
      console.log(`[Notify] ${jk.error}`);
      return;
    }
    r = await sendViaJenkins({
      ...jk, jobName, text,
      tag: resolveDeployTag(engine.context.environment)
    });
    if (r.ok) console.log(`[Notify] ${via} 호출 완료.${r.queue ? ` (${r.queue})` : ''}`);
  } else {
    if (missing(cfg.token) || missing(cfg.chat_id)) {
      console.log(`[Notify] telegram 설정이 없어 공지를 건너뜁니다 ` +
        `(config/<project>.json 의 telegram.token / telegram.chat_id).`);
      return;
    }
    r = await send({ token: cfg.token, chatId: cfg.chat_id, text });
    if (r.ok) console.log(`[Notify] 텔레그램 전송 완료.`);
  }

  if (r.ok) {
    if (state && key) state.markAnnounced(key);
  } else {
    console.log(`[Notify] 경고: 공지 전송 실패 (${via}) - ${r.error}`);
  }
}

/**
 * `[WESYS-QA]` 의 앞부분.
 *   1) yaml 의 notify_tag
 *   2) 없으면 project 를 대문자로
 * 프로젝트 키(`hlngs`)와 부르는 이름(`WESYS`)이 다른 경우가 있어 별도 값을 둔다.
 */
function resolveTag(engine) {
  const vars = engine.context.variables || {};
  return vars.notify_tag || String(vars.project || engine.context.project || 'DEPLOY').toUpperCase();
}

module.exports = {
  announce, buildMessage, send, sendViaJenkins, resolveDeployTag,
  MAX_COMMITS, MAX_FILES, MAX_TEXT
};
