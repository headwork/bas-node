# 배포 설계

YAML 기반 배포 파이프라인(`src/deploy`)의 흐름 문서.

| 문서 | 내용 |
|---|---|
| [01_로컬_배포_흐름.md](01_로컬_배포_흐름.md) | 한 대의 서버 안에서 배포가 끝나는 경우 |
| [02_운영_배포_흐름.md](02_운영_배포_흐름.md) | 배포서버(젠킨스)와 운영서버가 분리된 경우 |
| [03_정적파일_빠른배포.md](03_정적파일_빠른배포.md) | 정적 파일만 바뀐 경우 — 빌드·스왑·재기동 생략 |
| [04_젠킨스_잡.md](04_젠킨스_잡.md) | 젠킨스 잡 구성 · 자격증명(`git_wesys`) 처리 |

## 공통 개념

### 실행

```
node src/deploy/deploy-cli.js --yaml=<경로> [--params='{"environment":"qa"}'] [--dry-run]
```

`--dry-run` 은 **아무것도 실행하지 않고** 해석된 변수와 단계 계획만 출력한다.
등록되지 않은 스테이지가 있으면 경고한다. 실행 전 확인용이다.

### 변수 조립 순서

뒤가 앞을 덮는다.

1. YAML 루트의 단순 설정값 (`git_url`, `deploy_path` 등)
2. `variables:` 블록
3. `--params` 외부 파라미터
4. `target[environment]` 프로파일 — 1~3 을 기준으로 먼저 치환한 뒤 덮어쓴다
5. `--params` 재적용 (외부 파라미터가 끝까지 최우선)

정의되지 않은 프로파일을 지정하면 **즉시 실패한다.** 조용히 빈 변수로 진행하면
스테이지가 엉뚱한 경로에 배포하기 때문이다.

### 민감 정보

`${env.VAR}` 로 `process.env` / `.env` 값을 주입한다.
치환된 값은 **로그 출력 시 마스킹**된다(`***(masked)`). URL 에 박힌 자격증명도 가린다.

> ⚠️ Git 서버가 **Bonobo Git Server** 인 경우 API 키 개념이 없다.
> `git_url` 에 자격증명을 넣으면 Windows 자격증명 관리자(GCM)나 Jenkins 에 등록된
> 정상 자격을 **덮어써서 인증이 실패한다.** 자격증명 없는 URL 을 쓰고 실행 주체에게 맡긴다.

### 스테이지 목록

| 스테이지 | 역할 |
|---|---|
| `git_sync` | 최초 clone, 이후 stash → fetch → checkout → pull |
| `c#_build` | 빌드 (`cmd` 로 명령 지정) |
| `archive` | 배포 산출물 압축 (`<name>_<yyyyMMdd_HHmmss>.zip`) |
| `extract` | 압축 해제 (`tar -xf` — gz/zip 자동 판별) |
| `local_deploy` | 백업 → 정지 → 교체 → 시작 → 백업 정리 |
| `local_rollback` | 최신 백업으로 복구 |
| `backup_cleanup` | 백업 보관 정책 단독 실행 |
| `iis_control` | IIS 사이트/앱풀 start·stop |
| `fs_rename` | 디렉터리 이름 변경 (EXDEV 폴백 포함) |
| `health_check` | HTTP 상태/본문 확인 |
| `other_server` | scp 업로드 + 원격 명령 |
| `confluence` | 문서 갱신 |
| `sync` · `build` · `upload` | 임의 명령 실행 |

### 조건부 실행

스테이지에 `if:` / `unless:` 를 붙이면 컨텍스트 변수 값에 따라 건너뛴다.

```yaml
- sync_static:
    if: changed_static_only        # 참일 때만 실행
- c#_build:
    unless: changed_static_only    # 참이면 건너뜀
```

값이 `false` · `0` · 빈 문자열이면 거짓이다. 조건은 `--dry-run` 계획에 함께 표시된다.

### 실패 처리

파이프라인이 실패하면 `rollback:` 이 실행된다. 정의는 세 형태를 받는다.

```yaml
rollback:                          # 1) 스테이지 목록
  - local_rollback: {}

rollback:                          # 2) 원격 스크립트
  script_dir: "D:/scripts"
  rollback_cmd: "rollback.bat"

rollback: "restore.bat"            # 3) 단일 명령
```

어느 형태에도 맞지 않으면 조용히 넘어가지 않고 CRITICAL 로그를 남긴다.
**롤백 실패는 원래 배포 에러를 덮지 않는다** — 삼키고 로그만 남긴 뒤 원본 에러를 전파한다.
