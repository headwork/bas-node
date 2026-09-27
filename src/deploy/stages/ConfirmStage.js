const BaseStage = require('./BaseStage');
const path = require('path');
const fs = require('fs');
const { makeSshRunner } = require('../sshRunner');
const {
  releaseName, releaseDir, backupDirFor, siteNameFrom, selectLeftovers,
  matchByPattern, selectBackups, backupPatternFor, preservePatternFor, releasePatternFor
} = require('../backupRetention');

/**
 * 확정 단계. (#P202609_003 REQ9 · `[D03]` §4)
 *
 * **이름을 바꾸고 지우는 일은 전부 여기 모인다.** 그리고 여기는 헬스체크 **다음**이다.
 *
 * 2026-09-23 보스 지시 — *"파일명 변경, 폴더명 변경은 헬스체크가 끝난 이후에 진행"*.
 * 그 전까지 라이브 옆에 남아 있는 것들(`_org_`·`_temp_`)이 곧 복구 수단이기 때문이다.
 * 예전에는 원격 백업 정리가 **배포 직후·헬스체크 전**에 돌았다(`RemoteDeployMacroStage`).
 * 헬스체크가 실패하면 되돌릴 판을 이미 치운 뒤였다.
 *
 * ## 확정이란 무엇인가
 *
 * | 하는 일 | 대상 |
 * |---|---|
 * | 확정 | 올린 zip -> `backup_root\_builds\<live>_<stamp>.zip` — **롤백 원본** |
 * | 치움 | swap: `_org_` 삭제 / copy: `_temp_` 삭제 |
 * | 정리 | 보관 정책(zip · 유지파일) · 옛 폴더 백업 · 롤백 잔여 폴더 |
 *
 * ## 폴더 백업을 만들지 않는다 — 되돌릴 곳은 확정 zip 하나다
 *
 * 2026-09-23 보스 지시 — *"없는 사건까지 고려할 필요는 없다"*. 두 벌을 한동안 같이 굴리는
 * 전환기를 두지 않는다. 라이브 사본을 뜨면 정지 구간이 길어지는데, 그것을 감수하고 얻는 것이
 * **확정 zip 과 같은 내용**이다. 되돌릴 곳이 없는 상태(첫 배포·이력 없음)는 고장이 아니라
 * 정상이고, 롤백이 *"확정 빌드가 없습니다"* 로 **말한다**.
 *
 * 폴더 백업 **정리**는 남긴다 — 옛 규칙으로 쌓인 `<live>_<stamp>` 들이 서버에 남아 있다.
 *
 * 실패해도 배포를 뒤집지 않는다. 여기까지 왔다는 것은 **서비스가 이미 새 빌드로 정상**이라는
 * 뜻이고, 정리를 못 한 것 때문에 성공한 배포를 실패로 보고하면 사람이 엉뚱한 곳을 본다.
 */
/**
 * 여러 자리에서 모은 항목을 다시 최신순으로. 자리별로 이미 정렬돼 있어도
 * 합치면 섞이므로, **세기 전에 한 번 더** 정렬해야 `keep_count` 가 옳게 걸린다.
 */
function sortNewest(items) {
  return items.sort((a, b) => (b.timestamp - a.timestamp) || (b.seq - a.seq));
}

class ConfirmStage extends BaseStage {
  async execute(stageConfig, basePath) {
    const config = stageConfig && typeof stageConfig === 'object' ? stageConfig : {};
    const vars = this.engine.context.variables;
    const cfg = (key) => config[key] !== undefined ? config[key] : vars[key];

    const deployPath = cfg('web_deploy_path');
    const stamp = vars.release_stamp;
    if (!deployPath || !stamp) {
      // 배포 단계가 돌지 않았다(정적 배포·건너뜀). 확정할 것이 없다.
      console.log(`[Confirm] 확정할 배포가 없습니다 - 건너뜁니다.`);
      return;
    }

    const win = (p) => String(p).replace(/\//g, '\\');
    const livePath = win(deployPath);
    // 배포 스테이지가 실제로 쓴 자리를 그대로 받는다. 여기서 다시 구하면 사이트 이름
    // 해석이 갈려 **백업을 뜬 자리와 정리하는 자리가 달라진다.**
    // `backup_dir` 이 없는 것은 확정만 따로 돌린 경우다 — 그때만 같은 규칙으로 되짚는다.
    const configuredRoot = cfg('backup_root') ? win(cfg('backup_root')) : path.dirname(livePath);
    const backupRoot = win(vars.backup_dir || backupDirFor(configuredRoot, siteNameFrom(vars, livePath)));
    // 옛 자리(중첩 전). 새 자리와 **한 판으로 세어** 옛 백업이 저절로 밀려나게 한다.
    const legacyRoot = configuredRoot !== backupRoot ? configuredRoot : null;
    const mode = vars.deploy_mode_used || 'swap';
    const policy = this.engine.context.backup || {};

    const remote = !!vars.deploy_remote;
    const run = remote ? this.#remoteRunner(basePath) : this.#localRunner(basePath);

    console.log(`\n[Confirm] 배포를 확정합니다 (mode=${mode}, stamp=${stamp})`);

    // 1. 확정 — 이 배포의 zip 을 세대로 남긴다. **롤백이 읽는 유일한 원본이다.**
    //    `ArchiveStage` 는 고정 이름으로 덮어쓰므로, 여기서 사본을 남기지 않으면
    //    다음 빌드가 이 판을 지운다.
    // ⚠️ 스탬프는 **초 단위**다. 같은 초에 두 번 확정하면 이름이 겹치는데, 덮어쓰면
    //    앞 판이 **조용히 사라진다** — 되돌릴 수 있었던 지점이 하나 줄어든다.
    //    이름을 비켜 가는 쪽이 옳다(`uniquePath` 가 폴더에 하는 것과 같은 판단이다).
    const releasePath = `${releaseDir(backupRoot)}\\` +
      this.#freeName(run.listFiles(releaseDir(backupRoot)), releaseName(livePath, stamp));
    try {
      if (!vars.release_source) {
        // 산출물 zip 이 없는 배포(압축을 끄고 폴더를 그대로 올리는 구성)다.
        // 확정할 것이 없다고 **말한다** — 조용히 넘기면 롤백이 없는 줄 모른다.
        throw new Error('확정할 산출물(zip)이 없습니다 - compress 를 켜거나 archive 스테이지를 확인하십시오');
      }
      run.mkdir(releaseDir(backupRoot));
      run.copyFile(win(vars.release_source), releasePath);
      vars.release_zip = releasePath;
      console.log(`  [release] 확정: ${releasePath}`);
    } catch (err) {
      // 확정 실패는 배포를 뒤집지 않는다. 다만 **이 배포로는 되돌릴 수 없다** — 크게 적는다.
      console.error(`  ⚠️ [release] 확정 실패 - 이 배포로 되돌릴 수 없습니다: ${err.message}`);
    }

    // 2. 치움 — 확정이 끝났으니 임시 자리들을 정리한다.
    try {
      if (mode === 'swap' && vars.org_path) {
        // 옛 라이브는 헬스체크까지만 살면 된다. 여기까지 왔다는 것은 새 빌드가 정상이라는
        // 뜻이고, 되돌릴 곳은 확정 zip 이다 — 사본을 또 뜨면 같은 내용이 두 벌이 된다.
        const org = win(vars.org_path);
        run.remove(org);
        console.log(`  [org] 삭제: ${org}`);
      }
      if (mode === 'copy' && vars.staged_path) {
        run.remove(win(vars.staged_path));
        console.log(`  [staged] 삭제: ${win(vars.staged_path)}`);
      }
    } catch (err) {
      console.error(`  [confirm] 임시 폴더 정리 실패(배포는 정상): ${err.message}`);
    }

    // 3. 보관 정책 — 세 종류에 **같은 정책**을 적용한다. 종류마다 따로 두면
    //    셋 중 하나만 지워져 짝이 깨진 상태가 생긴다.
    try {
      this.#retain(run, { livePath, backupRoot, legacyRoot, policy });
    } catch (err) {
      console.error(`  [confirm] 보관 정리 실패(배포는 정상): ${err.message}`);
    }

    // 4. 롤백이 라이브 옆에 남긴 `_failed_`·`_replaced_`·`_org_` 정리.
    //    배포가 성공했으면 그 실패는 지나갔다.
    try {
      this.#cleanupLeftovers(run, livePath, policy);
    } catch (err) {
      console.error(`  [confirm] 잔여 폴더 정리 실패(배포는 정상): ${err.message}`);
    }

    console.log(`[Confirm] 확정 완료.`);
  }

  /**
   * 이미 쓰인 이름을 비켜 간다. `a.zip` 이 있으면 `a_2.zip`, 폴더면 `a_2`.
   * 보관 정책의 이름 규칙이 `_N` 을 인정하므로(backupRetention) 정리에서 빠지지 않는다.
   */
  #freeName(existing, candidate) {
    const taken = new Set((existing || []).map(n => n.toLowerCase()));
    if (!taken.has(candidate.toLowerCase())) return candidate;

    const dot = candidate.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [candidate.slice(0, dot), candidate.slice(dot)] : [candidate, ''];
    for (let n = 2; n < 1000; n++) {
      const next = `${stem}_${n}${ext}`;
      if (!taken.has(next.toLowerCase())) return next;
    }
    return candidate;   // 여기까지 오면 이름이 문제가 아니다. 덮어쓰기 실패가 말해 준다.
  }

  /**
   * 보관 정책을 유지파일 백업 · 확정 zip 에 적용한다.
   * 폴더 백업은 **더 만들지 않지만** 옛 규칙으로 쌓인 것들이 서버에 남아 있어 계속 쓸어낸다.
   */
  #retain(run, { livePath, backupRoot, legacyRoot, policy }) {
    if (policy.enabled === false) return;

    // 새 자리 먼저, 옛 자리 나중. 순서는 상관없다 — 어차피 시각으로 다시 정렬된다.
    const roots = legacyRoot ? [backupRoot, legacyRoot] : [backupRoot];

    const folders = [];
    const preserves = [];
    for (const root of roots) {
      const names = run.listDirs(root);
      if (names === null) continue;
      folders.push(...matchByPattern(names, backupPatternFor(livePath), n => `${root}\\${n}`));
      preserves.push(...matchByPattern(names, preservePatternFor(livePath), n => `${root}\\${n}`));
    }
    this.#sweep(run, sortNewest(folders), policy, '옛 폴더 백업', true);
    this.#sweep(run, sortNewest(preserves), policy, '유지파일 백업', true);

    const releases = [];
    for (const root of roots) {
      const dir = releaseDir(root);
      const names = run.listFiles(dir);
      if (names === null) continue;
      releases.push(...matchByPattern(names, releasePatternFor(livePath), n => `${dir}\\${n}`));
    }
    this.#sweep(run, sortNewest(releases), policy, '확정 빌드', false);
  }

  /**
   * ⚠️ 삭제 경로는 **항목이 들고 있는 것**을 쓴다. 바깥에서 루트를 다시 붙이면
   *    여러 자리를 한 판으로 셀 때 옛 자리의 항목을 새 자리에서 지우려 든다.
   */
  #sweep(run, items, policy, label, isDir) {
    if (items.length === 0) return;
    const { keep, remove } = selectBackups(items, new Date(), policy);
    console.log(`  [${label}] ${items.length}건: 유지 ${keep.length}, 삭제 ${remove.length}`);
    for (const item of remove) {
      if (policy.dry_run) {
        console.log(`    [dry-run] would remove ${item.path}`);
        continue;
      }
      if (isDir) run.remove(item.path);
      else run.removeFile(item.path);
      console.log(`    [remove] ${item.path}`);
    }
  }

  #cleanupLeftovers(run, livePath, policy) {
    if (policy.enabled === false) return;
    const parent = livePath.replace(/\\[^\\]+$/, '');
    const dirs = run.listDirs(parent);
    if (dirs === null) return;

    // 이번 배포가 만든 `_org_` 는 위에서 이미 치웠다. 여기 걸리는 것은 **지난 실행이
    // 남긴 것**이다 — 확정 단계가 못 돌고 끝난 배포의 흔적.
    for (const name of selectLeftovers(dirs, livePath)) {
      if (policy.dry_run) {
        console.log(`  [dry-run] would remove ${name}`);
        continue;
      }
      run.remove(`${parent}\\${name}`);
      console.log(`  [leftover] 삭제: ${name}`);
    }
  }

  /**
   * 원격 조작기. 명령은 전부 cmd 다.
   * 목록만 받아 오고 **판단은 로컬에서** 한다 — 이 저장소가 원래 쓰던 방식이다.
   */
  #remoteRunner(basePath) {
    const vars = this.engine.context.variables;
    const target = vars.user ? `${vars.user}@${vars.host}` : vars.host;
    const ssh = makeSshRunner(this.engine, {
      target, port: vars.port || null, keyPath: vars.key_path, basePath
    });
    const list = (dir, flags) => {
      const r = ssh(`dir /b ${flags} ${dir}`, { capture: true, allowFailure: true });
      if (r.code !== 0) return null;
      return (r.output || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    };

    return {
      mkdir: (dir) => ssh(`if not exist ${dir} mkdir ${dir}`),
      copyFile: (from, to) => {
        const r = ssh(`copy /y ${from} ${to} > nul`, { capture: true, allowFailure: true });
        if (r.code !== 0) throw new Error(`copy 실패(${r.code}): ${from} -> ${to}`);
      },
      move: (from, to) => {
        const r = ssh(`move ${from} ${to} > nul`, { capture: true, allowFailure: true });
        if (r.code !== 0) throw new Error(`move 실패(${r.code}): ${from} -> ${to}`);
      },
      remove: (dir) => ssh(`if exist ${dir} rmdir /s /q ${dir}`, { capture: true, allowFailure: true }),
      removeFile: (f) => ssh(`if exist ${f} del /q ${f}`, { capture: true, allowFailure: true }),
      listDirs: (dir) => list(dir, '/ad'),
      listFiles: (dir) => list(dir, '/a-d')
    };
  }

  /** 로컬 조작기. 같은 인터페이스라 위층은 어느 쪽인지 모른다. */
  #localRunner() {
    const listing = (dir, wantDir) => {
      if (!fs.existsSync(dir)) return null;
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isDirectory() === wantDir)
        .map(e => e.name);
    };

    return {
      mkdir: (dir) => fs.mkdirSync(dir, { recursive: true }),
      copyFile: (from, to) => fs.copyFileSync(from, to),
      move: (from, to) => fs.renameSync(from, to),
      remove: (dir) => { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); },
      removeFile: (f) => { if (fs.existsSync(f)) fs.rmSync(f, { force: true }); },
      listDirs: (dir) => listing(dir, true),
      listFiles: (dir) => listing(dir, false)
    };
  }
}

module.exports = ConfirmStage;
