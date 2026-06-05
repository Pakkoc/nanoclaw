---
name: claude-code-mastery
description: >-
  Index and best-practices for Claude Code features (skills, subagents, hooks,
  slash commands, MCP, plugins, workflows, settings) and for prompt and
  agent-harness design. Use when designing prompts, building agent harnesses or
  automations, choosing or configuring a Claude Code feature, or when unsure
  which command or capability fits a task. This is a curated INDEX, not a copy
  of the docs — for version-sensitive or latest specifics, fetch official
  docs/blog live via the claude-code-guide subagent or WebFetch.
---

# Claude Code Mastery — 활용 인덱스

> **이 스킬은 "지도"다.** 전체 문서 사본이 아니라, *무엇이 있고 언제 그걸 쓰는지* + *깊은 내용·최신은 어디서 가져오는지* 를 가리킨다.
>
> 흐름: ① 아래 JTBD 표에서 맞는 수단 고르기 → ② 필요하면 `reference/*.md`를 Read → ③ 시점 민감·정확한 플래그는 **공식 문서·블로그 라이브 fetch**.

## 사용 원칙
- **요청 범위 안에서만** 적용한다. 멋진 기능을 무단 주입하지 말 것 — 범위 밖 아이디어는 코드가 아니라 의견으로 보고.
- **over-engineering 경계**: 단일 스킬/커맨드로 될 일을 plugin·hook·자동화로 키우지 말 것.
- **모르면 fetch**: 정확한 명령/플래그/신규 기능은 추측 금지 → `claude-code-guide` 서브에이전트(없으면 WebFetch)로 `code.claude.com/docs`·`anthropic.com` 확인.

## JTBD — "이걸 하고 싶다 → 이걸 써라"
| 하고 싶은 것 | 수단 | 깊은 내용 |
|---|---|---|
| 반복 지시·지식 재사용, 평소 컨텍스트 ~0 | **Skill** (`~/.claude/skills/` 전역 · `.claude/skills/` 프로젝트) | reference/cc-features.md |
| 무거운 조사·검증을 별 컨텍스트에 위임 | **Subagent** (별도 컨텍스트 윈도우) | reference/cc-features.md |
| 결정적 자동화("무조건 이벤트 X에 실행") | **Hook** (settings.json) | reference/cc-features.md |
| 자주 쓰는 프롬프트를 `/명령`으로 | **Slash command** (= skill로 통합됨) | reference/cc-features.md |
| 외부 서비스(API·DB·브라우저) 연결 | **MCP 서버** | reference/cc-features.md |
| skill+agent+hook+command 묶어 배포 | **Plugin** (+marketplace) | reference/cc-features.md |
| 다단계 에이전트 오케스트레이션(fan-out·검증) | **Workflow** | reference/harness-patterns.md |
| 권한·환경변수·정책 강제 | **settings.json** | reference/cc-features.md |
| 프롬프트가 잘 안 먹힘 | 프롬프팅 패턴 | reference/prompting.md |
| 에이전트·하네스 설계 | 하네스 패턴 | reference/harness-patterns.md |

## 핵심 컨텍스트-비용 사실 (모든 선택의 근거 · 2026-06-05 검증)
- **CLAUDE.md**: launch 시 **전체 로드**. 전역(`~/.claude/CLAUDE.md`)은 모든 프로젝트에 매번 → **200줄 이하** 유지, 지식 덤프 금지.
- **`@import`**: transclude(launch 로드, 최대 4 hop) — 정리용일 뿐 **토큰 절감 없음**.
- **Skill**: 세션 시작엔 `description`만, 본문은 **트리거 시에만** 로드 → 방대한 참고자료를 평소 ~0 비용으로 보유. 본문 ≤500줄, 깊은 건 reference 파일로 분리해 on-demand Read.
- **Subagent**: **별도 컨텍스트 윈도우**, `description`으로 위임 판단.
- 상세·출처: `reference/cc-features.md`.

## 라이브 fetch가 필요한 때
- 정확한 명령/플래그/frontmatter 필드, 신규·변경된 기능, 가격·한도, API 스펙.
- 방법: `claude-code-guide` 서브에이전트에 질의(없으면 WebFetch). 1차 출처: `code.claude.com/docs/en/*.md`, `anthropic.com/news`, `anthropic.com/engineering`, `platform.claude.com/docs`(또는 `/llms.txt`).

## Reference (필요 시 Read)
- `reference/cc-features.md` — 기능별 상세 + 컨텍스트 로딩 모델 + 공식 출처(검증됨)
- `reference/prompting.md` — 프롬프팅 패턴
- `reference/harness-patterns.md` — 에이전트·워크플로 하네스 패턴
