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
 * 백업 폴더 이름 규칙: `<라이브폴더명>_backup_<YYYYMMDD_HHMMSS>`
 *
 * 사람이 읽을 수 있어야 한다 — 긴급 배포 때 **사람이 고르는 폴더**다.
 * 옛 형식(epoch 밀리초)도 계속 인식한다. 안 그러면 이미 쌓인 백업이 고아가 되어
 * 정리도 롤백도 닿지 않는다.
 */
function backupPatternFor(deployPath) {
  const base = path.basename(deployPath);
  return new RegExp('^' + escapeRegExp(base) + '_backup_(\\d{8}_\\d{6}|\\d{10,})$');
}

/** 백업 폴더 이름에 쓰는 시각 문자열. 사전순 정렬이 곧 시간순이다. */
function stampNow(date = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}_` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** 두 형식(YYYYMMDD_HHMMSS · epoch 밀리초) 모두 정렬 가능한 수로 바꾼다. */
function parseStamp(raw) {
  const m = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(raw);
  if (m) {
    const [, y, mo, d, h, mi, s] = m;
    return new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
  }
  const epoch = Number(raw);
  return Number.isFinite(epoch) && epoch > 0 ? epoch : null;
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

  const pattern = backupPatternFor(deployPath);
  const result = [];

  for (const entry of fs.readdirSync(parentDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const matched = pattern.exec(entry.name);
    if (!matched) continue;

    const timestamp = parseStamp(matched[1]);
    if (timestamp === null) continue;

    result.push({
      name: entry.name,
      path: path.join(parentDir, entry.name),
      timestamp
    });
  }

  return result.sort((a, b) => b.timestamp - a.timestamp);
}

/** 원격에서 받은 이름 목록에 같은 규칙을 적용한다. 파일시스템을 읽지 않는다. */
function selectFromNames(names, deployPath, backupRoot, config) {
  const pattern = backupPatternFor(deployPath);
  const backups = [];

  for (const name of names) {
    const matched = pattern.exec(name);
    if (!matched) continue;
    const timestamp = parseStamp(matched[1]);
    if (timestamp === null) continue;
    backups.push({ name, path: `${backupRoot}\\${name}`, timestamp });
  }

  backups.sort((a, b) => b.timestamp - a.timestamp);
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
  stampNow,
  parseStamp,
  listBackups,
  selectFromNames,
  selectBackups,
  applyRetention
};
