const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * 배포 상태 기록 + 실행 락.
 *
 * 젠킨스가 단계를 나눠 부르면(`--only`) 매번 새 프로세스라 메모리 컨텍스트가 끊긴다.
 * `deploy_key` 로 묶어 파일에 남겨야 `changed_static_only` 같은 판정이 다음 단계로 넘어간다.
 * 넘기지 않으면 값이 undefined 가 되고, `unless:` 가 조용히 통과해 전체 빌드가 돈다 — 에러 없이.
 *
 * 락은 상태 JSON 과 **다른 파일**이다. JSON 을 읽고-고치고-쓰는 것은 원자적이지 않아서
 * 두 프로세스가 동시에 "잠기지 않음"을 읽을 수 있다. 락은 O_EXCL(`wx`) 로만 잡는다.
 */

// 단계 사이로 넘길 변수. 전체를 저장하지 않는다 — 자격증명이 섞여 들어가기 때문이다.
const CARRY_KEYS = [
  'git_from', 'git_to', 'has_changes', 'changed_count', 'changed_commit_count', 'changed_static_only',
  'archive_path', 'artifact_path',
  // 라이브를 이미 백업으로 치웠는가. 그룹을 나눠 부르면 프로세스가 새로 뜨는데,
  // 이월하지 않으면 앞 그룹에서 스왑까지 끝낸 배포가 뒤 그룹의 실패로 롤백되지 않는다.
  'rollback_armed',
  // 이 배포가 만든 백업 폴더. **롤백이 읽는 값이다.**
  // 폴더를 훑어 최신을 집는 방식은 그것이 성공한 배포였는지 알 수 없다.
  // 되돌릴 대상을 고르려면 라이브 경로·원격 여부도 함께 있어야 한다.
  'backup_path', 'web_deploy_path', 'deploy_remote', 'iis_site', 'host', 'port'
];

const MAX_CHANGED_FILES = 500;
const MAX_CHANGED_COMMITS = 300;

class DeployState {
  constructor({ statePath, lockPath, keep = 10, ttlMinutes = 60 }) {
    this.statePath = statePath;
    this.lockPath = lockPath;
    this.keep = keep;
    this.ttlMs = ttlMinutes * 60 * 1000;
  }

  // ---------------------------------------------------------------- 파일 입출력

  load() {
    if (!fs.existsSync(this.statePath)) return { version: 1, runs: [] };
    try {
      const doc = JSON.parse(fs.readFileSync(this.statePath, 'utf8').replace(/^﻿/, ''));
      if (!Array.isArray(doc.runs)) doc.runs = [];
      return doc;
    } catch (err) {
      // 깨진 상태파일을 조용히 빈 것으로 취급하면 진행 이력이 사라진 채 새로 시작한다.
      throw new Error(`상태 파일이 올바른 JSON 이 아닙니다: ${this.statePath} - ${err.message}`);
    }
  }

  save(doc) {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    // 도중에 죽어도 반쪽 파일이 남지 않도록 임시파일에 쓰고 바꿔친다.
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
    fs.renameSync(tmp, this.statePath);
  }

  // ---------------------------------------------------------------- 실행 기록

  /** 키로 실행을 찾는다. 없으면 null. */
  find(key) {
    return this.load().runs.find(r => r.key === key) || null;
  }

  /**
   * 실행을 시작하거나 이어받는다.
   * @returns {{ run: object, resumed: boolean }}
   */
  begin({ key, yamlPath, environment, project }) {
    const doc = this.load();
    let run = doc.runs.find(r => r.key === key);
    const resumed = !!run;

    if (run) {
      if (run.environment !== environment) {
        // 다른 환경의 상태를 이어받으면 QA 판정으로 PROD 를 배포하게 된다.
        throw new Error(
          `상태의 environment 가 다릅니다: 기록='${run.environment}' 요청='${environment}' (key=${key})`
        );
      }
      run.updated_at = new Date().toISOString();
      run.status = 'running';
    } else {
      run = {
        key,
        yaml: path.basename(yamlPath),
        project: project || null,
        environment,
        status: 'running',
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        groups: {},
        variables: {},
        changed_files: [],
        changed_files_truncated: 0,
        changed_commits: [],
        changed_commits_truncated: 0,
        reverted_commits: [],
        announced: false,
        cancel_requested: false
      };
      doc.runs.unshift(run);
    }

    this.#prune(doc);
    this.save(doc);
    return { run, resumed };
  }

  /** 스테이지가 만든 값 중 넘겨야 할 것만 추린다. */
  carry(variables) {
    const out = {};
    for (const k of CARRY_KEYS) {
      if (variables[k] !== undefined) out[k] = variables[k];
    }
    return out;
  }

  /** 그룹 실행 결과와 이월 변수를 기록한다. */
  recordGroup(key, group, { status, error, elapsedMs, variables, changedFiles, changedCommits, revertedCommits }) {
    this.#update(key, run => {
      run.groups[group] = {
        status,
        at: new Date().toISOString(),
        elapsed_ms: elapsedMs,
        ...(error ? { error: String(error).slice(0, 500) } : {})
      };
      if (variables) run.variables = { ...run.variables, ...this.carry(variables) };
      if (Array.isArray(changedFiles)) {
        run.changed_files = changedFiles.slice(0, MAX_CHANGED_FILES);
        run.changed_files_truncated = Math.max(0, changedFiles.length - MAX_CHANGED_FILES);
      }
      if (Array.isArray(changedCommits)) {
        // body 는 Revert 판정에만 쓰고 남기지 않는다 — 본문까지 담으면 상태 파일이 부푼다.
        run.changed_commits = changedCommits
          .slice(0, MAX_CHANGED_COMMITS)
          .map(({ sha, short, author, date, subject }) => ({ sha, short, author, date, subject }));
        run.changed_commits_truncated = Math.max(0, changedCommits.length - MAX_CHANGED_COMMITS);
      }
      if (Array.isArray(revertedCommits)) {
        run.reverted_commits = revertedCommits;
      }
    });
  }

  finish(key, status, error) {
    this.#update(key, run => {
      run.status = status;
      if (error) run.error = String(error).slice(0, 500);
      run.finished_at = new Date().toISOString();
    });
  }

  /**
   * 롤백 후보를 최신순으로 돌려준다 — **백업 경로가 남아 있는 성공 배포**만.
   *
   * `--rollback=N` 의 N 은 이 목록의 순번이다(1 = 직전 성공 배포).
   * 소비된 백업(`backup_consumed`)은 빠진다 — 파이프라인 실패로 롤백이 그 폴더를
   * 라이브로 되돌리면서 써버린 것이라, 없는 게 정상이다.
   * 반면 이력에 살아 있는데 폴더가 없으면 **사람이 지운 것**이므로 후보로 두고
   * 고르는 쪽에서 에러를 낸다 — 조용히 다음 것으로 넘어가면 의도보다 더 되돌아간다.
   */
  rollbackCandidates(environment) {
    return this.load().runs.filter(r =>
      r.status === 'success' &&
      r.environment === environment &&
      r.variables && r.variables.backup_path &&
      !r.backup_consumed
    );
  }

  /** 백업이 롤백에 쓰여 사라졌음을 표시한다. */
  markBackupConsumed(key) {
    this.#update(key, run => { run.backup_consumed = true; });
  }

  requestCancel(key) {
    let found = false;
    this.#update(key, run => { run.cancel_requested = true; found = true; });
    return found;
  }

  isCancelRequested(key) {
    const run = this.find(key);
    return !!(run && run.cancel_requested);
  }

  #update(key, fn) {
    const doc = this.load();
    const run = doc.runs.find(r => r.key === key);
    if (!run) return;
    fn(run);
    run.updated_at = new Date().toISOString();
    this.save(doc);
  }

  /**
   * 이력을 줄인다. **성공 이력은 환경별로 센다.**
   *
   *   성공  : 환경마다 keep 건 (이게 롤백 후보 목록이다)
   *   실패  : 환경마다 keep 건 (원인 분석용)
   *   진행중: 개수와 무관하게 남긴다
   *
   * 예전에는 `announced === false` 인 실행을 무조건 남겼는데, **`announced` 를 true 로
   * 만드는 코드가 어디에도 없어서**(2026-09-01 확인) 사실상 아무것도 지워지지 않았다.
   * 죽은 조건이 보관 규칙을 통째로 무력화한 자리다 — 그래서 걷어냈다.
   *
   * 환경별로 세는 이유: dev 배포가 잦아서 전체 개수로 자르면 qa·prod 이력이 밀려난다.
   */
  #prune(doc) {
    const counters = new Map();   // `${environment}:${bucket}` -> 개수
    const kept = [];

    for (const r of doc.runs) {
      if (r.status === 'running') { kept.push(r); continue; }

      const bucket = r.status === 'success' ? 'success' : 'other';
      const slot = `${r.environment}:${bucket}`;
      const used = counters.get(slot) || 0;
      if (used < this.keep) {
        counters.set(slot, used + 1);
        kept.push(r);
      }
    }

    doc.runs = kept;
  }

  // ---------------------------------------------------------------- 락

  readLock() {
    if (!fs.existsSync(this.lockPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
    } catch {
      return { corrupt: true };
    }
  }

  /**
   * 락을 잡는다. 같은 deploy_key 면 재진입으로 통과한다(그룹을 나눠 부르기 때문).
   * @returns {{ acquired: boolean, reentered: boolean }}
   */
  acquireLock({ key, stage, force = false }) {
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });

    const holder = this.readLock();
    if (holder && !holder.corrupt && holder.deploy_key === key) {
      this.#writeLock({ key, stage, acquired_at: holder.acquired_at });
      return { acquired: true, reentered: true };
    }

    if (holder && !force) {
      const reason = this.#staleReason(holder);
      if (!reason) {
        throw new Error(
          `다른 배포가 진행 중입니다.\n` +
          `  key   : ${holder.deploy_key}\n` +
          `  host  : ${holder.host}  pid: ${holder.pid}\n` +
          `  시작  : ${holder.acquired_at}  (stage: ${holder.stage || '-'})\n` +
          `  락파일: ${this.lockPath}\n` +
          `  정말 풀어야 하면 --force-unlock 을 씁니다.`
        );
      }
      console.log(`[lock] 죽은 락으로 판단해 해제합니다 - ${reason}`);
      console.log(`[lock]   이전 보유자: key=${holder.deploy_key} host=${holder.host} pid=${holder.pid}`);
    }

    try { fs.unlinkSync(this.lockPath); } catch { /* 없으면 그만 */ }
    this.#writeLock({ key, stage, acquired_at: new Date().toISOString(), exclusive: true });
    return { acquired: true, reentered: false };
  }

  /**
   * 자동 해제해도 되는 락인지. 해제 가능하면 사유 문자열, 아니면 null.
   *
   * ⚠️ 보유 프로세스의 생존으로 판단하면 안 된다. 그룹을 나눠 부르면
   * (`--only`) 그룹 **사이에는 프로세스가 없다** — 락이 의도적으로 유지되는
   * 바로 그 구간이다. pid 로 판정하면 매번 남의 락을 깬다.
   *
   * 락의 주인은 프로세스가 아니라 **실행(run)** 이다. 상태 파일이 정본이다.
   * TTL 은 해제 조건이 아니라 사람에게 알리는 기준으로만 쓴다.
   */
  #staleReason(holder) {
    if (holder.corrupt) return '락 파일을 읽을 수 없음';
    if (!holder.deploy_key) return '락에 deploy_key 가 없음';

    const run = this.find(holder.deploy_key);
    if (!run) return `보유 키의 실행 기록이 없음 (${holder.deploy_key})`;
    if (run.status !== 'running') return `보유 실행이 이미 '${run.status}' 로 끝남`;

    const age = Date.now() - Date.parse(holder.acquired_at || 0);
    if (Number.isFinite(age) && age > this.ttlMs) {
      const min = Math.round(age / 60000);
      console.log(`[lock] 락이 ${min}분째 유지되고 있습니다. 멈춘 배포라면 --force-unlock 을 쓰십시오.`);
    }
    return null;
  }

  #writeLock({ key, stage, acquired_at, exclusive = false }) {
    const body = JSON.stringify({
      deploy_key: key,
      pid: process.pid,
      host: os.hostname(),
      user: os.userInfo().username,
      acquired_at: acquired_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      stage: stage || null
    }, null, 2);

    if (exclusive) {
      // O_EXCL. 이미 있으면 EEXIST 로 실패한다 — 이것이 원자성의 근거다.
      const fd = fs.openSync(this.lockPath, 'wx');
      try { fs.writeSync(fd, body); } finally { fs.closeSync(fd); }
    } else {
      fs.writeFileSync(this.lockPath, body, 'utf8');
    }
  }

  releaseLock(key, { force = false } = {}) {
    const holder = this.readLock();
    if (!holder) return false;
    if (!force && !holder.corrupt && holder.deploy_key !== key) {
      throw new Error(`다른 실행의 락입니다 (보유: ${holder.deploy_key}). --force-unlock 이 필요합니다.`);
    }
    fs.unlinkSync(this.lockPath);
    return true;
  }
}

/** 젠킨스가 키를 안 넘길 때 쓰는 사람용 키. */
function generateKey(environment) {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const rand = Math.random().toString(16).slice(2, 6);
  return `${environment}-${stamp}-${rand}`;
}

module.exports = { DeployState, generateKey, CARRY_KEYS };
