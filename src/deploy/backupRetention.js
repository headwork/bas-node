const fs = require('fs');
const path = require('path');

// #P001-OQ2 확정 기본값
const DEFAULTS = {
  enabled: true,
  keep_recent_days: 7,     // 최근 N일치는 전부 보관
  keep_monthly_months: 2,  // 1개월 전 · 2개월 전 각각 마지막 1개 보관
  dry_run: false           // true 면 삭제 대상만 출력하고 실제로 지우지 않음
};

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// LocalDeployMacroStage 가 만드는 백업 명명 규칙: <basename>_backup_<epochMillis>
function backupPatternFor(deployPath) {
  const base = path.basename(deployPath);
  return new RegExp('^' + escapeRegExp(base) + '_backup_(\\d+)$');
}

// 연-월을 정수 하나로 접는다. setMonth 의 말일 넘침(1/31 → 3/3) 문제를 피하기 위함.
function monthKey(date) {
  return date.getFullYear() * 12 + date.getMonth();
}

/**
 * deployPath 의 부모 디렉터리에서 해당 배포본의 백업 디렉터리만 골라 온다.
 * 최신순(내림차순) 정렬.
 */
function listBackups(deployPath) {
  const parentDir = path.dirname(deployPath);
  if (!fs.existsSync(parentDir)) return [];

  const pattern = backupPatternFor(deployPath);
  const result = [];

  for (const entry of fs.readdirSync(parentDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const matched = pattern.exec(entry.name);
    if (!matched) continue;

    const timestamp = Number(matched[1]);
    if (!Number.isFinite(timestamp) || timestamp <= 0) continue;

    result.push({
      name: entry.name,
      path: path.join(parentDir, entry.name),
      timestamp
    });
  }

  return result.sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * 보관/삭제 대상을 가른다. 부수효과 없는 순수 함수 — 정책만 담는다.
 *
 * 보관 규칙
 *   1) 최근 keep_recent_days 일 이내의 백업은 전부 보관
 *   2) 1..keep_monthly_months 개월 전 각 "달"의 마지막(최신) 백업 1개씩 보관
 *   3) 나머지는 삭제
 */
function selectBackups(backups, now, config) {
  const opts = { ...DEFAULTS, ...(config || {}) };
  const keepNames = new Map(); // name -> 보관 사유

  const recentCutoff = now.getTime() - opts.keep_recent_days * 24 * 60 * 60 * 1000;
  for (const backup of backups) {
    if (backup.timestamp >= recentCutoff) {
      keepNames.set(backup.name, `recent(<=${opts.keep_recent_days}d)`);
    }
  }

  const nowMonth = monthKey(now);
  for (let offset = 1; offset <= opts.keep_monthly_months; offset++) {
    const targetMonth = nowMonth - offset;
    // backups 는 최신순이므로 처음 만나는 것이 그 달의 마지막 버전이다.
    const last = backups.find(b => monthKey(new Date(b.timestamp)) === targetMonth);
    if (last && !keepNames.has(last.name)) {
      keepNames.set(last.name, `monthly(-${offset}m last)`);
    }
  }

  const keep = backups.filter(b => keepNames.has(b.name))
    .map(b => ({ ...b, reason: keepNames.get(b.name) }));
  const remove = backups.filter(b => !keepNames.has(b.name));

  return { keep, remove };
}

/**
 * 보관 정책을 실제로 적용한다.
 * 살아 있는 배포 경로는 어떤 경우에도 삭제 대상이 되지 않는다.
 */
function applyRetention(deployPath, config, logger = console) {
  const opts = { ...DEFAULTS, ...(config || {}) };

  if (opts.enabled === false) {
    logger.log(`[BackupRetention] Disabled by configuration. Skipping.`);
    return { keep: [], removed: [], failed: [] };
  }

  const backups = listBackups(deployPath);
  if (backups.length === 0) {
    logger.log(`[BackupRetention] No backup directories found for ${deployPath}.`);
    return { keep: [], removed: [], failed: [] };
  }

  const { keep, remove } = selectBackups(backups, new Date(), opts);

  logger.log(`[BackupRetention] Policy: keep_recent_days=${opts.keep_recent_days}, ` +
    `keep_monthly_months=${opts.keep_monthly_months}, dry_run=${!!opts.dry_run}`);
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
  listBackups,
  selectBackups,
  applyRetention
};
