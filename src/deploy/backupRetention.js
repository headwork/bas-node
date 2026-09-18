const fs = require('fs');
const path = require('path');

// 보관 기본값. 개수 기준이다 — 날짜 기준은 하루에 몇 번 배포하느냐에 따라
// 차지하는 용량이 몇 배로 달라져서 상한이 안 잡힌다(1회 690MB).
const DEFAULTS = {
  enabled: true,
  keep_count: 3,           // 최근 성공 배포 N건의 백업만 남긴다
  dry_run: false           // true 면 삭제 대상만 출력하고 실제로 지우지 않음
};

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 백업 폴더 이름 규칙: `<라이브폴더명>_<YYYYMMDD_HHMMSS>[_N]`
 *
 * 사람이 읽을 수 있어야 한다 — 긴급 배포 때 **사람이 고르는 폴더**다.
 * `_backup_` 은 넣지 않는다. 상위가 이미 백업 폴더(`backup_root`)라 중복이다.
 *
 * ⚠️ **시각은 14자리 형식만 받는다.** 표식(`_backup_`)이 빠졌으므로 숫자만 보고
 *    고르게 되는데, 옛 epoch 형식(`\d{10,}`)까지 받으면 다른 도구의 운영 일일 백업
 *    `MFM.Shore_2026091712`(10자리)가 **삭제 대상에 걸린다.** 옛 형식(`_backup_`·epoch)은
 *    인식하지 않는다 — 자동 정리 대상에서 빠질 뿐 지워지지 않는다(사람이 정리한다).
 *
 * `_N` 은 `uniquePath` 가 같은 초의 충돌을 비켜 간 이름이다. 빠뜨리면 그 백업이
 * 정리에도 롤백 목록에도 안 잡힌다.
 *
 * 대소문자는 구분한다. 넓히면 `MFM.SHORE` 와 `MFM.Shore` 가 서로를 지울 수 있다.
 */
function backupPatternFor(deployPath) {
  const base = path.basename(deployPath);
  return new RegExp('^' + escapeRegExp(base) + '_(\\d{8}_\\d{6})(?:_(\\d+))?$');
}

/**
 * 롤백이 **라이브 옆에** 남긴 폴더의 이름 규칙.
 *
 *   `<라이브>_failed_<시각>`    배포중 롤백(consume)이 치운 실패본
 *   `<라이브>_replaced_<시각>`  강제 롤백(copy)이 지우지 못한 옛 라이브 (정상이면 스크립트가 바로 지운다)
 *
 * 둘 다 **다음 배포가 성공하면** 지운다. 실패본은 원인을 볼 때까지만 의미가 있고,
 * 성공한 배포가 나왔다는 것은 그 실패가 지나갔다는 뜻이다. 앞으로 갈 사본은
 * 배포 zip 이지 이 폴더가 아니다.
 *
 * 백업 규칙과 같은 이유로 대소문자를 구분하고, 라이브 이름 뒤에 표식이 바로 와야 한다 —
 * `MFM.SHORE` 의 정리가 `MFM.SHORE_QA_failed_…` 를 지우면 안 된다.
 */
function leftoverPatternFor(deployPath) {
  const base = path.basename(deployPath);
  return new RegExp('^' + escapeRegExp(base) + '_(?:failed|replaced)_\\d{8}_\\d{6}(?:_\\d+)?$');
}

/** 이름 목록에서 롤백 잔여 폴더만 고른다. 원격도 이 함수를 쓴다(목록만 ssh 로 받는다). */
function selectLeftovers(names, deployPath) {
  const pattern = leftoverPatternFor(deployPath);
  return names.filter(name => pattern.test(name)).sort();
}

/**
 * 라이브 옆의 롤백 잔여 폴더를 지운다. **배포가 성공한 뒤에만** 부른다.
 *
 * 백업 보관 정책(`backup`)의 `enabled:false`·`dry_run` 을 그대로 따른다 —
 * "자동으로 지우지 마라" 는 설정이 폴더 종류마다 따로 있으면 한쪽을 빠뜨린다.
 * 지우지 못한 것은 배포 성공을 뒤집지 않는다.
 */
function removeLeftovers(deployPath, config, logger = console) {
  const opts = { ...DEFAULTS, ...(config || {}) };
  const parentDir = path.dirname(deployPath);
  if (opts.enabled === false || !fs.existsSync(parentDir)) return { removed: [], failed: [] };

  const dirs = fs.readdirSync(parentDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);
  const targets = selectLeftovers(dirs, deployPath);
  const removed = [];
  const failed = [];

  for (const name of targets) {
    if (opts.dry_run) {
      logger.log(`  [dry-run] would remove ${name}`);
      continue;
    }
    try {
      fs.rmSync(path.join(parentDir, name), { recursive: true, force: true });
      logger.log(`  [remove] ${name}`);
      removed.push(name);
    } catch (err) {
      logger.error(`  [FAILED] ${name}: ${err.message}`);
      failed.push({ name, error: err.message });
    }
  }

  return { removed, failed };
}

/** 백업 폴더 이름. 배포·롤백 네 곳이 같은 식을 들고 있지 않도록 여기서만 만든다. */
function backupName(deployPath, stamp = stampNow()) {
  return `${path.basename(deployPath)}_${stamp}`;
}

/** 백업 폴더 이름에 쓰는 시각 문자열. 사전순 정렬이 곧 시간순이다. */
function stampNow(date = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}_` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/**
 * 아직 안 쓰인 경로를 고른다. 이미 있으면 `_2`, `_3` … 을 붙인다.
 *
 * ⚠️ 타임스탬프는 **초 단위**다. 배포와 강제 롤백이 같은 초에 일어나면 이름이 겹친다 —
 *    드물지만 자동화에서는 실제로 난다. 그때 스크립트는 `1` 로 거부하고(옳다.
 *    move 는 기존 폴더 **안으로** 들어가 성공한 것처럼 보인다), 롤백이 통째로 막힌다.
 *
 * 예전 `FsRenameStage` 는 반대로 **기존 대상을 지우고** 덮어썼다. 그쪽이 더 나쁘다 —
 * 겹친 상대가 멀쩡한 백업이면 그것을 지운다. 이름을 비켜 가는 것이 옳다.
 */
function uniquePath(candidate, exists = fs.existsSync) {
  if (!exists(candidate)) return candidate;
  for (let n = 2; n < 1000; n++) {
    const next = `${candidate}_${n}`;
    if (!exists(next)) return next;
  }
  throw new Error(`이름이 겹치지 않는 경로를 찾지 못했습니다: ${candidate}`);
}

/** `YYYYMMDD_HHMMSS` 를 정렬 가능한 수로 바꾼다. 형식이 아니면 null. */
function parseStamp(raw) {
  const m = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(raw);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
}

/** 이름 목록에서 규칙에 맞는 것만 골라 최신순으로. 같은 초면 `_N` 이 큰 쪽이 나중이다. */
function matchBackups(names, deployPath, toPath) {
  const pattern = backupPatternFor(deployPath);
  const result = [];

  for (const name of names) {
    const matched = pattern.exec(name);
    if (!matched) continue;
    const timestamp = parseStamp(matched[1]);
    if (timestamp === null) continue;
    result.push({ name, path: toPath(name), timestamp, seq: Number(matched[2] || 1) });
  }

  return result.sort((a, b) => (b.timestamp - a.timestamp) || (b.seq - a.seq));
}

/**
 * 백업 디렉터리를 골라 온다. 최신순(내림차순) 정렬.
 *
 * @param deployPath 라이브 폴더 경로 (이름 규칙의 기준)
 * @param backupRoot 백업이 모이는 폴더. 생략하면 라이브의 부모 폴더
 */
function listBackups(deployPath, backupRoot) {
  const parentDir = backupRoot || path.dirname(deployPath);
  if (!fs.existsSync(parentDir)) return [];

  const dirs = fs.readdirSync(parentDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);
  return matchBackups(dirs, deployPath, name => path.join(parentDir, name));
}

/** 원격에서 받은 이름 목록에 같은 규칙을 적용한다. 파일시스템을 읽지 않는다. */
function selectFromNames(names, deployPath, backupRoot, config) {
  const backups = matchBackups(names, deployPath, name => `${backupRoot}\\${name}`);
  return selectBackups(backups, new Date(), config);
}

/**
 * 보관/삭제 대상을 가른다. 부수효과 없는 순수 함수 — 정책만 담는다.
 * 원격 정리도 이 함수를 쓴다(목록만 ssh 로 받아 온다).
 *
 * 보관 규칙: 최신 keep_count 건만 남기고 나머지는 삭제.
 * 이 개수가 곧 `--rollback=N` 의 N 상한이다 — 남기지 않은 것은 되돌릴 수 없다.
 */
function selectBackups(backups, now, config) {
  const opts = { ...DEFAULTS, ...(config || {}) };
  const count = Math.max(0, Number(opts.keep_count) || 0);

  const keep = backups.slice(0, count).map((b, i) => ({ ...b, reason: `recent #${i + 1}` }));
  const remove = backups.slice(count);

  return { keep, remove };
}

/**
 * 보관 정책을 실제로 적용한다.
 * 살아 있는 배포 경로는 어떤 경우에도 삭제 대상이 되지 않는다.
 */
function applyRetention(deployPath, config, logger = console, backupRoot) {
  const opts = { ...DEFAULTS, ...(config || {}) };

  if (opts.enabled === false) {
    logger.log(`[BackupRetention] Disabled by configuration. Skipping.`);
    return { keep: [], removed: [], failed: [] };
  }

  const backups = listBackups(deployPath, backupRoot);
  if (backups.length === 0) {
    logger.log(`[BackupRetention] No backup directories found for ${deployPath}.`);
    return { keep: [], removed: [], failed: [] };
  }

  const { keep, remove } = selectBackups(backups, new Date(), opts);

  logger.log(`[BackupRetention] Policy: keep_count=${opts.keep_count}, dry_run=${!!opts.dry_run}`);
  logger.log(`[BackupRetention] Found ${backups.length} backup(s): keep ${keep.length}, remove ${remove.length}`);
  for (const item of keep) {
    logger.log(`  [keep]   ${item.name}  (${item.reason})`);
  }

  const livePath = path.resolve(deployPath);
  const removed = [];
  const failed = [];

  for (const item of remove) {
    // 방어: 살아 있는 배포 경로와 겹치면 절대 지우지 않는다.
    if (path.resolve(item.path) === livePath) {
      logger.error(`  [SKIP]   ${item.name} resolves to the live deploy path. Refusing to delete.`);
      continue;
    }

    if (opts.dry_run) {
      logger.log(`  [dry-run] would remove ${item.name}`);
      continue;
    }

    try {
      fs.rmSync(item.path, { recursive: true, force: true });
      logger.log(`  [remove] ${item.name}`);
      removed.push(item.name);
    } catch (err) {
      // 보관 정리 실패가 배포 성공을 뒤집지는 않는다. 남기고 넘어간다.
      logger.error(`  [FAILED] ${item.name}: ${err.message}`);
      failed.push({ name: item.name, error: err.message });
    }
  }

  return { keep, removed, failed };
}

module.exports = {
  DEFAULTS,
  backupPatternFor,
  leftoverPatternFor,
  selectLeftovers,
  removeLeftovers,
  backupName,
  stampNow,
  uniquePath,
  parseStamp,
  listBackups,
  selectFromNames,
  selectBackups,
  applyRetention
};
