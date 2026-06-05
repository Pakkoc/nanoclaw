# Claude Code Features — 상세 + 컨텍스트 로딩 모델

> 검증일 2026-06-05. inline = 공식 문서 인용으로 확인된 안정적 사실. 정확한 전체 스펙·수치는 "fetch 포인터".
> 1차 출처: code.claude.com/docs/en/{memory,skills,sub-agents,hooks,mcp,settings}.md

## 컨텍스트 로딩 모델 (검증됨)
| 메커니즘 | 세션 시작 시 | 트리거·사용 시 | 비고 |
|---|---|---|---|
| CLAUDE.md (전역/프로젝트/로컬) | **전체 로드** | — | ≤200줄 권장, 길면 adherence↓ |
| CLAUDE.md `@import` | 전체 transclude(최대 **4 hop**) | — | **토큰 절감 없음**(정리용) |
| `.claude/rules/*.md` | 항상(기본) 또는 `paths` 매칭 시 | — | frontmatter `paths`로 특정 파일에만 조건부 적용 |
| Skill | `name`+`description`(+`when_to_use`)만 | SKILL.md 본문 **전체** 1회 | description+when_to_use 합산 **1,536자**에서 잘림 |
| Skill 번들 파일(reference/*) | — | **필요 시 Read** | on-demand |
| Subagent | 정의 `description`(위임 판단) | **별도 컨텍스트 윈도우** | 결과 요약만 메인 반환 |

- CLAUDE.md 계층(높은 우선순위 순): 관리(managed) → 사용자(`~/.claude`) → 프로젝트(`./CLAUDE.md`) → 로컬(`CLAUDE.local.md`, gitignore).
- 장문 참고자료는 skill로 옮기면 "쓸 때까지 비용 거의 0"(공식 권장).

## Skill
- 위치·범위: Personal `~/.claude/skills/<name>/SKILL.md`(모든 프로젝트) · Project `.claude/skills/` · Plugin `skills/` · Managed.
- 우선순위(동명): enterprise > personal > project.
- frontmatter (전부 optional, `description` 권장 — **확인된 필드**):
  - `name`, `description`, `when_to_use`(description과 합산 1,536자)
  - `allowed-tools`(스킬 활성 중 무허가 사용 도구; 공백/쉼표/YAML list)
  - `model`(sonnet/opus/haiku/full ID; 해당 턴 적용)
  - `disable-model-invocation: true`(자동 로드 차단 → `/name` 수동만)
  - `user-invocable: false`(`/` 메뉴 숨김; 배경지식용)
  - `context: fork`(forked subagent 컨텍스트로 실행)
  - 전체 필드: fetch → skills.md#frontmatter-reference
- 본문 **≤500줄** 권장, 깊은 건 reference 파일로 분리(on-demand Read).
- **Slash command = skill로 통합**: `.claude/commands/x.md` ≡ `.claude/skills/x/SKILL.md` → 둘 다 `/x`.
- `~/.claude/skills/` 변경은 현재 세션 내 자동 감지(재시작 불필요).

## Subagent
- 별도 컨텍스트 윈도우 + 자체 system prompt + 도구·권한 제한. `description`이 위임 트리거, 결과(요약)만 메인 반환.
- 위치: `~/.claude/agents/<name>.md`(전역) · `.claude/agents/<name>.md`(프로젝트).
- frontmatter (**확인된 필드**): `name`·`description`(필수), `tools`(생략 시 전체 상속), `model`(…/`inherit`, 기본 inherit), `memory`(user/project/local — 세션 간 학습), `skills`(시작 시 본문까지 preload).
  - 전체 필드: fetch → sub-agents.md#supported-frontmatter-fields
- 용도: 광범위 조사·검증·병렬 작업을 메인 컨텍스트 오염 없이.

## Hook
- settings.json(또는 skill/subagent frontmatter)에 이벤트별 명령 등록 → **결정적** 실행(모델 판단 아님), 컨텍스트 비용 0.
- 이벤트(확인된 핵심): `PreToolUse`, `PostToolUse`, `SessionStart`, `Stop`, `UserPromptSubmit`, `PreCompact`, `SubagentStop`, `Notification` 등 — **전체 목록은 fetch**(추가 이벤트 다수).
- `matcher`로 발화 조건 필터(전체/정확문자열/정규식). **exit code 2 = 차단**(PreToolUse 등 blockable 이벤트에서 도구 호출 차단).
- 세부 exit code 동작·전체 이벤트: fetch → hooks.md
- 용도: "무조건 X 때 Y" 강제·자동화. 모델 추론이 필요한 일은 hook 아닌 CLAUDE.md/스킬.

## MCP
- 외부 도구·리소스 연결. 전송: `stdio`, `http`, `sse`(deprecated), `ws`(WebSocket).
- 프로젝트 scope 설정은 루트 `.mcp.json`; subagent엔 `mcpServers` 필드로 부여.
- 도구는 `mcp__<server>__*`. 인증형 서버는 헤드리스/cron에서 빠질 수 있음. 도구 많으면 tool search로 deferred 로드.
- 인증/OAuth·조건부 로드: fetch → mcp.md

## Plugin
- skill+command+agent+hook+MCP **번들** + marketplace 배포·버전관리.
- 경로 `.claude-plugin/plugin.json`(스킬 폴더에 추가하면 plugin으로 로드), 설치 `/plugin install <name>@<marketplace>`.
- 단일 지식 스킬엔 불필요 — 여러 자산을 묶어 배포·공유할 때만.

## settings.json
- 기술적 강제(CLAUDE.md는 행동 가이드, 역할 분리). 계층: managed > user(`~/.claude/settings.json`) > project(`.claude/settings.json`) > local(`.claude/settings.local.json`, gitignore).
- **확인된 키**: `permissions.allow`/`permissions.deny`(도구 규칙 배열), `env`(환경변수), `hooks`(lifecycle), `skillOverrides`(스킬별 가시성: on/name-only/user-invocable-only/off), `autoMemoryEnabled`(auto memory on/off, 기본 true).
- 전체 키: fetch → settings.md

## 1차 출처
- code.claude.com/docs/en/memory.md — CLAUDE.md 로딩·계층·import·rules·auto memory
- code.claude.com/docs/en/skills.md — Skill·frontmatter·progressive disclosure
- code.claude.com/docs/en/sub-agents.md — Subagent 컨텍스트·필드·위임
- code.claude.com/docs/en/hooks.md — Hook 이벤트·matcher·exit code
- code.claude.com/docs/en/mcp.md — MCP 전송·설정·인증
- code.claude.com/docs/en/settings.md — settings 키
