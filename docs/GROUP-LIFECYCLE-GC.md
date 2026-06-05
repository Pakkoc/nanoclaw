# 티켓/다이어리 그룹 생명주기 & GC 설계 (검증 보고 포함)

per-channel Discord 그룹의 등록/잔존/회수(GC) 설계와, 6라운드 적대적 검증으로 원래 계획을 교정한 과정을 기록한다.

- **검증 기준일**: 2026-06-06
- **브랜치**: `feat/ticket-diary-lifecycle`

---

## 1. 개요

NanoClaw 의 Discord 채널은 per-channel 단위로 그룹이 **자동 등록**된다.

- 티켓 채널 → `groups/discord_tickets_ch<id>`
- 다이어리 채널 → `groups/diaries/discord_diary_ch<id>`

문제는 **채널이 닫혀도(삭제돼도) 회수가 전혀 일어나지 않는다**는 점이다. 등록행(`registered_groups`), 그룹 폴더, 세션, IPC 경로가 모두 영구 잔존한다.

이 문서는 원래의 "1+3" 계획(호스트 폴링 1종 + 정리 3종)을 6라운드 적대적 검증으로 교정한 결과와, 그 결과로 확정한 **최종 설계**를 함께 담는다.

---

## 2. 검증 방법론

fresh subagent 적대 검증(adversarial verification)을 6라운드 수행했다.

- 매 라운드 **신규 발견만 누적**한다(중복 제거).
- 모든 발견은 `file:line` 근거를 필수로 한다.
- 코어 플랜이 안정화되고 **2연속으로 신규 발견이 임계 미달**이면 정지한다(상한 캡 6).

| 라운드 | 신규 발견 수 | 성격 |
|--------|--------------|------|
| R1 | ~20 | 초기 광범위 발견 |
| R2 | ~12 | 추가 발견 |
| R3 | ~9 | 방향 전환(탐지 방식 재검토) |
| R4 | ~6 | 정정 — 여기서 코어 플랜 안정화 |
| R5 | ~4 | 곁가지(인접 버그) |
| R6 | ~6 | 디테일 보강 |

R4에서 코어 플랜이 안정화되었고, R5~R6은 코어가 아닌 **인접 버그**만을 추가했다. 캡 6에서 정지했다(2연속 임계 미달).

---

## 3. 검증이 뒤집은 원래 가정 4가지

| # | 원래 가정 | 검증 결과 | 교정된 설계 |
|---|-----------|-----------|-------------|
| a | 호스트 `setInterval` + `channels.fetch` 로 닫힌 채널 탐지 | **불가** — 호스트가 Discord client 에 도달할 경로가 없음(register-only 구조) | `ChannelDelete` 이벤트 + startup `reconcile` 로 전환 |
| b | "티켓 드리프트 0" | 채널의 **90%(54/60)** 가 하드삭제됨(라이브 probe 확인). 단 `CLAUDE.md` **내용** 드리프트는 0(방안3이 예방) | 채널 소멸 회수 필요, 내용 새로고침은 스폰 시 처리 |
| c | "다이어리 GC 불필요 — `dormant-move` 가 소유" | `dormant-move` 는 **이동만** 하고 호스트 정리는 0. 다이어리도 **2.8%(13/463)** 의 dead orphan 이 무한 누적 | 다이어리에도 동일 회수 적용 |
| d | "`messages` 보존 필수" | **기각** — 업무일지는 `dc:tickets` + 파일에, 랭킹은 Supabase 에 있음(삭제 영향 0) | `messages` 삭제 허용 |

---

## 4. 최종 설계

채널 소멸을 호스트 폴링이 아니라 **Discord 이벤트 + startup reconcile** 로 감지한다.

- `Events.ChannelDelete` 핸들러 — 채널 삭제 시 즉시 회수
- `Events.ThreadDelete` 핸들러 — 스레드 삭제 시 회수
- **startup reconcile** — 부팅 시 등록된 채널을 fetch 하여 `10003`(Unknown Channel) 만 회수 트리거. **휴면 이동(dormant-move)된 채널은 제외**
- 위 경로 모두 `deregisterGroup(jid)` 배관을 호출

---

## 5. deregister 계약

`deregisterGroup(jid)` 는 멱등(idempotent)하며, 다음 항목을 삭제/보존/차단한다.

| 분류 | 대상 |
|------|------|
| **삭제** | `messages` → `chats` → `registered_groups` (FK ON 순서, 단일 트랜잭션) |
| **삭제** | in-memory `registeredGroups`, `sessions[folder]` |
| **삭제** | `lastAgentTimestamp` 커서 |
| **삭제** | sessions DB 행 및 `data/sessions/<folder>` |
| **삭제** | IPC 양쪽 키 — `resolveGroupIpcPath(jid)` 및 `(folder)` 기준 모두 |
| **보존** | `groups/<folder>` (감사 목적으로 폴더 유지) |
| **보존** | OneCLI 에이전트 (SDK delete API 가 없음) |
| **재등록 차단** | in-memory tombstone(`deregisteredJids`) + `messages` 삭제로 Phase-1 부활(재구성) 차단 |

`messages → chats → registered_groups` 순서는 FK 제약(ON 상태)을 만족시키기 위함이며, 트랜잭션으로 묶어 부분 삭제를 방지한다.

---

## 6. 곁가지 기존 버그 (별도 트랙)

검증 과정에서 발견된, 이번 생명주기 작업과 직접 관련은 없지만 별도로 추적해야 할 기존 버그 목록.

| 버그 | 내용 |
|------|------|
| IPC split-brain | 커밋 `94705d9` 회귀 — 스냅샷이 컨테이너에 미도달 |
| 업무일지 크론 SQL | 죽은 `dc:tickets` 를 조회 → 6주째 0 집계 |
| `create-diary.sh` stale 템플릿 | "5번" / "채널 유출 금지" 항목 누락 — **이번에 수정** |
| `container-runner` 보안 주석 거짓 | 주석과 달리 non-main 도 `tools.env` 를 읽음 |
| 폴더 종료자(reaper) 없음 | 폴더가 무한히 디스크에 누적 |
| `cleanup-sessions.sh` depth-2 miss | depth-2 경로(`diaries/...`)를 놓침 |
| `dormant-move.py` 고아 | 호출 경로 없이 방치됨 |
| stray `scheduled_tasks` | 테스트용 task 3건 잔존 |
| `DIARY_CATEGORY_IDS` 이중 하드코딩 | 두 곳에 중복 하드코딩됨 |
| 다이어리 템플릿 2종 | git 미추적 상태 |

---

## 7. 반증/정정된 주장

검증 중에 **틀린 것으로 확인되어 철회/정정한** 주장들.

| 처음 주장 | 정정 |
|-----------|------|
| FK 제약이 off 상태 | 실제로는 **ON** — better-sqlite3 v11 기본값 |
| 다이어리 dead orphan 0% | 실제 **2.8%** (13/463) |
| `SQLITE_BUSY` 즉시 발생 | `busy_timeout` 5s 기본값으로 완화됨 |
| create-diary 컨테이너 DB INSERT divergence | 호스트 경로에서는 **실패(무해)** |
| `process.exit` 부분 삭제 / `10003` 폭풍 | **과장된 우려** — 실제로는 발생 안 함 |

---

## 8. 이번 구현 범위

이번 브랜치에서 **반영한** 항목.

| 영역 | 변경 |
|------|------|
| deregister 배관 | `db` / `types` / `registry` / `index` |
| 이벤트/회수 | `ChannelDelete` + `ThreadDelete` + `probeChannelGone` + `reconcile` (`discord` / `index`) |
| 티켓 내용 새로고침 | 스폰 시점에 `CLAUDE.md` 새로고침 (`container-runner`) |
| 다이어리 템플릿 | `create-diary.sh` 템플릿 교정 |

**미반영(별도 트랙)**: IPC split-brain 근본 수정, 업무일지 SQL(라이브 DB row 수정 필요), 폴더 종료자(reaper).

---

## 9. 배포 절차

```bash
npm run build
# 테스트는 nvm node22 환경에서 수행
systemctl --user restart nanoclaw
```

- 컨테이너 변경이 없으므로 `./container/build.sh` 는 **불필요**하다.
- 단, `groups/discord_tickets_ch*/CLAUDE.md` 는 `.gitignore` 대상이다(커밋되지 않음).
