# 에이전트 / 하네스 패턴 기초

> 패턴·원칙은 본문에 채움(안정적). 정확한 SDK API 시그니처·필드는 "fetch 확인".
> 기준: Anthropic "Building effective agents"(research) + Claude Code subagent/workflow/hooks. 라인 인용 검증 2026-06-05 — 5패턴·"단순함 우선"·workflow↔agent 정의 모두 공식 일치.

## 무엇을 쓸 것인가 (의사결정)
```
작업을 자동화/확장하고 싶다
├─ 한 번의 호출로 충분 → 단순 프롬프트(Messages API 1회)
├─ 단계별 작업 조합
│   ├─ 결과가 다음 단계 입력 → Workflow(prompt chaining)
│   └─ 독립 병렬 작업 → Parallel agents
├─ Claude가 스스로 탐색/판단 + 별도 맥락 필요 → Subagent(격리 fresh context)
├─ 완전 자율·장시간·클라우드 → Managed Agent
└─ 특정 규칙을 무조건 강제 → Hook(결정적)
```

## 패턴별 정의·적용 시점

### 1. 단순 프롬프트
- **정의**: 1회 호출 = 최종 답변. **시점**: 정보 조회·짧은 분석·외부 상태 변경 없음.
- 검증 분리 불가(실행자=검증자). 비용 저.

### 2. Workflow (prompt chaining)
- **정의**: 여러 단계 순차 실행, 각 결과가 다음 입력. **시점**: 다단계 분석, 반복 정제, 단계별 비용/모델 제어.
- 중간 결과를 프로그래밍 방식으로 검증 가능. 출처: "Building effective agents".

### 3. Parallel agents
- **정의**: 독립 작업 동시 실행 후 종합. **시점**: 서로 무관한 영역(인증/DB/API) 조사, 속도, 컨텍스트 격리.
- 주의: 결과가 많으면 종합 단계에서 메인 컨텍스트 증가.

### 4. Subagent (격리 맥락)
- **정의**: 별도 컨텍스트 윈도우 + 자체 system prompt + 도구/권한 제한. 결과(요약)만 메인에 반환.
- **시점**: 큰 탐색(수십 파일)·읽기 전용 조사·전문가 역할(보안 리뷰어 등)·write 금지 등 권한 제한.
- 메인 컨텍스트 보존 + fresh context = 편향 적은 검증. 출처: code.claude.com/docs/en/sub-agents.md.

### 5. Managed Agent (클라우드 자율)
- **정의**: 클라우드에서 완전 자율·장시간 실행. **시점**: 정기 반복(매일 PR 검토 등)·터미널 종료 후에도 실행·위험 작업 격리·에이전트 간 협업.
- 정확한 정의/API: fetch → platform.claude.com/docs (managed agents).

### 6. Hook (결정적 제어)
- **정의**: 특정 이벤트에 무조건 스크립트 실행(모델 판단 아님). 컨텍스트 비용 0.
- **시점**: 강제 규칙("저장 후 항상 lint"), 정책 보호(위험 명령 차단), 커밋 전 테스트.
- 이벤트(PreToolUse/PostToolUse/SessionStart/Stop 등)·exit code 의미: fetch → code.claude.com/docs/en/hooks.md.

## "Building effective agents" 핵심 패턴
- **Prompt chaining**: 작업을 고정 단계로 쪼개 순차. 각 단계가 단순해져 정확도↑(지연 trade-off).
- **Routing**: 입력을 분류해 알맞은 전문 경로로 보냄.
- **Parallelization**: sectioning(작업 분할 병렬) / voting(같은 작업 여러 번 → 다수결).
- **Orchestrator–workers**: 중앙이 동적으로 하위작업 분배·종합.
- **Evaluator–optimizer**: 생성 → 평가 → 개선 루프(명확한 평가 기준이 있을 때).
- 원칙: **가장 단순한 것부터**. 단일 프롬프트로 되면 agent 만들지 말 것.

## 설계 원칙
1. **컨텍스트 절약**: 큰 탐색은 subagent/workflow로 fan-out, 결론만 회수.
2. **검증 분리**: 실행자 ≠ 검증자. 구현 후 fresh subagent로 검증.
3. **비용 가드**: 무한 루프·과병렬 방지(예산/카운터). 모델 선택(복잡=Opus / 표준=Sonnet / 저비용=Haiku). 결정적 강제는 hook.

## 조합 예
- **Plan → Implement → Review**: 계획 subagent(읽기전용) → 메인 구현 → 리뷰 subagent 검증.
- **Explore → Synthesize**: 모듈별 subagent 병렬 분석 → 메인이 통합.

## 안티패턴
- 단일 에이전트가 전부(컨텍스트 폭발) → 탐색=subagent / 구현=main.
- 검증자 부재(버그 누락) → fresh subagent 또는 hook 검증.
- 비용 모니터링 부재 → 모델 선택·배치·caching.
- 무인 실행인데 확인 신호 없음 → 항상 검증 신호 제시(exit code·테스트).

## 출처 / 더 깊이 (라인 인용 검증 2026-06-05)
- **Building effective agents**: anthropic.com/research/building-effective-agents — 5패턴(chaining·routing·parallelization·orchestrator-workers·evaluator-optimizer)·"단순함 우선"·workflow↔agent 정의 모두 인용 확인.
- Agent SDK·subagent·hooks 문서: code.claude.com/docs · platform.claude.com/docs · Workflow 도구 설명.
