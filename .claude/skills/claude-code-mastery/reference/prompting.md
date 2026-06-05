# 프롬프팅 패턴 기초

> 안정적 기초(개념·원칙)는 본문에 채움. 휘발성(모델ID·정확한 캐시 가격·토큰 한도·API 시그니처)은 "fetch 확인" 포인터로.
> 검증일 2026-06-05 — 핵심 주장 라인 인용 검증 완료(하단 출처). 일반 통념은 "(※ 통념)"으로 표시.

**핵심**: 명확 > 구체적 > 구조화된 지시.

## 기본 원칙 3

### 1. 명확성(Clarity)
- 모호함 제거: "수정해 줘" → "해시 충돌 처리 로직을 X 방식으로 바꿔 줘".
- 구체적 파일/함수명 명시(`src/auth/token.dart` 등), 제약(언어 버전·테스트 프레임워크·호환성) 명시.
- 출처: code.claude.com/docs/en/best-practices.md

### 2. 구체성(Specificity)
- 정확할수록 재작업↓. 복잡한 요구는 단계로 분해.
- 기존 코드/패턴 참조("이 위젯처럼" + 경로), 검증 기준 제시(테스트·스크린샷·성공조건).
- 예: ❌"에러 처리 개선" → ✅"결제 API 호출에 타임아웃 처리 추가, 기존 ErrorHandler 패턴 따르고 테스트는 …스타일로".

### 3. 구조화(Structured context)
- 긴 입력은 XML 태그 등으로 구획화. 여러 요구는 불릿. 우선순위 명시("먼저 X, 다음 Y"). 예시 포함.

## API 기능 핵심

### System vs User 분리
- **System**: 역할·목표·제약·불변 규칙(대화 전반). 안정적이라 prompt caching에 유리 — 단, 캐시는 **명시 설정**이며 내용 변경 시 무효화.
- **User**: 그 턴의 구체 작업·컨텍스트.

### Few-shot
- 예시를 더하면 형식·경계 학습에 강력. 원하는 출력의 모양을 직접 보여줄 것. (※ 통념 — 공식 문서에 "몇 개" 같은 특정 수치 근거는 없음)

### Chain-of-Thought / thinking
- "단계별로 생각하며" 요청은 복잡 추론·분석 정확도에 도움. 단순 작업엔 비용만 늘어 비권장. (※ 통념 — 공식 명시 가이드보다 일반 원칙)

### Structured Output
- 스키마(JSON)로 응답 강제 → 파싱 오류 제거, 연동 안정화.
- 정확한 사용법: fetch → platform.claude.com/docs (build-with-claude/structured outputs)

## 심화 개념(개념만 — 수치는 fetch)

### Prompt caching
- **개념**: 반복되는 대형 프리픽스(system·문서·CLAUDE.md)를 캐시해 입력 토큰·지연↓. 2회차부터 이득.
- **쓰는 상황**: 길고 안정적인 지시문, 동일 컨텍스트 반복 요청, 배치 공통 프리픽스. 앱 만들 땐 기본 적용 권장.
- **정확한 가격·TTL·최소 토큰**: fetch → platform.claude.com/docs (prompt caching)

### Tool use
- **개념**: Claude가 외부 함수/API를 결정적으로 호출. client tool(내 앱 실행) vs server tool(Anthropic 실행).
- **설계**: 도구 설명은 정확·간결, 필수/선택 파라미터 명확, 강제 필요 시 `tool_choice` 사용.
- **정확한 시그니처·필드**: fetch → platform.claude.com/docs (tool use)

### Extended thinking
- **개념**: 답변 전 깊게 추론하는 모드. 난해한 알고리즘·수학·코드 분석에 효과, thinking 토큰 비용 발생.
- **사용 시점**: 단순 질문 ❌ / 복잡 추론 ✅.
- **정확한 모델·예산·가격**: fetch → platform.claude.com/docs (extended thinking)

## 모범사례
- **검증 신호 제공**: 테스트 통과/실패·빌드 exit code·스크린샷 등 Claude가 스스로 확인할 신호를 주면 자동 루프 가능.
- **Rich content**: `@경로`로 파일 참조(자동 읽음), 이미지(목업·에러 스크린샷) 붙이기, stdin 파이핑.
- **계획 먼저**: 탐색(읽기 전용) → 계획 → 구현 → 검증. 처음부터 잘못된 접근 방지.
- 출처: code.claude.com/docs/en/best-practices.md

## 안티패턴
- **과도한 길이**: CLAUDE.md/프롬프트에 무관 정보 과적재 → 중요 지시가 묻힘. 참고자료는 스킬로 분리(on-demand).
- **모호한 성공 기준**: "더 좋게" ❌ → 측정 가능한 기준·테스트 케이스 ✅.
- **검증 안 한 스펙 추측**: 모델ID·파라미터·플래그는 추측 금지 → fetch.

## 더 깊이
- 실전 레시피: code.claude.com/docs/en/common-workflows.md
- API 전체: platform.claude.com/docs (또는 /llms.txt)
- `claude-api` 스킬(있으면)

## 출처 (라인 인용 검증 2026-06-05)
- code.claude.com/docs/en/best-practices.md — 구체적 컨텍스트·기존 패턴 참조·검증 신호(테스트·exit code)·rich content(@경로·이미지·stdin)·탐색→계획→구현
- platform.claude.com/docs — prompt caching(캐시 읽기 ≈0.1x 입력가), tool use(client/server·`tool_choice`), extended thinking(thinking 토큰 과금), structured outputs(JSON 스키마)
- ※ Few-shot 개수·CoT는 일반 통념(공식 특정 근거 없음)
