# Taxi Release Checklist

릴리스 때마다 실행하는 체크리스트. **GitHub Issues/RFC backlog ↔ CHANGELOG ↔ 코드 드리프트**를 구조적으로 방지하기 위한 문서. 2026-04-17 QUALITY_DIAGNOSIS의 HIGH-2 대응.

> 목표 시간: patch 릴리스 20분, minor 45분, major 2시간.

---

## 0. 릴리스 종류 결정

SemVer 2.0.0 기준:

| 성격                                                           | 예시                                                        | 버전 증가         |
| -------------------------------------------------------------- | ----------------------------------------------------------- | ----------------- |
| 버그 픽스, 내부 리팩터링, 문서                                 | JXA stat 파싱 개선, i18n 키 보완                            | patch (x.y.**z**) |
| 신규 툴·모듈, outputSchema 확대, 새 config 키 (백워드 호환)    | `generate_image` 추가, `allowNetwork` 선언형 도입           | minor (x.**y**.0) |
| config 스키마 breaking, 툴 시그니처 변경, 기본값 변경 (파괴적) | `allowSendMail` 기본값 변경, `update_reminder.name → title` | major (**x**.0.0) |

Breaking을 포함한 minor/patch는 **금지**. 직전 메이저에 묶어 둘 수 없으면 메이저로 올린다.

---

## 1. 사전 점검 (릴리스 직전)

### 1.1 브랜치·상태

- [ ] `main` 기준에서 시작 (또는 `release/vX.Y.Z` 브랜치)
- [ ] `git status` 클린
- [ ] `git pull --rebase origin main`

### 1.2 로컬 게이트

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `npm test`
- [ ] `npm run smoke`
- [ ] `npm run mcp:validate`
- [ ] `npm run verify:package`
- [ ] macOS 환경이라면 `npm run swift-build` · `cd swift && swift test` · `cd ios && swift test`
- [ ] `taxi doctor` 자체 실행이 성공 (CI 환경 외)

### 1.3 공개 계약 체크

- [ ] `npm run stats:check` — 툴/모듈/리소스 수와 `server.json`·`glama.json`·README·docs/site·i18n이 일치
- [ ] `npm run gen:manifest:check` — runtime tool schema와 `docs/tool-manifest.json` 일치
- [ ] `npm run gen:intents:check` — generated AppIntents drift 없음
- [ ] `npm run build:mcpb:check` — `.mcpb` manifest v0.3 치환, self-contained 번들 생성, `full/full` 교차 pack 부트 스모크 통과
- [ ] `npm run llms:check` — public LLM summary drift 없음
- [ ] `npm run version:check` — package/app/plugin/config version pin 일치
- [ ] `npm run i18n:check` — 9 로케일 키 동기화 통과
- [ ] `outputSchema` 추가·변경이 있다면 Zod `.safeParse` 테스트가 성공 응답과 에러 응답 모두에 대해 도는지 확인

### 1.4 취약점

- [ ] `npm audit --omit=dev` — production high 이상 0건 확인
- [ ] `npm audit --audit-level=moderate --omit=dev` — production moderate 건수 기록 (RFC 0003 단계 따라 blocking 여부 판단)
- [ ] 새로 도입된 의존성이 있다면 라이선스 감사 통과

### 1.5 iOS App Store submission gate

> **현재 판정: HOLD.** iOS 타겟은 정확히 8개 read-only tool만
> 실행합니다. `ios/AppStore/`의 기존 설명·프로모션·리뷰 노트·
> 프라이버시·스크린샷 초안은 18/40/92 tools, Notes/HealthKit,
> write actions, Foundation Models/`Ask Taxi` 등 현재 계약 밖 능력을
> 주장하므로 App Store Connect에 붙여넣거나 제출하면 안 됩니다.
> 아래 항목이 모두 통과하기 전에는 archive/upload/submission을 금지합니다.

- [ ] `npm test -- --runInBand tests/ios-preview-boundary.test.js` — Swift
      server, direct App Intent router, iOS `AppShortcutsProvider`가 동일한 8개 목록이고
      전부 `readOnly=true`, `destructive=false`
- [ ] `cd ios && swift test` — `tools/list`가 정확히 8개를 반환하고 write
      tool registration을 거부
- [ ] `npm test -- --runInBand tests/app-trust-center.test.js tests/codegen-destructive-dialog.test.js`
      — macOS는 App Intent action만 컴파일하고 `AppShortcutsProvider`/Siri phrase
      block은 `#if os(iOS)` 내부에만 존재
- [ ] 아래 stale-claim scan이 **0건**. 현재 초안에서는 의도적으로
      실패하며, 자산을 실행 계약에 맞게 새로 검수한 후에만 체크합니다.

  ```bash
  if rg -n -i \
    '18 tools|40 tools|92 tools|HealthKit|health_summary|Ask Taxi|Foundation Models|Calendar.*Reminders.*Notes|\*\*Notes\*\*|Send to Notes|creates? (a )?reminder|create, search|mark done|Writes \(|drafts? a summary' \
    ios/AppStore --glob '*.md'; then
    echo 'HOLD: App Store assets claim capabilities outside the 8-tool read-only iOS preview' >&2
    exit 1
  fi
  ```

- [ ] App Store description, promotional text, review notes, privacy answers,
      keywords, and screenshot plan name only the exact current contract:
      `get_location_permission`, `list_calendars`, `list_contacts`,
      `list_reminder_lists`, `list_reminders`, `search_contacts`,
      `search_reminders`, `today_events`
- [ ] Fresh device screenshots come from the candidate binary and visibly show
      `Running — 8 tools`; no 18/40/92 count, HealthKit, write action, or `Ask Taxi`
      flow remains

---

## 2. 문서 동기화 — **여기가 드리프트 방지의 핵심**

### 2.1 CHANGELOG.md

- [ ] `## [Unreleased]`에 기록된 항목을 새 버전 섹션으로 이동 (없으면 직접 작성)
- [ ] 분류: `Added` / `Changed` / `Fixed` / `Security` / `Deprecated` / `Removed` / `Breaking Changes`
- [ ] 테스트 변화가 크면 contract / artifact gate 변화와 총 테스트 수를 기록
- [ ] Breaking 항목은 **마이그레이션 가이드** 포함 ("envvar/flag가 이렇게 바뀜")
- [ ] 이슈·PR 번호(#NN) 참조

### 2.2 GitHub Issues / RFC backlog

- [ ] CHANGELOG delta와 대조하여 **완료된 이슈를 닫거나 릴리스 라벨을 갱신**
  - 새로 닫힌 contract / artifact gate를 릴리스 이슈와 연결
  - 릴리스 후속 작업은 P0/P1/P2 이슈로 분리하고 소유 범위를 명시
- [ ] 구현 상태가 바뀐 RFC는 본문 상태와 `docs/rfc/README.md` 인덱스를 함께 갱신
- [ ] npm·GitHub Release·registry 반영 상태는 이 체크리스트와 릴리스 이슈에 기록

### 2.3 버전·메타데이터

- [ ] `package.json` version
- [ ] `package-lock.json` version (npm이 자동 처리)
- [ ] `docs/site/locales/*.json` 버전 문구 (있을 경우)
- [ ] README의 버전·툴 수 언급
- [ ] `.well-known/mcp.json` (제공 시)
- [ ] `server.json` / `glama.json` / `smithery.yaml`

### 2.4 PR 템플릿·이슈 템플릿

- [ ] Breaking 변경이 있다면 이슈/PR 템플릿의 버전 placeholder 갱신

### 2.5 RFC 상태

- [ ] 이 릴리스로 구현 완료된 RFC는 `Status: Accepted → Implemented`로 이동
- [ ] 새로 수용된 RFC는 `Draft → Accepted`로 이동
- [ ] `docs/rfc/README.md`의 목록 테이블 갱신

---

## 3. 릴리스 실행

### 3.1 Dry release preflight (publish 금지)

- [ ] `npm run release:preflight` 로 universal npm tarball dry-run + default/`full/full` 부트, universal `.mcpb` 구조 + 부트 검증
- [ ] 앱을 포함하는 실제 릴리스 경로에서는 반드시 `npm run release:preflight -- --app`을 사용한다. 이 모드는 실제 MCP transport에서 read, 승인 write, 거부 write, emergency stop, HMAC audit 검증을 완주한 뒤 앱 산출물을 만든다.
- [ ] GitHub Actions **Release Preflight** workflow green 확인
- [ ] workflow artifact에 `taxi-X.Y.Z.mcpb`와 `Taxi-X.Y.Z-adhoc.zip`이 생성되는지 확인
- [ ] 이 단계는 태그·npm publish·GitHub Release를 만들지 않는다. 실패 시 publish 단계로 넘어가지 않는다.

### 3.2 커밋

- [ ] `chore(release): vX.Y.Z` 커밋에 위 모든 파일 동시 포함
- [ ] 외부 공개 승인 후 버전 커밋을 `main`에 push한다.
- [ ] CI가 통과한 exact `main` commit에 annotated `vX.Y.Z` tag를 만들고,
      tag 대상 SHA를 다시 확인한 뒤 별도 승인 범위 안에서 push한다. Signed
      candidate와 publish workflow 모두 이미 존재하는 immutable tag만 소비하며
      tag를 대신 만들지 않는다.

### 3.3 CI 통과 확인

- [ ] `ci.yml` 전 단계 green
- [ ] CodeQL·Scorecard 경고 신규 없음
- [ ] **외부 publish hard veto:** Settings → General → Releases에서 immutable
      releases를 활성화하고 UI(또는 admin-read API)에서 활성 상태를 재확인하기
      전에는 `cd.yml`을 dispatch하지 않는다. 이 설정은 이후 release에만
      적용되므로 사후 확인으로 대체할 수 없다. 공개 release 직후
      `release:verify`도 `isImmutable`, release attestation, 로컬의 exact
      `taxi-X.Y.Z.mcpb`/`Taxi-X.Y.Z.zip` 두 파일을 모두 검증한다.

### 3.4 Signed Taxi candidate (아직 publish 금지)

> **현재 판정: BLOCKED / UNVERIFIED.** `app.taxi`, `app.taxi.Widget`,
> `group.app.taxi`는 아직 Apple Developer에 등록·확보되지 않았고, 두
> Developer ID provisioning profile도 생성되지 않았습니다. 외부 공개 승인 전에는
> App ID, App Group, profile을 등록·생성하지 않습니다. 아래 profile secret이 없는
> 동안 signed candidate workflow가 실패하는 것이 의도된 fail-closed 동작입니다.

- [ ] Settings → Environments → `release`에 required reviewer를 설정하고,
      administrator bypass를 끄고, custom deployment tag policy `v*.*.*`
      (`type: tag`)를 설정한다.
- [ ] `node scripts/verify-release-environment.mjs --repo=heznpc/Taxi --tag=vX.Y.Z`
      가 required review + no-admin-bypass + tag-only policy를 API에서 확인한다.
- [ ] 외부 등록 승인을 받은 뒤 `app.taxi`, `app.taxi.Widget`, `group.app.taxi`를
      정확히 등록하고, App Group이 양쪽 App ID에 연결된 **Developer ID**
      distribution profile을 app/appex별로 하나씩 생성한다. Development, Mac App
      Store, wildcard profile 또는 app profile의 widget 재사용은 금지한다.
- [ ] 아래 10개 값을 `release` environment secret으로만 등록한다.
  - `APPLE_DEVELOPER_ID` — Developer ID Application certificate 공통명 (예: `Developer ID Application: Heznpc (TEAMID)`)
  - `APPLE_API_KEY_P8_BASE64` — App Store Connect API `.p8` 키를 base64 인코딩한 값
  - `APPLE_API_KEY_ID` — App Store Connect API key ID
  - `APPLE_API_ISSUER_ID` — App Store Connect API issuer UUID
  - `APPLE_TEAM_ID` — 10자리 팀 ID
  - `APPLE_CERT_P12_BASE64` — `.p12` 인증서 + 개인키를 base64 인코딩 (`base64 -i cert.p12 | pbcopy`)
  - `APPLE_CERT_P12_PASSWORD` — `.p12` import 암호
  - `TAXI_APP_PROVISIONING_PROFILE_BASE64` — `app.taxi` 전용 Developer ID
    `.provisionprofile`의 base64
  - `TAXI_WIDGET_PROVISIONING_PROFILE_BASE64` — `app.taxi.Widget` 전용 Developer ID
    `.provisionprofile`의 base64. app profile과 같은 파일이면 안 된다.
  - `TAXI_RELEASE_CANDIDATE_KEY_BASE64` — `openssl rand -base64 32`로 만든
    candidate envelope key. 보호된 `npm` environment에도 같은 값을 등록한다.
- [ ] 인증서 import 직후 `scripts/verify-signing-identity.sh`가 Common Name과
      Organization을 모두 public identity `Heznpc`로, OU/team suffix를
      `APPLE_TEAM_ID`와 동일하게 확인해야 한다. 개인 법적 이름이나 다른 조직명이
      들어간 Developer ID 인증서는 바이너리 자체에 그 이름을 공개하므로 사용 금지.
- [ ] `release-app.yml`은 `refs/tags/vX.Y.Z`에서만 실행한다. 수동 실행도
      Actions의 ref를 해당 tag로 선택하고 입력 tag와 동일하게 맞춘다.
- [ ] workflow가 tag commit = `HEAD` = package/app/widget version source이며
      `origin/main`에서 도달 가능한지 확인한 뒤에만 signing material을 import하는지
      확인한다.
- [ ] `scripts/verify-provisioning-profile.mjs`가 두 CMS profile 각각에 대해
      만료일, `TeamIdentifier=XS7HJJN7GC`, exact
      `com.apple.application-identifier`, 필수 `group.app.taxi`(Apple이 추가한
      `XS7HJJN7GC.*`만 추가 허용), `com.apple.security.get-task-allow`가 없거나
      `false`, `ProvisionsAllDevices=true`, 기기
      목록 부재, Developer ID Application 인증서를 확인한다.
- [ ] final `Taxi.app/Contents/embedded.provisionprofile`과
      `TaxiWidget.appex/Contents/embedded.provisionprofile`이 서로 다른 source
      profile과 byte-identical하고, 각 최종 codesign entitlement의 exact App ID/team/
      app group 및 leaf certificate가 embedded profile과 일치한다.
- [ ] receipt 생성 직전 `Taxi-X.Y.Z.zip`을 새 임시 디렉터리에 풀고, 추출된
      `Taxi.app`과 `TaxiWidget.appex` 각각에 동일한 provisioning verifier를 다시
      실행한다. receipt의 lifecycle `provisioningProfiles`와 fresh archive
      `postPackagingProvisioningProfiles` proof가 모두 `true`가 아니면 이후 publish를
      차단한다.
- [ ] exact signed/stapled `Taxi.app`가 첫 generation의 authenticated MCP와
      정상 AppKit 종료, 별도 두 번째 generation의 3,600초 이상 CPU/listener/
      ownership/MCP soak, native app SIGKILL 뒤 Node watchdog 종료를 모두 통과해야 한다.
- [ ] 성공 결과는 plaintext를 공개 artifact로 올리지 않고
      `Taxi-X.Y.Z.zip.enc`와 `signed-release-receipt.json.enc`만 올려야 한다.
      이 단계는 npm package, GitHub Release, MCP Registry ID를 만들지 않는다.
- [ ] workflow summary의 exact run ID와 receipt SHA-256을 다음 단계 입력으로
      기록한다. `verified`, `stored`, `published`는 서로 다른 상태로 취급한다.
- [ ] 공증 실패 시 Actions에는 정제된 issue code와 `Taxi.app` 기준 상대
      경로만 남는지 확인한다. raw `notarytool log`, submission ID, 계정·team·인증서
      주체는 공개 로그에 복사하지 않고, 필요하면 권한 있는 로컬 환경에서만 조회한다.
- [ ] 비공개 로컬 shell 검증: `codesign -dv --verbose=4 Taxi.app` 에서 `Authority=Developer ID Application: Heznpc (TEAMID)` 확인
- [ ] Gatekeeper 검증: `spctl -a -vvv Taxi.app` → `accepted, source=Notarized Developer ID`
- [ ] 배포 artifact 검증: `APP_BUNDLE_PATH=/path/to/Taxi.app npm run app:verify:signed`
  - 기존 번들을 다시 빌드하지 않고 Developer ID 서명, Gatekeeper, staple,
    두 개의 격리된 token/owner generation, exact embedded runtime PID,
    1시간 soak, AppIntents, 정상 종료와 crash cleanup을 확인한다.

### 3.5 npm + MCPB + signed app → GitHub Release

- [ ] 공개 저장소의 active tag ruleset이 `refs/tags/v*`에 update/deletion
      restriction을 적용하고 bypass actor를 두지 않는지 확인한다. 이 보호가
      설정되기 전에는 최초 release tag를 push하지 않는다.
- [ ] 보호된 `npm` environment에도 required reviewer/no-admin-bypass와
      `main`-only branch deployment policy를 적용하고,
      `TAXI_RELEASE_CANDIDATE_KEY_BASE64`를 `release` environment와 동일하게 둔다.
- [ ] `cd.yml`을 `main` ref에서 수동 실행하며 3.4의 exact signed run ID와
      receipt SHA-256을 입력한다. 최초 publish 전에 이 dispatch 자체가 외부 공개
      승인 범위 안인지 다시 확인한다.
- [ ] CD가 signed workflow의 repository, workflow path, run ID/attempt,
      event, exact tag invocation ref, source SHA, success 상태와 receipt/archive
      SHA-256을 모두 검증하기 전에는 npm 또는 GitHub Release를 변경하지 않아야 한다.
- [ ] npm publish 직전과 GitHub Release 생성 직전에 GitHub API의 remote tag를
      다시 peel하여 exact release SHA와 같은지 확인한다.
- [ ] 같은 npm 버전 재시도는 로컬 `npm pack` SHA-512 SRI, registry
      `dist.integrity`, registry `gitHead`, release SHA가 모두 같을 때만 멱등 skip한다.
- [ ] npm package가 아직 존재하지 않는 첫 `@heznpc/taxi@1.0.0` publish는
      승인된 granular `NPM_TOKEN`으로 실행한다. 첫 publish 뒤 trusted
      publisher를 설정하고 후속 release부터 trusted publishing을 선택한다.
      token publish에는 `npm whoami`가 선행되어야 한다.
- [ ] `npm view @heznpc/taxi@X.Y.Z`,
      `npx -y @heznpc/taxi@X.Y.Z --version`, `taxi run`, `taxi connect`를 fresh
      install 경로에서 확인한다.
- [ ] GitHub Release에 3.4에서 검증한 exact `Taxi-X.Y.Z.zip`과
      `taxi-X.Y.Z.mcpb`가 모두 첨부됐는지 확인한다.
- [ ] `npm run release:verify -- --version=X.Y.Z`로 npm SRI/gitHead,
      fresh pinned execution, GitHub Release target/artifacts를 확인한다.

### 3.6 MCP Registry (별도 외부 승인)

- [ ] `mcp-registry` environment에 required reviewer, admin-bypass 차단,
      tag-only `v*.*.*` policy를 설정한다.
- [ ] npm과 GitHub Release 검증이 끝난 뒤에만 `publish-registry.yml`을 exact
      `vX.Y.Z` ref/입력으로 수동 실행한다. GitHub Release event는 이 workflow를
      자동 실행하지 않는다.
- [ ] workflow가 Taxi package/registry identity, exact npm tarball SRI와
      `gitHead`, checksum-pinned `mcp-publisher`를 확인한 뒤
      `io.github.heznpc/taxi@X.Y.Z`만 게시하는지 확인한다.
- [ ] registry 상태 변경은 `registry-set-status.yml`로 exact Taxi version만
      대상으로 하며 다른 namespace나 모든 버전을 한 번에 변경하지 않는다.

### 3.7 GitHub Release notes

- [ ] Release notes는 CHANGELOG 섹션 복사 (요약 강조, 이미지/GIF는 README 링크)
- [ ] Breaking이 있으면 Release 제목에 `[BREAKING]` 프리픽스
- [ ] `latest` 태그 갱신 확인

---

## 4. 사후 작업 (release 후 24시간 내)

- [ ] **릴리스 추적 이슈**에 다운스트림 반영 확인
  - cursor.directory 자동 인덱싱 확인
  - PulseMCP / Glama 메타데이터 반영 (필요 시 수동 요청)
- [ ] **doctor 서버 응답** 체크: `.well-known/mcp.json`의 version·authorization 블록 최신화
- [ ] Breaking이 있었다면 README 상단 안내 배너 1주일간 유지
- [ ] 중대한 변경은 GitHub Discussions에 "Announcement" 카테고리로 공지
- [ ] (SNS는 별도 메이저 릴리스에만)

---

## 5. 실패·롤백 시나리오

### 5.1 CI 실패로 릴리스 중단

- [ ] `git tag -d vX.Y.Z` (로컬)
- [ ] `git push origin :refs/tags/vX.Y.Z` (원격에 이미 푸시된 경우만)
- [ ] 원인 픽스 후 동일 버전 번호 재시도 가능 (npm publish 이전이므로)

### 5.2 npm publish 후 결함 발견

- **npm은 72시간 내 `npm unpublish` 가능하지만 생태계 영향이 크다.**
- 가능하면 **신규 patch 릴리스**로 롤-포워드:
  - `vX.Y.Z+1` 준비, CHANGELOG에 "Revert: ..." 명시
  - 이전 버전에 `deprecated` 플래그: `npm deprecate @heznpc/taxi@X.Y.Z "Please upgrade to X.Y.Z+1 due to <reason>"`
- unpublish가 불가피하면 README·Discussions·Release Notes에 명시

### 5.3 보안 이슈 발견 (배포 후)

- [ ] [SECURITY.md](../SECURITY.md) 프로세스 시작 (GitHub Advisories, CVE 요청)
- [ ] 영향받은 버전에 `npm deprecate`
- [ ] 긴급 패치는 48시간 내 릴리스 목표

---

## 6. 자동화 기회

드리프트를 **사람의 주의력**이 아니라 **CI 게이트**로 막는 작업:

- [ ] **CHANGELOG/이슈 라벨 동기화 게이트** — 릴리스 CHANGELOG 항목과 GitHub Issues 마일스톤·라벨 상태를 교차검증
- [ ] **버전 sync 검증** (이미 존재: `scripts/sync-version.mjs --check`) — CI blocking
- [ ] **Release Drafter** — 이슈·PR 라벨로 CHANGELOG 초안 자동 생성
- [ ] **release-please** 등으로 버전 bump PR 자동화 후보 검토

---

## 부록: 빠른 명령어 치트시트

```bash
# 로컬 게이트
npm run lint && npm run typecheck && npm run build && npm test

# 통계·i18n
npm run stats:check && npm run i18n:check

# dry release artifact
npm run release:preflight

# 취약점
npm audit --audit-level=moderate --omit=dev

# 외부 승인 후 main과 immutable tag 공개
git push origin main
git tag -a vX.Y.Z -m "Taxi vX.Y.Z"
git push origin vX.Y.Z

# release-app의 signed candidate run ID/receipt SHA-256 확인 후 공개 publish
gh workflow run cd.yml --ref main \
  -f signed_release_run_id=RUN_ID \
  -f signed_release_receipt_sha256=RECEIPT_SHA256

# 별도 registry 승인 후 exact tag ref에서 등록
gh workflow run publish-registry.yml --ref vX.Y.Z -f tag=vX.Y.Z

# 스모크
npx -y @heznpc/taxi@X.Y.Z --version
```
