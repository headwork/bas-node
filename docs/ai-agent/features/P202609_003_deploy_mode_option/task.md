# 작업 단위 (TASK) — #P202609_003

정본 [spec.md](spec.md) · 설계 [EX_D01_01](EX_D01_01_배포방식설계.md) · 대상 파일 [EX_D02_01](EX_D02_01_변경대상파일.md)

> **OQ1~OQ3 확정(2026-09-23)으로 전 단계가 착수 가능하다.** 남은 미결은 `#P003-OQ4`(clean 빌드 여부)뿐이고
> 이것은 OQ2 의 전제일 뿐 구현을 막지 않는다.
>
> ⚠️ **3단계(백업 구조 전환)가 이 과제에서 가장 위험하다.** 롤백의 근거가 폴더에서 zip 으로 바뀌므로,
> 확정 zip 이 남기 시작한 **뒤에야** 폴더 백업을 끊을 수 있다. 순서를 뒤집으면 그 사이 배포는 되돌릴 수단이 없다.

## 0단계 — 기준선

* 🟡 `#P003-TASK0`: 현재(스왑) 명령열 스냅샷을 모드별로 분리. `test/remoteDeployCommands.test.js` ·
  `test/localDeploy.test.js` 가 `deploy_mode: swap` 을 명시하도록 고정한다. **이 단계 전에는 코드를 고치지 않는다.**

## 1단계 — 잠금 견고화 (#P003-REQ5, OQ 무관 · 즉시 효과) ✅ 2026-09-23

* ✅ `#P003-TASK1`: `webserver_iis.bat` — `:wait_wp` 신설. stop 뒤 `appcmd list wp` 가 빌 때까지
  1초 간격으로 기다린다(`WS_WP_WAIT`, 기본 15초). **절대 실패로 내리지 않는다** — 상한을 넘기면
  경고만 남기고 진행한다. 늦게 죽는 풀을 실패한 배포로 바꾸면 안 되고, 어차피 호출자의 에러가 더 정확하다.
  `timeout` 대신 `ping` 을 쓴다 — `timeout` 은 stdin 이 리다이렉트되면 거부하는데 ssh 실행이 정확히 그 모양이다.
  검증: 스텁 appcmd 로 두 경로 확인(워커 없음 → 57ms 즉시 반환 / 계속 살아 있음 → 대기 후 경고, 종료코드 0).
* ✅ `#P003-TASK2`: `src/deploy/lockDiag.js` 신규 — 종료코드 `1`(폴더를 못 옮김)에서
  **그 폴더를 잡은 프로세스를 이름·PID 로 찍는다.** 로컬·원격이 같은 명령을 쓴다(둘 다 cmd 가 받는다).
  ⚠️ 큰따옴표·파이프를 쓰지 않는다 — ssh 인용과 겹치고 cmd 가 파이프를 먼저 먹는다. 테스트로 못 박았다.
  잡히지 않으면 **"없다"가 아니라 "찾지 못했다"** 고 말한다 — 탐색기·cmd 의 현재 디렉터리는 이 방법으로 안 보인다.
  절대 던지지 않는다(던지면 원래 실패 사유가 가려진다). 검증 9건, 실제 실행 1건 포함.
* ✅ `#P003-TASK3`: `src/deploy/decodeOutput.js` 신규 — `execSync` 의 `encoding:'utf8'` 고정 해석을 걷어내고
  **UTF-8 로 읽어 U+FFFD 가 나오면 CP949 로 다시 읽는다.** 순서를 뒤집으면 안 된다(UTF-8 을 CP949 로 읽으면
  깨진 채로 성공한다). 2026-09-22 실패에서 원인 한 줄이 이 때문에 가려졌다. 검증 7건.

> 전체 회귀 **144건 통과**(PowerShell). ⚠️ git bash 에서 돌리면 `staticPatch` 1건이 실패하는데,
> GNU tar 가 `C:\...` 를 원격 호스트로 해석해서다. 코드와 무관하며 **테스트는 PowerShell 에서 돌린다.**
> `dist/script/windows/` 는 빌드 산출물(미추적)이라 아직 옛 스크립트다 — 배포 전에 빌드해야 한다.

## 2단계 — preserve 분류 (#P003-REQ2, REQ6)

* ⬜ `#P003-TASK4`: `configPreserve.js` 에 분류 파싱 + 하위호환 승격. 승격 결과를 `--dry-run` 에 출력.
* ⬜ `#P003-TASK5`: `scriptArgs.js` — 목록 조립(`DP_EXCLUDE`·`DP_DELTA`). 공백·쉼표·와일드카드 검사는 기존 규칙을 태운다.
* ⬜ `#P003-TASK6`: `test/preserveClassify.test.js` 신규.
* ⬜ `#P003-TASK6b`: **벌크 이월을 정지 전으로 옮긴다** (#P003-REQ2b). Node 가 `_preserve_<stamp>` 를
  임시폴더로 복사하고, `deploy.bat` 은 스왑 후 `_org_` 에서 **델타만**(`robocopy /E /XO`) 따라잡는다.
  ⚠️ 델타는 **시작 전**이다. `DP_PRESERVE`(정지 후 전량 복사)는 이때 폐지된다.

## 3단계 — 확정 단계와 백업 구조 전환 (#P003-REQ4, REQ9, REQ11 · 순서 엄수)

* ⬜ `#P003-TASK7`: **`confirm` 스테이지 신설** — 헬스체크 뒤에 놓고, **이름 변경·삭제를 전부 여기로 모은다.**
  현재 배포 직후에 도는 원격 백업 정리([RemoteDeployMacroStage.js:301-305](../../../../src/deploy/stages/RemoteDeployMacroStage.js#L301-L305))도 옮긴다.
* ⬜ `#P003-TASK8`: `ArchiveStage` + `confirm` — **확정 zip 세대 보관**(`_builds\<live>_<stamp>.zip`).
  ⚠️ 폴더 백업은 **아직 끊지 않는다.** 두 백업이 한동안 같이 돈다.
* ⬜ `#P003-TASK9`: `backupRetention` — 파일(.zip) 변형 · `_preserve_` 패턴 · **`_org_` 를 잔여 패턴에 추가**
  (`selectLeftovers` 가 `failed|replaced` 만 안다).
* ⬜ `#P003-TASK10`: 명명 규칙([`EX_D03_01`](EX_D03_01_자산명명규칙.md))을 코드 한 곳(`backupRetention`)에 모은다.
  **한 배포 = 한 스탬프.** 스탬프 생성 지점이 흩어지면 짝이 깨진다.
* ⬜ `#P003-TASK11`: `rollback.bat` — 복귀 원본을 확정 zip 으로(트랙 B). `RB_MODE` 제거.
* ⬜ `#P003-TASK12`: **QA 에서 zip 롤백을 실제로 한 번 성공**시킨 뒤에 폴더 백업을 끊는다.

## 4단계 — copy 모드 (#P003-REQ1, REQ3, REQ8, REQ10)

* ⬜ `#P003-TASK13`: `deploy.bat` 에 `DP_MODE` 분기와 copy 경로.
* ⬜ `#P003-TASK14`: `scriptExit.js` — copy 모드 종료코드 뜻 추가(`5` = 라이브가 섞였다).
* ⬜ `#P003-TASK15`: 매크로 4종에 `deploy_mode` 해석. copy 모드에서 Step 2.5(설정을 임시폴더로) 생략.
* ⬜ `#P003-TASK16`: **트랙 A(copy) 방아쇠** — 복사 도중·헬스체크 실패 시 직전 확정 zip 으로 자동 원복.
  ⚠️ **확정본이 하나도 없으면 copy 모드를 거부한다** — 되돌릴 원본이 없는 상태에서 라이브를 덮으면 복구 수단이 없다.
* ⬜ `#P003-TASK17`: `--mode=copy|swap` CLI 오버라이드 (#P003-REQ8).

## 5단계 — 적용

* ⬜ `#P003-TASK18`: `deploy_shore.yaml` — **QA 에 `deploy_mode: swap` 명시**(#P003-REQ7) ·
  운영은 생략(기본 `copy`) · `preserve` 분류 형식으로 전환.
* ⬜ `#P003-TASK19`: QA 에서 `--dry-run` → 실배포 검증. **운영 적용 전에 QA 에서 copy 모드도 한 번 돈다** —
  운영이 첫 실행이 되면 안 된다.
* ⬜ `#P003-TASK20`: 설계 문서 현행화 (01 · 02 · 06 · 템플릿 2종) +
  **가이드에 clean · 누적 빌드 설명 추가**(#P003-OQ4 확정 — 도구는 검사하지 않는다).
