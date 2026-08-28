# 🟢 P202608_001: Jenkins 배포기능 고도화

## 1. 개요
* **목적**: Node.js 환경에서 YAML 기반으로 동작하는 Jenkins 자동 배포 및 롤백 기능 고도화
* **배경**: 기존 배포 파이프라인을 개선하여, YAML 설정 파일을 통해 배포 과정을 자동화하고 유연성을 확보하기 위함.
* **상태**: 🟢 완료 (2026-08-27 구현 완료 및 검증)

> ⚠️ **구현 방향 전환**: 최초 결정사항(§3 결정사항)은 원격 서버의 `hlngs*` 배치 스크립트를 호출하는
> 방식이었으나, 실제 구현은 **개발 서버에서 IIS 를 직접 제어하는 로컬 배포 방식**으로 진행되었다.
> 원문은 이력 보존을 위해 남기고, §4 상세 설계를 실제 구현 기준으로 재작성한다.

## 2. 미결 항목 (OQ)
* 모든 미결 항목 협의 완료 (아래 결정 사항 참조)

## 3. 주요 기능 및 요구사항 (REQ)
* `#P001-REQ1`: **YAML 생성 및 호출** — ✅ 완료
  * Node.js에서 배포 스크립트를 정의한 YAML 파일을 동적으로 생성하고 파싱하여 실행 흐름을 제어해야 함.
* `#P001-REQ2`: **Git 동기화** — ✅ 완료
  * 최신 소스코드를 타겟 브랜치에서 가져오기 위한 Git 동기화 (pull/fetch) 수행.
* `#P001-REQ3`: **빌드 및 업로드** — ✅ 완료
  * 소스코드 빌드 과정을 거친 후, 생성된 결과물(아티팩트)을 배포 대상 서버로 업로드.
  * *(로컬 IIS 배포로 전환되면서 "업로드"는 빌드 산출물의 로컬 스테이징 복사로 구현됨)*
* `#P001-REQ4`: **배포 프로세스 실행** — ✅ 완료
  * 업로드된 파일 압축 해제 / 기존 구동 중인 서비스의 백업 생성 / 운영 중인 웹 서버 정지 /
    신규 빌드 파일로 교체(배포) / 웹 서버 재시작
* `#P001-REQ5`: **롤백 기능 (백업 재배포)** — ✅ 완료
  * 배포 또는 서버 재시작 실패 시, 백업해 둔 이전 버전 파일을 이용해 롤백하고 서버를 다시 구동.
* `#P001-REQ6`: **확장성 및 공통 모듈화** — ✅ 완료
  * 배포 파이프라인의 공통 로직은 코어 모듈로 구성하고, 프로젝트별 특이점(Custom steps)을 수용할 수 있는 확장 가능한 구조로 설계.
* `#P001-REQ7`: **OS 분기 처리 및 터미널 환경 실행** — ✅ 완료
  * OS(Windows/Linux)에 따라 Node.js에서 적절한 스크립트를 분기하여 실행하도록 처리.
  * Node.js 모듈은 개발 서버 터미널(CLI)에서 실행되며, 런타임에 터미널을 통해 동작함.
* `#P001-REQ8`: **민감 정보(Secrets) 및 시스템 환경변수 주입** — ✅ 완료
  * API Key, 토큰 등 보안이 필요한 민감 정보는 YAML 파일 내에 평문으로 하드코딩하지 않음.
  * `process.env` / `.env` 에서 런타임에 읽어 `${env.VAR_NAME}` 문법으로 치환.
  * **치환된 값이 콘솔 로그로 새지 않도록 출력 시점에 마스킹**한다 (`[D01.07]`).

### 결정 사항
* **구동 및 파일 보관 환경 확정**
  * **YAML 보관 위치**: 각 서버 내부에 보관 (배포 타겟 서버 등에 설정 파일을 둠)
  * **실행 방식**: 개발 서버 터미널(CLI)에서 Node.js를 구동하여, 터미널 상에서 YAML 설정 값을 읽어들이고 배포 동작을 오케스트레이션함.
  * **Jenkins 파라미터 전달**: Jenkins에서 Node.js 실행 시 동적 변수들을 JSON 문자열 형태로 CLI 인자(Argument)로 던져 파이프라인 컨텍스트에 즉시 주입 가능하도록 구성.
* **YAML 파일 상세 포맷 (`#P001-OQ1` 확정)**
  * 가독성을 높인 직관적이고 인간 친화적인(Human-friendly) 구조로 설계 적용. OS별 분기 설정 등을 수용할 수 있는 구조.
* **백업 파일 보관 정책 (`#P001-OQ2` 확정)**
  * YAML 내에서 동적으로 설정 가능하도록 구현.
  * **기본값 (Default)**:
    * 7일 이전 백업 삭제 (최근 7일분, 약 14개 보관)
    * 1개월 전 마지막 버전 1개 보관
    * 2개월 전 마지막 버전 1개 보관
* **서버 환경 및 명령어 정의 (`#P001-OQ3` 확정)** — ⚠️ *아래는 최초 결정 원문이며, 실제 구현은 로컬 IIS 방식으로 대체됨*
  * **OS 환경**: Windows 환경
  * **Jenkins 작업 디렉토리**: `D:\Deploy\jenkins_home\jobs`
  * ~~**Git 동기화**: `hlngsGitPull prod` / `hlngsGitPullRelease qa`~~ → `git_sync` 스테이지가 직접 수행
  * ~~**빌드**: `hlngsBuildWesys`~~ → `c#_build` 스테이지가 직접 수행
  * ~~**업로드**: `hlngsUpload`~~ → `local_deploy` 스테이지의 스테이징 복사로 대체
  * ~~**재기동 스크립트**: `./HLNGS/wesys_restart.bat ${TAG_DEPLOY}`~~ → `appcmd.exe` 기반 IIS 제어로 대체
  * ~~**서버 Shell Script 위치**: `D:/Deploy/hlngs/wesys_script_20250611`~~ → 불필요

## 4. 상세 설계 (D)

### `[D01.01]` YAML 파싱, 변수 주입 및 체이닝 구조
* `js-yaml` 로 파싱. 변수 치환은 `PipelineEngine.interpolate()` 가 담당.
* **일반 변수 주입**: `${VAR_NAME}` — 자기 참조·다중 계층 해석을 위해 3회 반복 치환.
* **민감 정보 주입**: `${env.API_KEY}` — `process.env` 조회 (진입점에서 `dotenv` 로 `.env` 선적재).
* **체이닝**: `chain` 속성으로 다른 YAML 을 연쇄 호출하고 부모 컨텍스트를 전달.

### `[D01.02]` 변수 컨텍스트 조립 순서 (환경 프로파일)
YAML 루트에 `target:` 프로파일을 두고 환경별 값을 평평하게 펼쳐 스테이지에 전달한다.
스테이지들은 `context.variables.branch / build_path / deploy_path / confluence` 를 읽는다.

조립 순서 (뒤가 앞을 덮는다):

1. 루트의 단순 설정값 (`name`, `git_url`, `deploy_path` 등 — 구조 키와 객체는 제외)
2. `variables:` 블록
3. `--params` 로 들어온 외부 파라미터
4. **`target[environment]` 프로파일** — 1~3 을 기준으로 먼저 치환한 뒤 덮어쓴다.
   `deploy_path: "${deploy_path}/MFM.SHORE_QA"` 처럼 루트값을 참조하는 항목이
   자기 자신을 가리키는 재귀가 되지 않게 하기 위함.
5. `--params` 재적용 (외부 파라미터가 끝까지 최우선)

`environment` 결정 우선순위는 `--params` > 생성자 인자 > YAML 이다.
**정의되지 않은 프로파일을 지정하면 즉시 실패한다** — 조용히 빈 변수로 진행하면
스테이지가 엉뚱한 경로에 배포한다.

```yaml
name: "Deploy MFM.SHORE_QA"
environment: "qa"
deploy_path: "D:/Deploy"
git_url: "http://user:${env.GIT_API_KEY}@host/WeSys.git"

target:
  qa:
    branch: "deploy/qa"
    deploy_path: "${deploy_path}/MFM.SHORE_QA"
    build_path: "${deploy_path}/build/MFM.SHORE_QA"
    confluence: true

backup:
  keep_recent_days: 7
  keep_monthly_months: 2
  dry_run: false

stages:
  - git_sync: {}
  - c#_build: {}
  - local_deploy: {}
  - confluence: {}

rollback:
  - local_rollback: {}
```

### `[D01.03]` 배포 파이프라인 단계 (Stage)
스테이지는 `PipelineEngine.stageHandlers` 레지스트리에 등록된다.

| 스테이지 | 역할 |
|---|---|
| `git_sync` | 최초엔 clone, 이후엔 stash → fetch → checkout → pull |
| `c#_build` | MSBuild 기반 빌드 |
| `local_deploy` | 스테이징 복사 → IIS 정지 → 라이브 백업 → 스왑 → IIS 시작 → **백업 정리** |
| `confluence` | `confluence: true` 인 경우만 문서 갱신 |
| `archive` | 배포 산출물 압축 (`<name>_<yyyyMMdd_HHmmss>.zip`) |
| `backup_cleanup` | 백업 보관 정책 단독 실행 |
| `local_rollback` | 최신 백업으로 복구 |
| `extract` · `fs_rename` · `iis_control` · `sync_static` · `health_check` · `other_server` | 저수준 단위 스테이지 |
| `sync` · `build` · `upload` | 임의 명령 실행 (`CommandStage`) |

`local_deploy` 는 `deploy_path` 의 마지막 디렉터리 이름을 IIS 사이트명으로 유추한다.

### `[D01.04]` Jenkins 연동 및 파라미터 병합(Override)
* `node src/deploy/deploy-cli.js --yaml=<path> --params='{"environment":"qa"}'`
* 전달된 JSON 은 YAML 의 `variables` 및 `target` 프로파일보다 **최우선으로 병합**된다.

### `[D01.05]` 백업 보관 정책 (`#P001-OQ2` 구현)
* 백업 디렉터리 명명 규칙: `<deploy_path 의 basename>_backup_<epochMillis>`
* 보관 규칙 (`selectBackups()` — 부수효과 없는 순수 함수):
  1. 최근 `keep_recent_days` 일 이내 백업은 전부 보관
  2. 1 ~ `keep_monthly_months` 개월 전 **각 달의 마지막(최신) 백업 1개**씩 보관
  3. 나머지 삭제
* 달 계산은 `year*12 + month` 정수로 접어서 한다 — `setMonth` 의 말일 넘침(1/31 → 3/3) 회피.
* **안전장치**: 살아 있는 배포 경로와 겹치면 삭제를 거부한다. `dry_run: true` 면 대상만 출력한다.
* **정리 실패는 배포 성공을 뒤집지 않는다.** 로그만 남기고 넘어간다.

### `[D01.06]` 롤백 (`#P001-REQ5` 구현)
* 파이프라인이 실패하면 `executeRollback()` 이 실행된다. 정의는 세 형태를 받는다.
  1. **스테이지 목록** — `rollback: [ - local_rollback: {} ]` 또는 `rollback: { stages: [...] }`
  2. 원격 스크립트 — `rollback: { script_dir, rollback_cmd }`
  3. 단일 명령 — `rollback: "restore.bat"`
* 어느 형태에도 맞지 않으면 **조용히 넘어가지 않고 CRITICAL 로그를 남긴다.**
* `local_rollback` 동작: IIS 정지 → 실패 배포본을 `<deploy_path>_failed_<ts>` 로 격리 →
  최신 백업을 라이브로 복구 → IIS 시작.
* 되돌릴 백업이 없으면 성공한 척하지 않고 **예외를 던진다.**
* **롤백 실패는 원래 배포 에러를 덮지 않는다** — 삼키고 로그만 남긴 뒤 원본 에러를 전파한다.

### `[D01.08]` 배포 산출물 압축 (`#P001-REQ3` 구현)
* `archive` 스테이지. 산출물명은 `<name>_<yyyyMMdd_HHmmss>.zip`, 기본 출력 위치는 `<src>/../_artifacts`.
* **Windows**: `tar.exe`(bsdtar) 로 먼저 시도하고 실패하면 `Compress-Archive` 로 폴백한다.
  bsdtar 가 훨씬 빠르지만 zip 쓰기 지원이 빌드마다 달라 폴백이 필요하다.
  (실측: 522.8 MB → 158.1 MB, 72초)
* `-C <src> .` 로 담아 **최상위 폴더 없이 내용만** 넣는다 — IIS 배포 시 그대로 펼치기 위함.
* 명령이 종료코드 0 으로 끝나도 **산출물 파일이 없으면 실패로 처리한다.**
* 생성된 경로를 `context.variables.archive_path` 에 실어 후속 스테이지가 참조할 수 있게 한다.

### `[D01.07]` 민감 정보 로그 마스킹 (`#P001-REQ8` 보완)
`${env.*}` 로 감춰도 치환된 값을 그대로 출력하면 Jenkins 콘솔 로그에 평문으로 남는다.
출력 시점에 가린다.

* 원본 YAML 값에 `${env.` 참조가 있던 키는 컨텍스트 로그에서 `***(masked)` 로 출력
* URL 에 박힌 자격증명(`//user:pass@host`)은 `maskUrlCredentials()` 로 마스킹
* 적용 지점: 컨텍스트 변수 로그, `git clone` 로그, 명령 실행 실패 로그

### 알려진 제한
* `PipelineEngine.runCommand()` 의 `shell` / `shellArgs` 지역변수는 계산만 되고 사용되지 않는다
  (실제로는 `execSync(cmd, { shell: true })` 로 실행). Windows 에서는 기본 셸이 `cmd.exe` 라
  동작에 문제는 없으나, 배포 경로의 셸 호출 방식을 바꾸는 변경이라 이번 범위에서는 손대지 않았다.
* `local_rollback` 이 격리한 `_failed_*` 디렉터리는 보관 정책(`_backup_*` 만 대상) 밖이다.
  원인 분석 후 직접 정리해야 한다.

## 5. 작업 단위 (TASK)
* `#P001-TASK1`: Node.js 기반 YAML 파서 및 파이프라인 오케스트레이터 모듈 설계 및 개발 — ✅ 완료
* `#P001-TASK2`: Git 동기화 및 빌드 실행 처리 로직 구현 — ✅ 완료
* `#P001-TASK3`: 배포 대상 서버 전송 및 원격 제어 모듈 구현 (백업, 정지, 배포, 시작) — ✅ 완료
* `#P001-TASK4`: 실패 시나리오 대응을 위한 롤백 및 백업 재배포 기능 구현 — ✅ 완료
* `#P001-TASK5`: 백업 보관 정책(OQ2) 구현 — ✅ 완료 *(2026-08-27 추가)*
* `#P001-TASK6`: `target` 환경 프로파일 해석 구현 — ✅ 완료 *(2026-08-27 추가)*
* `#P001-TASK7`: 민감 정보 로그 마스킹 — ✅ 완료 *(2026-08-27 추가)*

## 6. 변경 대상 파일

### 신규
| 파일 | 역할 |
|---|---|
| `src/deploy/backupRetention.js` | 백업 보관 정책 로직 (`selectBackups` · `applyRetention` · `listBackups`) |
| `src/deploy/maskSecrets.js` | 민감 정보 로그 마스킹 유틸 |
| `src/deploy/stages/BackupCleanupStage.js` | `backup_cleanup` 스테이지 |
| `src/deploy/stages/LocalRollbackMacroStage.js` | `local_rollback` 스테이지 |
| `src/deploy/stages/ArchiveStage.js` | `archive` 스테이지 (배포 산출물 압축) |

### 수정
| 파일 | 변경 내용 |
|---|---|
| `src/deploy/PipelineEngine.js` | `target` 프로파일 해석, `environment` 우선순위 수정, `backup` 블록 적재, `executeRollback` 스테이지 목록 지원, 로그 마스킹, 신규 스테이지 등록 |
| `src/deploy/stages/LocalDeployMacroStage.js` | Step 6 백업 보관 정책 적용 추가 |
| `src/deploy/stages/GitSyncStage.js` | clone 로그의 자격증명 마스킹 |
| `deploy_shore.yaml` | `backup:` · `rollback:` 블록 추가 |

### 변경 없음 (기존 유지)
`deploy-cli.js`, `BaseStage.js`, `CommandStage.js`, `ChainStage.js`, `ExtractStage.js`,
`IisControlStage.js`, `FsRenameStage.js`, `SyncStaticStage.js`, `HealthCheckStage.js`,
`CSharpBuildStage.js`, `OtherServerStage.js`, `ConfluenceStage.js`

## 7. 문서/자산 현행화 및 인수

### 검증 결과 (2026-08-27)
실제 호출 경로(`node src/deploy/deploy-cli.js`)로 샌드박스 배포를 돌려 확인했다.
직접 import 단위 호출만으로는 컨텍스트 조립 경로가 검증되지 않는다.

| 항목 | 단언 | 결과 |
|---|---|---|
| 보관 정책 순수 로직 (달 경계 포함, `now` 고정) | 4 | ✅ |
| 정상 배포 + 백업 정리 (실제 CLI) | 8 | ✅ |
| 배포 실패 → 롤백 → 라이브 복구 (실제 CLI) | 6 | ✅ |
| `--params` environment 오버라이드 | 3 | ✅ |
| 미정의 프로파일 즉시 실패 | 3 | ✅ |
| `deploy_shore.yaml` 실제 설정 파싱·프로파일·마스킹 | 17 | ✅ |

* IIS 제어는 존재하지 않는 사이트명으로 돌려 실제 IIS 에 영향을 주지 않았다
  (`IisControlStage` 는 실패를 경고로 삼킨다).
* **`git_sync` · `c#_build` 는 검증에서 제외했다** — 네트워크 clone 과 MSBuild 를 태우므로
  샌드박스에서 돌릴 수 없다. 실서버 1회 실행으로 확인 필요.

### 실환경 실행 결과 (2026-08-27, `temp/test_wesys_qa.yaml`)
`git_sync` → `c#_build`(publish) → `archive` 까지 실제 서버 경로로 완주했다.

| 단계 | 결과 |
|---|---|
| `git_sync` | `deploy/qa` 브랜치 클론 (커밋 `31be429b`, 20,667 파일) → `D:/Deploy/build/MFM.SHORE_QA` |
| `c#_build` | `dotnet publish MFM.Shore/Web/MFM.Shore.csproj -c Release` → 531 MB |
| `archive` | 522.8 MB → **158.1 MB (72초)**, 엔트리 4,456개 |

* 산출물 검증: publish 원본 파일 4,039 + 디렉터리 417 = **4,456** 으로 zip 엔트리 수와 일치.
  `MFM.Shore.dll` · `appsettings.json` · `runtimeconfig.json` · `web.config` · `wwwroot`(2,082 파일) 포함 확인.
* `MFM.Shore` 는 **net6.0 ASP.NET Core**(`Microsoft.NET.Sdk.Web`). 빌드 SDK 는 10.0.301 이라
  `NETSDK1138`(net6.0 지원 종료) 경고가 나지만 빌드는 통과한다.
* 저장소에 이미 `ci/ci-build.ps1` 이 있고 MFM.Shore 의 빌드 대상을
  `MFM.Shore\Web\MFM.Shore.csproj` 로 정의한다 — 파이프라인도 같은 대상을 쓴다.

> ⚠️ **`git_url` 에 `${env.GIT_API_KEY}` 를 넣으면 인증이 실패한다.**
> Git 서버는 **Bonobo Git Server**(IIS/ASP.NET, `Basic realm="Bonobo Git"`)로 PAT/API 키 개념이
> 없고 계정 비밀번호만 받는다. 현재 `.env` 의 `GIT_API_KEY` 는 이 서버의 자격증명이 아니며,
> URL 에 박는 순간 **Windows 자격증명 관리자(GCM)에 저장된 정상 자격을 덮어써서** 실패한다.
> 자격증명 없이 호출하면 GCM 이 처리해 정상 동작한다 (실측 확인).
> Jenkins 서비스 계정에는 GCM 자격이 없을 수 있으므로 운영 적용 방식은 별도 결정이 필요하다.

### 남은 인수 항목
* [ ] **`deploy_shore.yaml` 의 `git_url` 자격증명 방식 결정** (위 경고 참조) — 현재 설정 그대로는 clone 실패
* [ ] `local_deploy` · `local_rollback` 실서버 1회 검증 (IIS 실제 정지/기동을 동반하므로 미실행)
* [ ] 첫 배포 시 `backup.dry_run: true` 로 두고 삭제 대상 목록 육안 확인 후 `false` 전환 권장
* [ ] Jenkins Job 에서 `--params` 로 `environment` 전달하도록 설정
* [ ] `archive` 산출물의 업로드/전달 경로 결정 (현재는 `_artifacts` 에 적재만 함)
