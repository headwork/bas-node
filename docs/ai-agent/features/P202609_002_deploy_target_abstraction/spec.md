# 🟡 P202609_002: 배포 대상 범용화 (OS · 웹서버 추상화)

## 1. 개요

* **목적**: IIS 에 고정된 배포 대상을 걷어내고, **소스 수정 없이** 웹서버(nginx · apache · tomcat ·
  Windows 서비스 · 임의 명령)와 OS(Windows · Linux)를 확장할 수 있는 구조로 전환한다.

* **설계 원점 (보스 확인)**: 이 프로젝트의 YAML 은 설정 파일이 아니라 **셸 스크립트의 대체 언어**다.
  *"shell 스크립트가 어렵다 보니 그걸 yaml 로 만들어서 노드가 처리하게 한 것"* 이고,
  이번 과제는 **그 언어의 어휘를 범용으로 넓히는 것**이다. 목표 모델은 젠킨스다 —
  코어는 불변이고 플러그인·선언이 붙어 확장된다.
* **배경**: [#P001](../P202608_001_jenkins_deploy_enhancement/spec.md) 이 로컬 IIS 직접 제어로 구현되면서
  `appcmd` 가 5개 파일에 흩어졌고, **로컬과 원격에 같은 판정 로직이 복붙으로 이중화**돼 있다.
  한쪽만 고치면 다른 쪽이 조용히 달라진다.
* **상태**: 🟡 기획/진행중
* **선행 문서**: [배포 설계 04 젠킨스 잡](../../../design/배포/04_젠킨스_잡.md) ·
  [02 운영 배포 흐름](../../../design/배포/02_운영_배포_흐름.md)

### 현재 결합 지점 (실측)

| 위치 | 형태 |
|---|---|
| `src/deploy/stages/IisControlStage.js` | `appcmd` 전용 스테이지. `BENIGN`/`FATAL` 판정표 보유 |
| `src/deploy/stages/RemoteDeployMacroStage.js:307` | `#iis()` — **같은 판정 로직의 복사본** |
| `src/deploy/stages/LocalDeployMacroStage.js:38` | `iis_site` 유추 · `manage_iis` |
| `src/deploy/stages/LocalRollbackMacroStage.js:38` | 동일 |
| `src/deploy/stages/RemoteRollbackMacroStage.js` | 동일 |
| `src/deploy/PipelineEngine.js:49` | 스테이지 이름 `iis_control` |
| `docs/design/template/deploy_shore.yaml:61,72,79` | `iis_site` |

---

## 2. 미결 항목 (OQ)

* ~~`#P002-OQ1`: Linux 원격이 실제 목표인가~~ → **확정.** §3 결정 사항 참조.

* ~~`#P002-OQ2`: ssh 접속정보 위치~~ → **확정 (2026-09-17). YAML 에 적는다.**
  `resolveServer` 가 `ssh:` 블록을 평탄화해 `context.variables` 로 올리므로
  (`PipelineEngine.js:167-170` → `:433`) 스테이지의 `cfg('user')`·`cfg('key_path')` 가 그대로 읽는다.
  `deploy_shore.yaml` · `deploy_sample.yaml` 반영 완료.
  ⚠️ 키 이름은 ssh config 문법(`User`·`IdentityFile`)이 아니라 **`user`·`key_path`** 다.
  ⚠️ `key_path` 는 배포도구가 도는 서버의 **로컬 경로**다 — 서버를 옮기면 같이 옮겨야 한다.
  → 이로써 `[D07]`(ssh2 세션) 트랙의 차단 요인이 풀렸다.

* ~~`#P002-OQ3`: Tomcat 배포 단위~~ → **완료 처리 (2026-09-17).**
  `[D10]` 경계대로 **스크립트가 처리한다.** Node 는 관여하지 않으므로 지금 설계에서 검토 대상이 아니다.

* ~~`#P002-OQ4`: 어댑터 정의 배치~~ → **확정 (2026-09-17). (b) 수동 배치 + (e) 별도 scp.**
  `[D10]` 채택으로 질문이 "스크립트의 배치·전달"로 바뀌었고 축이 둘이었다. 상세는 `[D10]`.

  ⚠️ **(d) 산출물 zip 동봉은 철회했다** — zip 은 `tempPath` 에 풀려 **그대로 라이브가 되므로**
  배포 스크립트가 라이브 폴더에 남는다. 계획서 `[D10]` 초안의 "zip 에 실어 보낸다(왕복 증가 없음)"가 그것이다.

  ⚠️ **(a) webpack 복사도 접었다** — 실측상 webpack 은 JS 만 번들하고 `.bat` 은 건드리지 않으며,
  `cleanFile()` 이 dist 청소 때 `.bat` 을 **보존**한다(`webpack.config.js:91`).
  즉 `dist/*.bat` 은 수동으로 놓인 것이고 빌드가 갱신하지 않는다. **(b) 를 택했으므로
  구 버전이 남을 수 있다는 위험은 그대로다** — 배치는 보스가 직접 하며 §7 목록에 둔다.

---

## 3. 주요 기능 및 요구사항 (REQ)

* `#P002-REQ8`: **레시피 — 스텝의 순서를 코드에서 선언으로 뺀다** ⭐⭐ 최상위
  매크로가 통짜라 스텝 순서가 JS 코드에 박혀 있다. 이것을 선언으로 옮겨야
  새 배포방식이 **정의 한 장**으로 붙는다. `[D09]` 참조.

* `#P002-REQ1`: **웹서버 제어 추상화**
  `stop` / `start` / `reload` 를 추상 동작으로 두고, 어느 서버인지는 어댑터가 정한다.
  로컬·원격 구현을 **한 벌로 합친다**(현재 두 벌).

* `#P002-REQ2`: **선언형 어댑터 — 소스 수정 없는 확장** ⭐ 핵심
  새 웹서버를 붙일 때 JS 파일을 만들지 않는다. **정의 파일 하나를 추가**하면 된다.

* `#P002-REQ3`: **정지 필요 여부에 따른 시퀀스 분기**
  전부 "정지 → 스왑 → 시작"이 아니다. nginx · apache 는 **스왑 → reload** 로 무중단이 가능하다.

* `#P002-REQ4`: **OS(셸) 추상화 — 1단계에 포함**
  원격 셸이 `cmd` 냐 `sh` 냐에 따라 파일 조작 명령과 인용 규칙이 달라진다.
  **실행은 Windows 만 하되 `posix` 정의를 함께 작성**해 추상화의 수용력을 지금 증명한다.

* `#P002-REQ7`: **회귀 방어 — 명령 스냅샷 테스트** ⭐
  추상화 전후로 **생성되는 명령 문자열이 한 글자도 달라지지 않음**을 자동으로 증명한다.
  이것이 없으면 `#P002-REQ4` 는 위험을 줄이는 게 아니라 옮기는 것이다.

* `#P002-REQ5`: **하위호환**
  `deploy_shore.yaml` 이 운영 중이다. `iis_site` · `manage_iis` 를 쓰는 기존 YAML 이
  **수정 없이 그대로 동작**해야 한다.

* `#P002-REQ6`: **SSH 세션 유지** (별도 트랙)
  현재 원격 명령마다 `ssh` 프로세스를 새로 띄운다. 연결을 1회로 줄인다.

### 결정 사항

#### `#P002-OQ1` 확정 — 실행은 Windows 만, 구조는 지금 범용으로 연다

> "지금은 윈도우만 생각하는데, 확장성을 고려해서 나중에 리눅스가 필요할 때 소스 수정을 하게 되면
> **기존 것도 다시 테스트해야 하는 문제**가 발생"

제약은 "Linux 지원"이 아니라 **"나중에 열어야 하는 파일의 개수"** 다. 이것을 설계 목표로 삼는다.

| 나중에 Linux 를 붙일 때 열리는 파일 | 회귀 위험 |
|---|---|
| 0개 (정의 파일 추가만) | 없음 — 기존 경로의 바이트가 그대로다 |
| N개 (매크로 수정) | 그 N개를 **전부 재테스트**해야 한다 |

**현재 구조에서는 매크로 4개가 전부 열린다.** 명령 문자열이 매크로 본문에 직접 박혀 있기 때문이다.

```js
ssh(`if not exist ${tempPath} mkdir ${tempPath}`);   // RemoteDeployMacroStage:115
ssh(`move ${livePath} ${backupPath}`);               // :201
ssh(`dir /b ${tempPath}`, { capture: true });        // :123
```

→ **지금 할 일은 Linux 구현이 아니라 "명령 생성 지점을 한 곳으로 모으는 것"이다.**
`fsOps.mkdirIfAbsent(p)` 로 바꿔 두면 나중에는 `posix` 정의 추가로 끝나고 매크로는 열리지 않는다.

**따라서 `[D05]`(OS 추상화)를 2단계로 미루지 않고 1단계에 넣는다.**
다만 **실행 대상은 Windows 만**이고, `posix` 정의는 만들되 실행하지 않는다 (`[D08]`).

#### 역설 — 지금 바꾸는 것도 회귀다. 그래서 순서가 처방이다

"나중에 안 깨지게" 하려고 지금 고치면 지금 깨질 수 있다. 그리고 **실측: 테스트 인프라가 없다**
(`package.json:10` — `"test": "echo \"Error: no test specified\" && exit 1"`).
깨져도 알 방법이 없으므로 가드를 더할 것이 아니라 순서를 정한다.

```
① 명령 스냅샷 테스트   지금 생성되는 명령 문자열을 그대로 고정한다
② 추상화              테스트가 "한 글자도 바뀌지 않았다"를 증명한다
③ Linux 추가          스냅샷 추가일 뿐. ① 의 스냅샷은 불변이다
```

**이 저장소가 이미 쓰는 패턴이다.** `RemoteDeployMacroStage.#cleanupRemote()` 주석 —
*"목록만 ssh 로 받아 오고 **판단은 로컬에서** 한다 — 보관 정책이 부수효과 없는 순수 함수라
그대로 재사용된다."* 명령 생성도 `(추상동작, OS) → 문자열` 순수 함수이므로
**실서버 없이 테스트된다.** 신규 발명이 아니라 채택된 발상의 확장이다.

도구는 **`node:test` + `node:assert` 내장**을 쓴다 — Node 22 확인됨
(`04_젠킨스_잡.md` 확인 항목). **의존성 추가 0 · 번들 영향 0.**

#### 방안 1 "인터프리터 스크립트" — **두 개로 갈라 각각 처리**

제시된 내용에 성격이 다른 둘이 섞여 있어 분리한다.

**(1a) groovy 처럼 스크립트를 읽어 실행 — 전면 채택하지 않는다. 최하층 탈출구로 축소.**

접는 근거 세 가지. 전부 이 저장소에서 실제로 확인된 것이다.

| 근거 | 실측 |
|---|---|
| 같은 문제를 다른 형태로 되부른다 | `04_젠킨스_잡.md` §"왜 잡을 나누지 않는가" 가 **"잡을 쪼개면 분기가 젠킨스 설정 화면으로 흩어진다 … YAML 한 파일로 두면 diff 에 남는다"** 를 이 프로젝트의 채택된 설계로 못박고 있다. 스크립트로 전면 전환하면 분기가 다시 코드로 흩어진다 |
| `--dry-run` 이 무력해진다 | 같은 문서가 **"잡을 처음 걸 때는 `DRY_RUN` 으로 한 번 돌리고 변수 값을 눈으로 확인한다"** 를 운영 절차로 삼는다. 선언은 실행 전에 읽히지만 스크립트는 돌려봐야 안다 |
| 이미 그 대가를 치른 선례가 있다 | 버리기로 한 groovy 쪽이 정확히 이 구조였다(`evaluate(readFile())`). 결과는 샌드박스 승인 병목(`approvedSignatures` 0건)과 스코프 불명확(`mapConfig` 선언이 주석 처리된 채 바인딩 의존) |

**다만 완전히 버리지 않는다.** 선언으로 표현할 수 없는 케이스가 실재한다 —
`RemoteDeployMacroStage.#remoteMtimes()` 는 원격 출력을 파싱해 다음 판단을 만든다.
그래서 `[D03]` 3층 모델의 **최하층 탈출구**로 남긴다.

**(1b) SSH 세션을 Node 에서 유지 — 채택. 단 독립 트랙.**

Node 에는 Jenkins CPS 같은 직렬화 제약이 없다. `ssh2` 의 `Client` 를 변수로 들고 있으면 그만이다.

| | 현재 | `ssh2` |
|---|---|---|
| 연결 횟수 | 원격 배포 1회당 **12~30회** (mkdir · tar · dir · copy×N · mtime · appcmd×4 · move×2 · rmdir×N) | 1회 |
| 업로드 | `scp` 별도 프로세스 | 같은 세션의 sftp |
| 종료코드 | 셸 경유로 한 겹 건너 받는다 | 채널에서 직접 |
| 원격 OS 판별 | 없음 | 접속 후 1회 질의로 가능 → `[D05]` 의 입력이 된다 |

**⚠️ 차단 요인은 `#P002-OQ2` 다.** 접속정보가 YAML 에도 config 에도 없어
`~/.ssh/config` 에 의존하는 상태이고, `ssh2` 는 그 파일을 읽지 않는다.
**웹서버 추상화와 같은 시기에 하지 않는다** — 변경 둘이 섞이면 실패 원인을 가르지 못한다.

#### 방안 2 "인터페이스화" — 채택. 단 우려는 기우다

> "이건 분리가 많이 될듯"

**조합 폭발이 아니다. `N × M` 이 아니라 `N + M` 이다.** 두 축이 서로 독립이기 때문이다.

* OS 축(파일 조작): `windows` · `posix` — **2개**
* 웹서버 축(서비스 제어): iis · nginx · apache · tomcat · service · command · none — **7개**

매크로는 둘을 각각 주입받아 쓰므로 정의 파일은 **9개**이고 14개 조합을 만들 필요가 없다.

#### 결론 — 두 방안을 합친 3층 모델을 채택한다

"나중에 소스 수정 없이"에 대한 직접적 답은 **어댑터를 JS 클래스가 아니라 정의 파일로 두는 것**이다.
`[D03]` 참조. 방안 1 의 의도는 3층에서 살아남고, 방안 2 의 구조는 축 분리로 유지된다.

---

## 4. 상세 설계 (D)

### `[D01]` 두 축으로 가른다

"IIS 하드코딩"은 증상이고, 원인은 **두 축이 안 갈린 것**이다.

| 축 | 값 | 현재 |
|---|---|---|
| 무엇을 제어하나 | iis · nginx · apache · tomcat · service · command · none | IIS 고정 |
| 어디서 실행하나 | local · ssh | 각각 따로 구현 (복붙) |

**어댑터는 명령 문자열만 만들고, 실행은 주입받은 runner 가 한다.**
그러면 로컬·원격 구현이 한 벌로 합쳐진다.

```
매크로 (local_deploy · remote_deploy · local_rollback · remote_rollback)
   │   runner 주입
   │     local = engine.runCommand
   │     ssh   = RemoteDeployMacroStage.#sshRunner
   │     ※ 두 시그니처가 이미 동일하다 — (cmd, opts) -> { code, output }
   ↓
WebServerControlStage      실행·판정 루프 (공통, 한 벌)
   ↓
WebServerAdapter           type 으로 선택 · 정의 파일에서 적재
```

`#sshRunner` 와 `engine.runCommand` 의 시그니처가 이미 같다는 점이 이 설계의 전제다.
**새로 맞출 필요가 없다.**

### `[D02]` 어댑터 정의 스키마

판정표를 어댑터가 들고 있어야 한다. **"이미 그 상태"의 신호가 서버마다 다르기 때문이다.**

| 서버 | 이미 멈춰 있을 때의 반응 |
|---|---|
| IIS `appcmd` | 0 아닌 종료코드 + `ALREADY_STOPPED` |
| systemd | **종료코드 0** — 출력으로 구분되지 않는다 |
| nginx `-s reload` | 마스터 프로세스 없으면 실패 (정상 아님) |
| tomcat `shutdown.sh` | 메시지만 내고 0 |

현재 `IisControlStage.js:14-31` 의 `BENIGN` / `FATAL` 이 이 표의 **IIS 행**이다.
이를 일반화해 어댑터마다 자기 행을 갖게 하고, 실행·판정 루프(`IisControlStage.run()`)는 공유한다.

```yaml
# adapters/nginx.yaml
type: nginx
requires_stop: false          # 스왑 전에 정지가 필요한가
supports_reload: true

commands:
  stop:   "systemctl stop ${name}"
  start:  "systemctl start ${name}"
  reload: "systemctl reload ${name}"

rules:
  benign:
    - "already (started|stopped)"
  fatal:
    - re:  "Access is denied|Permission denied|액세스가 거부"
      why: "권한 부족 - 서비스 제어 권한을 확인하세요"
    - re:  "not found|Unit .* could not be found|찾을 수 없"
      why: "대상을 찾을 수 없습니다 - 서비스/사이트 이름을 확인하세요"
```

```yaml
# adapters/iis.yaml — 현재 동작을 그대로 옮긴 것
type: iis
requires_stop: true           # .NET 어셈블리 잠금 때문에 정지가 필요하다
supports_reload: false

commands:
  stop:
    - "${appcmd} stop site /site.name:${name}"
    - "${appcmd} stop apppool /apppool.name:${name}"
  start:
    - "${appcmd} start site /site.name:${name}"
    - "${appcmd} start apppool /apppool.name:${name}"

vars:
  appcmd: "%windir%\\system32\\inetsrv\\appcmd.exe"

rules:
  benign: ["already started", "already stopped", "ALREADY_STARTED", "ALREADY_STOPPED"]
  fatal:
    - re:  "insufficient permissions|Access is denied|액세스가 거부|redirection\\.config"
      why: "권한 부족 - IIS 제어에는 관리자 권한이 필요합니다 (관리자 터미널에서 실행)"
    - re:  "does not exist|cannot find|Unknown (site|apppool)|찾을 수 없"
      why: "대상을 찾을 수 없습니다 - 사이트/앱풀 이름을 확인하세요"
```

### `[D03]` 3층 확장 모델 — 전부 소스 수정이 없다

| 층 | 형태 | 새로 붙일 때 | 대상 |
|---|---|---|---|
| **1** | 내장 어댑터 정의 (`adapters/*.yaml`) | **정의 파일 1개 추가** | iis · nginx · apache · tomcat · service |
| **2** | `type: command` — 배포 YAML 에 명령 직접 기입 | 배포 YAML 만 수정 | 일회성 · 사내 특수 서버 |
| **3** | `type: script` — JS 파일 로드 | **스크립트 1개 추가** | 출력 파싱 후 분기 등 선언 불가 케이스 |

```yaml
# 2층 — WebLogic·JBoss·자체 데몬처럼 정의를 만들 것도 없는 경우
web_server:
  type: command
  stop:   "net stop myapp"
  start:  "net start myapp"

# 3층 — 선언으로 표현 못 하는 경우 (방안 1a 가 여기서 살아남는다)
web_server:
  type: script
  path: "${tool_home}/adapters/weblogic.js"
```

**2층을 반드시 넣는다.** 새 서버가 들어올 때마다 코드를 고쳐야 한다면 범용화한 것이 아니다.

### `[D04]` 시퀀스가 갈린다 — 단순 치환이 아닌 이유

| `requires_stop` | 시퀀스 | 해당 | 다운타임 |
|---|---|---|---|
| `true` | stop → swap → start | IIS(어셈블리 잠금) · Tomcat | 있음 |
| `false` | **swap → reload** | nginx · apache (정적 · 리버스프록시) | **없음** |

한 덩어리로 "서버 제어"로 묶으면 nginx 에서 **불필요한 다운타임**이 생긴다.
이름만 바꾸는 리팩터링이 아니라 동작이 좋아지는 지점이다.

`LocalDeployMacroStage` · `RemoteDeployMacroStage` 의 Step 2 / Step 5(6) 자리가
어댑터의 `requires_stop` 을 보고 갈라진다.

### `[D05]` OS(셸) 추상화 — 1단계에 포함 (실행은 Windows 만)

`RemoteDeployMacroStage` 의 파일 조작이 전부 cmd 전용이다.

```
if not exist … mkdir  ·  move  ·  dir /b /ad  ·  rmdir /s /q  ·  copy /y
powershell -NoProfile -c …(LastWriteTimeUtc.Ticks)
```

**웹서버 어댑터만 갈아서는 Linux 배포가 되지 않는다.** 같은 추상화를 파일 조작에도 적용한다.

| 추상 동작 | windows | posix |
|---|---|---|
| `mkdirIfAbsent(p)` | `if not exist p mkdir p` | `mkdir -p p` |
| `move(a, b)` | `move a b` | `mv a b` |
| `listDirs(p)` | `dir /b /ad p` | `find p -maxdepth 1 -type d -printf '%f\n'` |
| `removeTree(p)` | `rmdir /s /q p` | `rm -rf p` |
| `copyFile(a, b)` | `copy /y a b` | `cp -f a b` |
| `mtimes(paths[])` | `powershell … Ticks` | `stat -c %Y` |

⚠️ `RemoteDeployMacroStage.js:273` 의 주석 — "`|` 를 넣으면 cmd 가 파이프로 먹고, 따옴표를 넣으면
ssh 의 따옴표와 겹친다" — 은 **cmd 전용 우회책**이다. posix 에서는 불필요하므로
그 제약을 셸 어댑터 안에 가두고 매크로에서는 걷어낸다.

원격 셸 판별은 `remote.shell: cmd | sh` 로 명시하되, `[D07]` 세션 트랙이 들어오면
접속 직후 1회 질의로 자동 판별할 수 있다.

### `[D06]` 하위호환 승격 규칙 — 조용히 깨지 않는다

`deploy_shore.yaml` 이 운영 중이므로 기존 키를 그대로 받아 새 형식으로 **승격**한다.

| 기존 | 승격 결과 |
|---|---|
| `iis_site: "MFM.SHORE_QA"` | `web_server: { type: iis, name: "MFM.SHORE_QA" }` |
| `manage_iis: false` | `web_server: { type: none }` |
| 둘 다 없음 | `web_server: { type: iis, name: basename(web_deploy_path) }` — **현재 유추 규칙 유지** |

새 형식:

```yaml
web_server:
  type: nginx
  name: "wesys"
```

**승격은 `--dry-run` 출력에 찍는다.** 어느 규칙으로 해석됐는지 눈으로 확인되지 않으면
기존 YAML 이 의도와 다르게 승격돼도 알 수 없다.

### `[D07]` SSH 세션 유지 — 별도 트랙 (`#P002-REQ6`)

`[D01]`~`[D06]` 과 **독립이며 동시에 진행하지 않는다.**
`#sshRunner` 가 만드는 runner 의 시그니처만 유지하면, 내부가 프로세스 spawn 이든
`ssh2` 세션이든 위층은 모른다 — 축을 가른 덕에 이 교체가 국소적으로 끝난다.

선결 조건은 `#P002-OQ2`(접속정보 이전) 하나다.

### `[D08]` 회귀 방어 — 명령 스냅샷 (`#P002-REQ7`)

명령 생성은 `(추상동작, OS) → 문자열` 순수 함수다. **실서버 없이 테스트된다.**

```js
// test/commands.snapshot.test.js  — node:test 내장
test('windows: remote_deploy 명령열', () => {
  assert.deepEqual(buildCommands('remote_deploy', { os: 'windows', ...fixture }), [
    'if not exist D:\\HLNGS\\build\\_stage mkdir D:\\HLNGS\\build\\_stage',
    'tar -xf D:/HLNGS/build/MFM.SHORE.zip -C D:\\HLNGS\\build\\_stage',
    // … 현재 코드가 내는 문자열 그대로
  ]);
});
```

**작성 순서가 처방이다** — 추상화 **전에** 현재 출력으로 스냅샷을 채운다.
그래야 리팩터링이 "한 글자도 안 바뀌었다"를 증명한다. 나중에 작성하면
바뀐 결과를 정답으로 굳히게 된다.

#### `posix` 정의를 지금 함께 만든다 (실행하지 않는다)

**구현이 하나뿐인 인터페이스는 인터페이스가 아니다.** `windows` 만 만들면 그 추상화가
Linux 를 담을 수 있는지 증명되지 않고, windows 명령의 모양을 베낀 것에 그친다.
명령 문자열만 생성해 스냅샷에 남긴다 — 비용은 정의 한 장, 이득은 **누수가 지금 드러나는 것**이다.

실측된 누수 5곳:

| # | 새는 곳 | windows | posix |
|---|---|---|---|
| 1 | 경로 구분자 | yaml 에 `/` 와 `\` 혼용 (`D:/Deploy/…`) | `\` 불가 |
| 2 | **mtime 단위** | `LastWriteTimeUtc.Ticks` (100ns) | `stat -c %Y` (epoch초) — `ticksToEpochMs()` 가 OS별로 갈린다 |
| 3 | 환경변수 전개 | `%windir%` | `$VAR` |
| 4 | 인용 규칙 | `RemoteDeployMacroStage.js:273` 의 cmd 우회책 | 불필요 |
| 5 | 목록 출력 | `dir /b /ad` | `find -maxdepth 1 -type d` |

`tar` 는 Windows 10+ 내장이라 공통이다.

### `[D09]` 레시피 — 순서를 코드에서 선언으로 (`#P002-REQ8`)

#### 진단: 원자 스텝은 이미 있는데 매크로가 쓰지 않는다

`PipelineEngine.js:44-66` 에 이미 등록된 스테이지:

```
sync · upload · chain_call · extract · iis_control · fs_rename
sync_static · health_check · backup_cleanup · archive
```

**그런데 `LocalDeployMacroStage` 는 이 이름을 하나도 쓰지 않는다.**
`new IisControlStage()` · `new FsRenameStage()` 를 직접 만들고 **순서는 JS 코드**다.
`RemoteDeployMacroStage` 도 같다 — scp → 해제 → 정지 → 스왑 → 시작 → 정리가 전부 매크로 본문이다.

→ 어댑터(`[D01]`~`[D05]`)를 넣어도 **순서가 코드에 있어 매크로를 열어야 한다.**
`#P002-OQ1` 결정("열리는 파일 수를 0으로")을 만족하려면 이 층이 반드시 필요하다.

#### 목표 모델은 젠킨스다

| 젠킨스 | 여기 | 상태 |
|---|---|---|
| `steps { }` 안의 스텝 = 플러그인 | 원자 스테이지 | **이미 있음** |
| `Jenkinsfile` 의 stage 순서 | 레시피 | **없음 — 이 과제의 빠진 칸** |
| 플러그인을 추가해도 코어 불변 | 정의 파일 추가로 끝나야 하는 것 | 목표 |

```yaml
# 내장 레시피 — 코드가 아니라 정의
recipes:
  remote_deploy:
    - upload:  { from: "${archive_path}", to: "${upload_path}" }
    - extract: { file: "${remote_file}", to: "${temp_path}" }
    - server:  { action: stop,   if: requires_stop }
    - swap:    { live: "${web_deploy_path}", staged: "${temp_path}", backup: "${backup_path}" }
    - server:  { action: start,  if: requires_stop }
    - server:  { action: reload, unless: requires_stop }
    - cleanup: { root: "${backup_root}" }
```

`if:` / `unless:` 는 **이미 있는 문법**이다(`deploy_shore.yaml:213-217`). 새로 만들지 않는다.

#### ⚠️ 반대 위험 — 막지 않으면 원점으로 되돌아간다

매크로를 전부 분해해 사용자가 순서를 직접 쓰게 하면 **"shell 스크립트가 어렵다"가
YAML 로 되돌아온다.** YAML 로 쓴 셸 스크립트가 될 뿐이고, 그것은 이 프로젝트가
피하려던 바로 그것이다(§1 설계 원점).

**완화 — 내장 기본 레시피를 두고 덮어쓰기는 선택으로 한다.**

| 사용자 | 쓰는 것 | 사용감 |
|---|---|---|
| 일반 프로젝트 (90%) | `- remote_deploy: { group: deploy }` 한 줄 | **지금과 동일** |
| 특수 케이스 | 프로젝트 YAML 에 `recipes:` 를 써서 덮음 | 필요한 만큼만 |

젠킨스의 Declarative(기본형) ↔ Scripted(자유형) 구도와 같다.
**스왑 실패 시 롤백 같은 위험 구간은 레시피로 열지 않는다** — `swap` 원자 스텝 안에
가둔다. 선언으로 뺄 것은 순서이지 안전장치가 아니다.

### `[D10]` 확정 구조 — 덩어리는 스크립트, 판단은 Node ⭐ 채택

**2026-09-17 보스 확정.** `[D02]`·`[D05]` 의 범위가 이 결정에 따라 조정된다.

#### 경계

| | 맡는 일 | 근거 |
|---|---|---|
| **스크립트(bat/sh)** | 판단이 없는 **덩어리 작업** — 정지·백업·스왑·시작·롤백 | 왕복이 줄고, 라이브가 빈 시간이 짧아진다 |
| **Node** | **판단** — 업로드 · 압축(pack) · 해제 후 루트 판정 · `preserve_config` 신선도 · 백업 보관정책 · health check | 정책이 배치 파일로 흩어지면 테스트가 불가능해진다 |

이 경계는 새 규칙이 아니라 이 저장소가 이미 쓰던 것이다 —
`#cleanupRemote()` 주석: *"목록만 ssh 로 받아 오고 **판단은 로컬에서** 한다."*

#### 파일 배치

```
docs/design/template/windows/       저장소 원본 (deploy_shore.yaml 과 같은 자리)
    deploy.bat           정지 → 백업 → 스왑 → 시작 (+실패 시 즉시 원복)   ← 웹서버 무관, 불변
    rollback.bat         백업본 복귀 (사후 · 사람이 판단해 호출)
    webserver_iis.bat    stop|start|reload · 종료코드 정규화             ← 종류별로 이 파일만 추가
docs/design/template/linux/         2단계
    deploy.sh · rollback.sh · webserver_nginx.sh   (같은 환경변수 규약)
```

**`deploy.bat` 은 웹서버를 모른다.** `WS_TYPE` 으로 `webserver_<type>.bat` 을 골라 부르므로
nginx 지원 = **파일 하나 추가**이고 `deploy.bat` 은 열리지 않는다 (`#P002-OQ1` 의 목표).
미등록 타입은 조용히 건너뛰지 않고 `4` 로 멈춘다 — 건너뛰면 폴더만 갈아치우고
**옛 프로세스가 새 파일을 서비스한다.**

#### 배치 — 공용과 프로젝트별을 가른다 (2026-09-17 확정, `#P002-OQ4`)

| 스크립트 | 프로젝트마다 다른가 | 자리 |
|---|---|---|
| `build_*.bat` · `copy_static_*.bat` | ✅ | **프로젝트별** (`profile_dir`) |
| `deploy.bat` · `webserver_*.bat` | ❌ | **공용 한 벌** (`${tool_home}/scripts/windows`) |

**실측**: 프로젝트 루트 개념은 이미 있다 — `profile_dir = D:/Deploy/jenkins/project_hlngs`
(pubxml 4개 + `build_shore.bat` + `copy_static_shore.bat` 이 거기 산다).
`deploy_shore.yaml:43` 주석이 이미 *"스크립트는 게시 프로파일 옆(profile_dir)에 산다"* 고 말한다.
**새 변수가 필요 없고 값만 옮기면 된다.**

⚠️ **`D:\Deploy\hlngs` 는 현재 빌드 산출물 폴더다** (`build\MFM_QA.Shore\` 아래 DLL 4,639개).
설정을 그대로 두면 산출물과 섞이므로 `config\` 로 한 겹 넣는다.

배치·전달은 **(b) 수동 + (e) 별도 scp** 로 확정. 전달 경로는 `${upload_path}/_scripts/` —
`upload_path` 가 이미 프로젝트별이라 격리가 따라오므로 **새 변수를 두지 않는다.**

**스크립트는 한 벌이다.** 원격·로컬로 나누지 않는다 — 배포서버에서 실행되는 것은 같고,
다른 것은 호출 경로(`node 직접` vs `node → ssh`)뿐이다. 나누면
`IisControlStage` ↔ `#iis` 복붙이 그대로 재현된다.

#### `webserver.*` 가 판정을 흡수한다 → `[D02]` 판정표 불필요

지금 `BENIGN`/`FATAL` 출력 파싱이 필요한 이유는 `appcmd` 의 종료코드를 Node 가 그대로
받기 때문이다("이미 멈춤"도 0이 아니다). 스크립트가 한 겹 흡수해 **종료코드를 정규화**하면
Node 는 출력을 파싱할 일이 없다.

| 종료코드 | 뜻 |
|---|---|
| `0` | 성공 (**"이미 원하는 상태" 포함**) |
| `3` | 권한 부족 |
| `4` | 대상 없음 (사이트/서비스 이름 오류) |
| 그 외 | 알 수 없는 실패 |

→ **새 웹서버 = `webserver_<종류>.*` 추가. `deploy.*` 는 불변.**
`[D02]` 의 YAML 어댑터 정의는 걷어내고 이 규약으로 대체한다.
`--dry-run` 관찰성은 스크립트가 `DRY_RUN` 환경변수를 받아 **실행 대신 계획을 출력**해 보전한다.

#### 인자 규약 — 환경변수. 기본값을 채우지 않는다

위치 인자는 **순서를 틀리면 조용히 잘못 동작한다.** 기존 선례(`check_param.bat`,
`fnProjectBuild` 의 `set WORKSPACE_DIR=…`)가 이미 환경변수이므로 그쪽을 따른다.

⚠️ **다만 `check_param.bat` 의 기본값 자동 채움은 따라가지 않는다.**

```bat
if not defined TAG_DEPLOY set TAG_DEPLOY=test    rem ⛔ 안 넘겨도 조용히 test 로 배포된다
```

`PipelineEngine.js:32-34` 가 정확히 이것을 경계한다 — *"기본 환경을 정하지 않는다.
'dev' 같은 이름을 코드가 들고 있으면 yaml 이 환경을 빠뜨렸을 때 **에러 없이** 그 환경으로
배포된다."* **필수 변수는 없으면 즉시 실패**시킨다(`exit /b 2`).

#### 파일명·인코딩 규약 — 정본은 [06_배포_스크립트_규약.md](../../../design/배포/06_배포_스크립트_규약.md)

> ⚠️ **2026-09-17 정정.** 초안은 "bat 에 한글 금지"였고 근거로 `check_param.bat` 이 깨져 있다고 적었다.
> **둘 다 틀렸다.** 그 파일은 CP949 로 **정상 저장**돼 있었고, 깨져 보인 것은 Read 도구가
> UTF-8 로 해석했기 때문이다. 근거로 쓴 값의 출처를 한 단계 더 따라갔어야 했다(`Verification §3`).

실측 매트릭스 — **파일 인코딩과 콘솔 코드페이지가 일치할 때만 살아남는다.**

| 파일 | `chcp` | 결과 |
|---|---|---|
| CP949 | 949 | ✅ |
| UTF-8 | 65001 | ✅ |
| UTF-8 | 949 | ⛔ |
| CP949 | 65001 | ⛔ |

**BOM 은 영향이 없다** — 유무로 결과가 갈리지 않았고, cmd 가 BOM 때문에 죽지도 않는다.

* **기본은 ASCII.** 한글을 쓰려면 **UTF-8 저장 + 첫 줄 `chcp 65001 > nul`**. CP949 저장은 금지.
* **파일명은 ASCII, 공백 없이.** 공백은 따옴표를 부르고 그 따옴표가 `ssh "…"` 인용과 겹친다(`:273`).
* **`.gitattributes` 로 `*.bat` CRLF · `*.sh` LF 고정.**
* **`exit /b %ERRORLEVEL%` 로 끝낸다.** 없으면 종료코드가 새고 "출력 마지막 줄로 판정"이 재현된다.

**문서만으로는 지켜지지 않으므로 검사를 장치로 옮겼다** — `test/scriptEncoding.test.js`
(`Session Closing §6` (a) 모드). 실제로 이 규약을 작성하던 중 bat 주석에 한글 경로를 넣었고
**그 테스트가 잡아냈다.**

#### 왜 메시지를 파싱하지 않나 — 인코딩이 아니라 **로캘** 문제다

`chcp` 는 바이트 해석을 맞출 뿐 **메시지의 언어를 바꾸지 않는다.** 한글 Windows 는
`사이트를 찾을 수 없습니다`, 영문은 `The site does not exist` 를 낸다. 두 패턴을 다 넣어도
제3 로캘이면 빠진다. 그래서 `webserver.bat` 은 `appcmd list … /text:state` 로
**상태를 조회해** 판정한다 — 로캘에 의존하지 않는다.

#### 압축은 Node 에 남긴다

`ArchiveStage` 는 이미 `tar.exe` → `Compress-Archive` **폴백 구조**다
(*"bsdtar 가 훨씬 빠르지만 zip 쓰기 지원이 빌드에 따라 다르다"* `:14`).
bat 으로 옮기면 그 판단과 `exclude:` 전달이 흩어진다.
`unpack` 도 `tar -xf` 한 줄이고 해제 후 루트 판정(`:123`)이 Node 에 있으므로 함께 남긴다.

---

## 5. 작업 단위 (TASK)

> **순서가 처방이다.** TASK0 을 건너뛰면 이후 전부가 "안 깨졌다"를 증명하지 못한다.

### 0단계 — 기준선 (선행 · 생략 불가)

* ✅ `#P002-TASK0a`: `node:test` 도입 완료. `package.json` → `node --test "test/**/*.test.js"`.
  **의존성 추가 없음.** ⚠️ `node --test test/`(디렉터리 인자)는 Node 22.14 에서
  `MODULE_NOT_FOUND` 로 죽는다 — 글롭이어야 한다
* ✅ `#P002-TASK0b`: **현재 원격 명령열 캡처 완료** — `test/remoteDeployCommands.test.js`.
  `[D10]` 채택으로 용도가 바뀌었다: "리팩터링 전후 비교"가 아니라
  **`deploy.*` 가 재현해야 할 이식 명세**다.
  `RemoteDeployMacroStage` 가 `fs` 를 직접 쓰지 않아 **가짜 engine 주입만으로 실서버 없이** 잡힌다.
  → **기본 경로 ssh 11회** 확정 (preserve_config·백업삭제 제외)
* 🟡 `#P002-TASK0c`: Node 판단 로직 회귀 테스트 — `test/backupRetention.test.js` **완료(11건)**.
  남은 것: `configPreserve` 신선도 비교 · `interpolate` 변수 치환

> **TASK0b 에서 실증된 것** — fake ticks 값의 자릿수를 줄였더니 변환 결과가 **서기 3년**이 되었는데
> **예외 없이 로그의 날짜만 이상해졌다.** `[D08]` 누수 #2(mtime 단위)가 새는 방식이 정확히 이것이다.
> posix 의 `stat -c %Y`(epoch초)를 ticks 자리에 그대로 넣으면 같은 일이 벌어지고,
> **비교는 양쪽이 같은 기준이라 멀쩡해 보인다.**

### 1단계 — 스크립트 경계 확립 (실행 대상은 Windows)

* ✅ `#P002-TASK1`: 스크립트 규약 확정 — 가이드 [06_배포_스크립트_규약.md](../../../design/배포/06_배포_스크립트_규약.md)
  신규 + `.gitattributes` + **자동 검사** `test/scriptEncoding.test.js`(6건).
  샘플 2건(`build_dotnet_sample.bat`·`copy_static_sample.bat`)의 부정확한 주석
  (*"cmd misparses UTF-8 Korean"*) 정정. README 목차 갱신
* ✅ `#P002-TASK2`: `scripts/windows/webserver.bat` 작성·검증.
  `stop`·`start`·`reload`(= apppool recycle) + **종료코드 정규화**.
  검증: 인자누락 `2` · 잘못된 액션 `2` · 없는 사이트 `4`(stop·reload 모두)
* ✅ `#P002-TASK3`: `scripts/windows/deploy.bat` 작성·검증 — 정지 → 백업 → 스왑 → 시작
  (+스왑 실패 시 즉시 원복). 검증 13케이스 전부 통과 (실제 폴더 스왑·DRY_RUN 무변경 포함).
  `webserver.bat` 을 `call` 로 위임해 **웹서버 종류가 한 파일에만 산다**.
  **종료코드 `5` 를 새로 두었다** — 원복까지 실패해 라이브가 없는 상태. 사람이 고쳐야 한다.
  원복에 성공해도 종료코드는 실패(`1`)로 낸다 — 0 을 내면 **옛 빌드가 새 빌드로 배포된 것처럼 보고**된다
* ✅ `#P002-TASK4`: `rollback.bat` 작성·검증 (18케이스 전부 통과).
  **모드 둘을 그대로 이식** — `consume`(백업을 move, 소비. 실패본은 `_failed_` 로 보존) ·
  `copy`(robocopy 로 복제해 원본 보존, 현재 라이브는 **새 백업**으로).
  `robocopy` 는 **정상 복사에도 1 을 내므로 `if errorlevel 8` 로 가른다** — 그대로 실패로 보면
  성공한 롤백이 전부 실패가 된다.
  🔴 **새 함정 발견**: **중첩 괄호 안의 `exit /b` 는 종료코드를 잃는다.**
  메시지는 찍히는데 호출자는 0 을 받았다. `goto` 로 평탄화하고 `06_` 가이드 §4 에 박았다
* ✅ `#P002-TASK5`: 스크립트 배치·전송 완료 — `src/deploy/scriptSync.js` 신규.
  `#P002-OQ4` 확정안대로 **(b) 사람은 도구 서버 한 곳에만 두고, (e) 도구가 배포마다 scp 로 민다**
  (`${script_dir}` → `${upload_path}\_scripts\windows`). 배포서버에 손으로 올릴 필요가 없다.
  **매번 덮어쓴다** — "있으면 건너뛴다" 는 옛 판이 남는 쪽이 더 위험해서 넣지 않았다.
  종료코드 규약이 바뀌면 Node 가 실패를 성공으로 읽고 옛 프로세스가 새 파일을 서비스한다.
  **웹서버를 멈추기 전, 업로드보다도 먼저** 한다 — 스크립트가 없다는 사실을 Step 3 에서 만나면
  업로드·압축해제를 다 하고 실패하고, 롤백에서는 **서비스만 멈춘 채로** 끝난다.
  와일드카드를 원격에 맡기지 않는다: **cmd 는 `*.bat` 을 펼치지 않고**,
  `scp -r <폴더>` 는 대상이 이미 있으면 OpenSSH 판에 따라 한 겹 더 들어간다. 파일을 나열한다.
  `sync_scripts: false` 로 끌 수 있다(배포서버에 직접 배치한 경우).
  검증: `test/scriptSync.test.js` 7건(실제 임시폴더 사용) + 스냅샷 갱신(ssh 9→10회) + 순서 단언 3건.
  🔴 **스냅샷 필터 두 곳이 새 명령에 걸렸다** — scp 전송 목록에도 `webserver_iis.bat` 문자열이 들어
  "웹서버 제어 2회" 단언이 3을 셌고, `find(c => c.startsWith('scp '))` 가 산출물이 아닌 스크립트
  전송을 집었다. 스냅샷 테스트가 **자기 역할을 한 자리**다
* ✅ `#P002-TASK6`: `IisControlStage` → `ScriptControlStage` 대체 완료. **복붙 이중화 해소**.
  제거된 사본 셋 — `IisControlStage`(파일 삭제, git `b838eb6` 에 이력) ·
  `RemoteDeployMacroStage.#iis()` · `RemoteRollbackMacroStage.#iis()`.
  덤으로 **`#sshRunner` 도 두 파일에 복사돼 있어** `src/deploy/sshRunner.js` 로 합쳤다.
  스테이지 이름은 `web_server_control`, 구명 `iis_control` 은 별칭으로 남긴다 (#P002-REQ5).
  🔴 **인용 버그를 잡았다** — 원격에서 스크립트 경로를 따옴표로 감싸 `ssh "…"` 인용과 겹쳤다.
  `quote:false` 로 가르고 **원격 경로 공백은 즉시 실패**시킨다 (조용히 잘리던 자리).
  검증: 스냅샷 갱신(ssh 11→9회) + `ScriptControlStage`·`remoteEnv` 단위 12건 + `set A=B&` 체인 실행 확인
* ✅ `#P002-TASK7`: 인라인 원격 명령을 스크립트 1회 호출로 치환 완료 — 배포·롤백 **양쪽**.
  **ssh 왕복 10회 → 6회**(배포), **6회 → 3회**(롤백).
  하지만 이득은 왕복 수가 아니다 — **라이브가 비는 구간이 ssh 왕복 사이에서 사라졌다.**
  두 `move` 사이에는 라이브 폴더가 존재하지 않는데, 그 구간이 왕복을 끼고 벌어져 있으면
  **연결이 끊기는 순간이 곧 "라이브 없음"** 이 되고 되돌릴 주체가 없다.
  롤백 쪽이 더 나빴다 — 이미 한 번 실패해서 되돌리는 길이다.
  Node 에 남긴 판단: 무엇을 올릴지 · 해제 결과가 비었는지 · `preserve_config` 신선도 ·
  백업 보관정책 · **어느 백업으로 되돌릴지** · 그리고 **되돌릴 수 있는 상태인지**.
  🔴 **`1` 과 `5` 의 구분이 여기서 결정적이 됐다.** 중간 지점을 못 보게 된 대가로
  무장(rollbackArmed) 판단을 종료코드로만 내린다 — `0`·`5`·미지코드는 무장, `1`~`4` 는 안 한다.
  라이브가 없는데 `1` 을 내면 되돌릴 수 있는 것을 못 되돌리고, 반대면 롤백이 없는 백업을 찾다
  멈춰 **진짜 사고를 소음에 묻는다.** `06_` 가이드 §4 에 표로 박았다
  🔴 **`manage_iis:false` 게이트 버그를 잡았다** — TASK5 의 스크립트 전송을 `manageIis` 로
  묶어 뒀는데, TASK7 이후 **폴더를 옮기는 것도 스크립트**라 웹서버를 안 만져도 스크립트가 필요하다.
  그대로 뒀으면 `manage_iis:false` 인 프로젝트에서 배포가 통째로 죽었다
  덤: 종료코드 표를 `src/deploy/scriptExit.js` 한 곳으로, 공백 검사(`assertRemotePath`)를
  네 군데 사본에서 `remoteEnv.js` 한 곳으로 모았다.
  제거된 사본 — `RemoteRollbackMacroStage.#webserver()` · `RemoteDeployMacroStage.#rollbackSwap()`
  (원복은 이제 스크립트 안에서 끝난다).
  검증: 배포 스냅샷 갱신 + **롤백 스냅샷 신규**(`test/remoteRollbackCommands.test.js`, 11건) —
  롤백 원격 경로는 지금까지 테스트가 없던 자리다
* ✅ `#P002-TASK7b`: **로컬도 스크립트로 통일** (2026-09-17 보스 확정).
  로컬에는 ssh 왕복이 없어 위 위험이 없지만, 남겨 두면 **스왑 순서가 두 곳에 산다.**
  실제로 갈라져 있었다 — `preserve`(운영 데이터 이월)는 **로컬에만** 있던 기능이고,
  합치니 **원격에도 저절로 생겼다.** 쪼개진 구현을 합치면 이런 것이 메워진다.
  `deploy.bat` 에 `DP_PRESERVE` 를 새로 뒀다 — 정지 **후** · 스왑 **전**에 도는 자리라
  Node 가 중간에 낄 수 없다. 실패하면 스크립트가 그 자리에서 원복한다.
  🔴 **이름 충돌을 발견했다** — 타임스탬프가 초 단위라 **같은 초에 배포하고 강제 롤백하면**
  백업 이름이 겹친다. 스크립트는 겹치면 `1` 로 거부하는데(옳다. `move` 는 기존 폴더
  **안으로** 들어가 성공한 것처럼 보인다) 그러면 롤백이 통째로 막힌다.
  `uniquePath()` 로 Node 가 비켜 간 이름을 준다. 예전 `FsRenameStage` 는 반대로
  **기존 대상을 지우고** 덮어썼다 — 겹친 상대가 멀쩡한 백업이면 그것을 지웠다.
  🔴 **동작이 둘 바뀐다 (의도한 조임)**
  ① 라이브 폴더가 없으면 `4` 로 멈춘다. 예전 `FsRenameStage` 는 *"없으면 건너뜀"* 이라
  **오타 난 `web_deploy_path` 에 새 폴더를 만들고 성공을 보고했다.**
  (진짜 최초 배포는 영향 없다 — 웹서버가 없는 경로를 가리킬 수 없으므로 폴더는 이미 있다)
  ② 백업 경로가 이미 있으면 거부한다(위 `uniquePath` 가 정상 경로에서는 막아 준다)
  🔴 **환경변수 누수를 막았다** — 로컬은 `process.env` 를 물려받으므로 계약 키를 빠뜨리면
  부모(젠킨스)의 같은 이름이 흘러든다. `WS_SKIP` 하나가 새면 **웹서버를 세우지 않고
  폴더만 갈아치운다.** 계약 키를 전부 명시(빈 값 = Windows 에서 변수 삭제)한다.
  검증: **`test/localDeploy.test.js` 10건 — 진짜 스크립트를 진짜 폴더에 돌린다.**
  로컬 경로는 지금까지 실행 테스트가 **하나도** 없었고(`fs` 가 매크로에 박혀 있어
  가짜 engine 으로는 아무것도 확인되지 않았다), 스왑을 스크립트로 넘기면서 비로소 붙었다.
  `deploy.bat` 의 `DP_PRESERVE` 자체는 별도 실폴더 검증 22건 통과
* `#P002-TASK8`: 레시피 층 도입 (`[D09]`) — 내장 기본 레시피 + 덮어쓰기.
  `if:`/`unless:` 는 기존 문법 재사용
* `#P002-TASK9`: 하위호환 승격 + `--dry-run` 출력 (`[D06]`)
* 🟡 `#P002-TASK10`: 검증 — 진행 중.
  ✅ **로컬 경로 실행 검증 완료 (2026-09-17).** `--dry-run` 파싱·변수해석 + **샌드박스
  실전 11건** — 진짜 CLI 로 `local_deploy` → `--rollback=1` 까지 끝까지 돌렸다
  (운영 IIS 는 건드리지 않았다. `manage_iis:false` + `D:\temp\p002_sandbox`).
  확인된 것: 새 빌드가 라이브로 · **서버 설정이 소스 설정을 이김** · 운영 데이터 이월 ·
  백업에 옛 빌드 · 강제 롤백 후 원본 백업 보존.
  🔴 **`uniquePath` 가 실제로 발동했다** — 배포와 강제 롤백이 같은 초에 일어나
  `..._backup_20260917_150744_2` 로 비켜 갔다. 없었으면 그 롤백은 `1` 로 실패했다.
  이론이 아니라 **첫 실행에서 바로 걸린 자리**다.
  🔴 **`tool_home` 이 소스 실행에서 어긋난다** — `node src/deploy/deploy-cli.js` 로 돌리면
  진입점이 `src/deploy` 라 `script_dir` 기본값이 `src/deploy/scripts/windows` 가 된다.
  배포된 도구(번들 한 장이 루트)는 정상이라 **개발할 때만** 어긋난다. 더 나쁜 것은
  **종료코드가 거짓말을 한다**는 점이다 — cmd 는 없는 배치 파일에 `1` 을 내는데
  `1` 은 계약상 *"배포 실패 - 라이브는 살아 있음"* 이다. `assertScript()` 로
  부르기 전에 막고 찾은 경로를 보여 준다.
  ✅ **실서버 배치 후 재검증 (2026-09-17 2차).** 보스가 파일을 옮긴 뒤
  `D:\Deploy\bas-deploy`(도구·스크립트) · `D:\Deploy\hlngs\config`(yaml·bat·pubxml) 로
  실제 경로에 돌렸다. **버그 셋이 나왔다 — 전부 실행해 봐야만 나오는 것들이다.**

  🔴 **(1) `.bat` 가 전부 LF 였다. 가장 위험하다.**
  `The system cannot find the batch label specified - ensure_denied` 로 죽었다.
  cmd 는 배치 파일을 **바이트 오프셋으로 되감아** 라벨을 찾으므로 CR 이 없으면
  줄 중간에 내려앉는다. **간헐적이라 더 나쁘다** — 같은 파일의 다른 `goto` 는 멀쩡했고
  TASK7b 의 실폴더 22건도 전부 통과했다. 오프셋에 달렸을 뿐이다.
  원인은 Write 도구가 LF 로 저장한 것이고, 그 파일이 **그대로 서버에 복사됐다.**
  `.gitattributes` 로는 못 막는다(git 체크아웃 때만 고친다).
  → `test/scriptEncoding.test.js` 에 검사 추가. **넣자마자 두 개를 더 잡았다** —
  `dist/basDeploy.bat` · `dist/gitAskpass.bat`, **젠킨스가 실제로 부르는 런처**다.
  다섯 파일 + 서버 사본 전부 CRLF 로 교정(내용 동일 확인).

  🔴 **(2) 권한 부족이 `4`(대상 없음)로 보고됐다.**
  `:target_of` 가 `:need_admin` 보다 먼저 돌고 `for /f` 는 appcmd 의 종료코드를 삼킨다.
  그래서 "못 읽음"과 "없음"이 구분되지 않았다 — 운영자는 있지도 않은 오타를 찾게 된다.
  실측: appcmd 는 권한 오류에 **5**, `net session` 은 **2**.
  → `:target_of` 가 `WS_READABLE` 을 따로 세우고 `3` 으로 가른다.

  🔴 **(3) yaml 주석이 깨지는 `--params` 예시를 보여주고 있었다.**
  `--params={"a":"b"}` 는 cmd 가 따옴표를 구분자로 먹어 `{a:b}` 가 된다.
  `04_젠킨스_잡.md` 에는 정답(`--params="{\"a\":\"b\"}"`)이 있는데
  **사람이 먼저 보는 yaml 주석만 X 형태**였다. 두 템플릿 모두 교정.

  검증 결과: 새 `server_config/<사이트>` 에서 설정 보전 정상(`라이브 유지` 판정) ·
  `deploy.bat` 인자 정상 전달 · **`3` → "권한 부족" 한글 사유** · 롤백 올바르게 건너뜀 ·
  라이브 4,621개 파일 **무손상** · 임시폴더 정리 · 헛백업 없음.

  ⛔ **남은 것: IIS 실제 정지·스왑.** `appcmd` 는 관리자 권한이 필요하고 이 세션은
  승격되지 않았다(젠킨스는 서비스라 UAC 를 안 받으므로 거기서는 된다).
  **관리자 권한으로 재실행 예정** — `#P002-TASK10b`.
  남은 것 2: 원격(qa) 프로파일 실환경 확인 — 배포서버 접속이 필요하다
* ✅ `#P002-TASK10b`: **관리자 권한 재실행 — 완료 (2026-09-17 3차).**
  배포: 정지 → 백업(4,621) → 스왑(4,623) → 기동 · 설정 해시 보전 · `healthz=200`.
  `--rollback=1`: 라이브 4,621 복귀 · **원본 백업 보존** · 밀려난 배포본은 `_backup_<시각>` 으로 aside · `healthz=200`.
  🔴 **승격하자마자 버그 하나가 더 나왔다 — `webserver_iis.bat` 이 있는 사이트를 `4`(없음)로 판정.**
  `for /f ('"%APPCMD%" list ... "%WS_OBJ%" ...')` 는 cmd /c 가 **첫·끝 따옴표를 벗겨** 명령이 깨지고
  출력이 비어 "없음"이 된다. 비승격에서는 `3` 이 먼저 걸려 **가려져 있었다.**
  → 명령 전체를 따옴표 한 겹 더 감싼다(`('""%APPCMD%" ... 2>nul"')`, 안쪽은 캐럿 없이).
  `:state_of` 도 같은 결함이라 늘 `Unknown` 이었다. 실측: 감싸기 전 `[]` / 후 `[MFM.SHORE_QA]`.
  실행 메모: 소스 실행은 `--params` 에 `script_dir` 을 넘겨야 한다(`tool_home`=`src\deploy`).
  서버 yaml 기본 `environment` 가 `qa`(원격)로 바뀌었으므로 로컬 검증은 `environment:dev` 를 **명시**한다.
  이하 원래 계획 —
  승격된 콘솔에서 아래를 돌린다. 확인할 것은 스왑 구간 전체다 —
  IIS 정지 → 백업 → preserve → 스왑 → 기동, 그리고 `--rollback=1` 복귀.
  ```
  node src\deploy\deploy-cli.js --yaml=<deploy_only.yaml>
  ```
  ⚠️ 라이브는 `D:\Deploy\MFM.SHORE_QA`(4,621개)다. 실패하면 백업이 유일한 사본이다
* ✅ `#P002-TASK10a`: `deploy_shore.yaml` 최신화 — `web_server_type`·`web_server_name` 으로
  전환(구명 `iis_site` 도 계속 읽는다), `script_dir`·`sync_scripts`·`preserve` 주석 추가,
  `upload_path` 공백 금지 경고.
  덤으로 `deployState.CARRY_KEYS` 가 **`iis_site` 만 이월**하고 있던 것을 고쳤다 —
  그룹을 나눠 부르면(`--only=deploy`) 새 이름이 통째로 빠지는 자리였다

### 2단계 — Linux 실투입 (필요해지는 시점에)

> 1단계가 끝나면 이 단계에서 **기존 파일은 열리지 않는다.** 그것이 1단계의 목표다.

* `#P002-TASK11`: `scripts/linux/` 작성 — 같은 이름 · 같은 환경변수 규약 (파일 추가)
* `#P002-TASK12`: `webserver_nginx.sh` 등 웹서버별 스크립트 추가
* `#P002-TASK13`: Linux 원격 실환경 검증

### 별도 트랙 — SSH 세션 (`#P002-OQ2` 확정 후)

* `#P002-TASK14`: 접속정보 이전 (config · 환경변수)
* `#P002-TASK15`: `#sshRunner` 내부를 `ssh2` 세션으로 교체. **시그니처 유지**
  → 축을 가른 덕에 위층은 바뀌지 않는다
* `#P002-TASK16`: `scp` 업로드를 같은 세션의 sftp 로 통합

---

## 6. 변경 대상 파일

| 파일 | 변경 |
|---|---|
| `package.json` | `test` 스크립트를 `node --test` 로 교체 (의존성 추가 없음) |
| `test/` | **신규** — 명령 스냅샷 (`[D08]`). **TASK0b 에서 가장 먼저** |
| `.gitattributes` | **신규/수정** — `*.bat text eol=crlf` (`[D10]`). ⚠️ 이것만으로는 못 막는다 — `test/scriptEncoding.test.js` 의 CRLF 검사가 정본 |
| `script/windows/` | **신규** — `deploy.bat` · `rollback.bat` · `webserver_iis.bat` (`[D10]`). 폴더명은 **단수 `script`** (실서버 배치에 맞춤) |
| `script/linux/` | **2단계** — 같은 이름 · 같은 규약 |
| `src/deploy/deployState.js` | `CARRY_KEYS` 에 `web_server_*`·`script_dir` 추가 (TASK10a) |
| `src/deploy/stages/IisControlStage.js` | → `ScriptControlStage.js` 로 대체 |
| `src/deploy/recipes/` | **신규** — 내장 기본 레시피 (`[D09]`) |
| `src/deploy/scriptSync.js` | **신규** — 공용 스크립트 원격 전송 (TASK5) |
| `src/deploy/scriptExit.js` | **신규** — 종료코드 표 한 벌 (TASK7). `06_` §4 의 사본 |
| `src/deploy/sshRunner.js` | **신규** — 두 매크로에 복사돼 있던 `#sshRunner` 통합 (TASK6) |
| `src/deploy/remoteEnv.js` | **신규** — 원격 `set A=B&` 체인 조립 (TASK6) |
| `src/deploy/stages/RemoteDeployMacroStage.js` | `#iis()` 제거, 공통 스테이지 사용 + Step 0 스크립트 동기화 |
| `src/deploy/scriptArgs.js` | **신규** — 목록 값 조립·검증 (`DP_PRESERVE`) |
| `src/deploy/backupRetention.js` | `uniquePath()` 추가 — 초 단위 타임스탬프 충돌 회피 |
| `src/deploy/stages/LocalDeployMacroStage.js` | 인라인 `fs` 스왑 → `deploy.bat` 1회 (TASK7b) |
| `src/deploy/stages/LocalRollbackMacroStage.js` | 인라인 `fs` 스왑 → `rollback.bat` 1회 (TASK7b) |
| `docs/design/template/windows/deploy.bat` | `DP_PRESERVE` 구간 추가 (TASK7b) |
| `src/deploy/stages/RemoteRollbackMacroStage.js` | 인라인 명령 5회 → `rollback.bat` 1회 (TASK7) |
| `src/deploy/PipelineEngine.js` | 스테이지 등록명 `iis_control` → `web_server_control` (구명 별칭 유지) |
| `src/deploy/deploy-cli.js` | `--dry-run` 에 승격 결과 출력 |
| `docs/design/template/deploy_shore.yaml` | 새 형식 주석 추가 (**값은 유지**) |
| `docs/design/template/deploy_sample.yaml` | 새 형식으로 갱신 |

---

## 7. 문서/자산 현행화 및 인수

* [ ] `docs/design/배포/02_운영_배포_흐름.md` — IIS 고정 서술을 어댑터 기준으로 수정
* [ ] `docs/design/배포/05_신규_프로젝트_설정.md` — `web_server` 설정 절 추가
* [ ] `docs/design/배포/README.md` — 지원 대상 표 갱신
* [ ] 어댑터 추가 방법을 `docs/guides/` 에 정본으로 기록 (소스 수정 없이 붙이는 절차)

### 보스가 직접 하는 배치 작업 — ✅ **완료 (2026-09-17)**

* [x] `profile_dir` 이전 — → `D:\Deploy\hlngs\config` (pubxml 3개 · `build_shore.bat` ·
      `copy_static_shore.bat` · `deploy_shore.yaml` 확인)
* [x] 공용 스크립트 배치 — → **`D:\Deploy\bas-deploy\script\windows\`**
      ⚠️ 폴더명이 `script`(단수)다. 코드 기본값을 여기에 맞췄다(`defaultScriptDir`)
      ⚠️ **(b) 수동 배치라 빌드가 갱신하지 않는다.** 스크립트를 고치면 다시 올릴 것
      ✅ 배포서버(원격)에는 올릴 필요 없다 — TASK5 가 배포마다 scp 로 민다
* [x] 빌드 산출물 — `D:\Deploy\hlngs\build\MFM_QA.Shore`
* [x] 서버 설정 사본 — `D:\Deploy\hlngs\server_config\MFM.SHORE_QA\`
      (`web.config` · `appsettings.json`) → `config_backup` 을 여기로 옮겼다

---

## 8. 인수인계 (2026-09-17 세션 종료)

### 🔴 다음 세션 최우선 — 관리자 권한 재실행 (`#P002-TASK10b`)

이번 세션은 **IIS 제어 직전까지만** 검증됐다. `appcmd` 가 관리자 권한을 요구하고
작업 세션이 승격되지 않아 `3`(권한 부족)에서 정상적으로 멈췄다.
젠킨스는 서비스라 UAC 를 안 받으므로 거기서는 동작한다.

**승격된 콘솔에서 확인할 것 — 스왑 구간 전체다.**

```
node src\deploy\deploy-cli.js --yaml=<deploy_only.yaml>       # 정지→백업→preserve→스왑→기동
node src\deploy\deploy-cli.js --yaml=<deploy_only.yaml> --rollback=1   # 복귀
```

* 라이브: `D:\Deploy\MFM.SHORE_QA` (**4,621개 파일**). 실패하면 백업이 유일한 사본이다
* 시작 전 `backup.dry_run: true` 로 한 번 돌려 삭제 대상을 눈으로 보는 것을 권한다
* 확인 지점: IIS 가 실제로 멈추는가 · 백업이 생기는가 · 스왑 후 기동되는가 ·
  `--rollback=1` 이 원본 백업을 남기고 되돌리는가

### 확인이 필요한 것

* **`build_path` 폴더명** — 실물이 `MFM_QA.Shore` 라 dev·qa 를 거기에 맞췄다.
  **`prod` 는 근거가 없어 `MFM.SHORE` 그대로 뒀다.** 맞는지 확인할 것
* **번들 재배치** — `D:\Deploy\bas-deploy\bas-deploy.js` 는 **옛 코드**다.
  이번 세션의 변경(스크립트 위임·`uniquePath`·종료코드 표)이 들어가려면 다시 빌드·배치해야 한다.
  그전까지 젠킨스 잡은 옛 동작을 한다
* **`#P002-OQ2`** — SSH 세션 트랙 착수 여부

### 남은 작업

* `#P002-TASK8`: 레시피 층 (`[D09]`) · `#P002-TASK9`: `--dry-run` 출력 (`[D06]`)
* `#P002-TASK10`: 원격(qa) 실환경 — 배포서버 접속 필요
* 2단계(Linux) · SSH 세션 트랙

### ⚠️ 이 과제에서 배운 것 — 다음 세션이 반복하지 말 것

1. **`.bat` 는 CRLF 다.** Write 도구는 LF 로 저장하고, cmd 의 `goto` 는 **간헐적으로** 깨진다.
   `npm test` 가 잡지만, 새 스크립트를 만들면 **저장 직후 확인할 것**
2. **`--params` 는 `--params="{\"k\":\"v\"}"`.** 다른 형태는 cmd 가 따옴표를 먹는다
3. **`%ERRORLEVEL%` 를 같은 줄에서 읽지 않는다.** 파싱 시점에 펼쳐진다.
   이번 세션에 이 함정으로 **잘못된 측정값을 한 번 보고했다**
4. **실행해 보기 전까지는 모른다.** 이번 버그 셋은 전부 단위 테스트를 통과한 코드에서 나왔다
