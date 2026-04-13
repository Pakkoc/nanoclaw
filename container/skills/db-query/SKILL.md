---
name: db-query
description: 마법사관학교 Supabase DB (read-only) 쿼리 실행 스킬. 관리자가 사용자 통계, 활동 분석, 서버 운영 데이터를 물어볼 때 사용한다. `_clean` VIEW만 접근 가능하며 SELECT만 허용.
---

# DB Query — 마법사관학교 Supabase DB 쿼리 스킬

마법사관학교 Discord 서버 DB(Supabase Postgres)에서 read-only 쿼리를 실행한다.
관리자가 사용자 통계, 활동 분석, 서버 운영 데이터를 물어볼 때 사용한다.

## 트리거

관리자 채널에서 다음과 같은 요청이 오면:
- "사용자 수 알려줘"
- "이번 주 가장 활동한 사람은?"
- "음성 채팅 통계 보여줘"
- "마법사관학교 DB에서 ~ 조회해줘"
- 서버 데이터/통계/활동 관련 질문

## 사용법

```bash
bash /home/node/.claude/skills/db-query/db-query.sh "SELECT count(*) FROM users_clean"
```

긴 쿼리는 stdin으로:

```bash
bash /home/node/.claude/skills/db-query/db-query.sh <<SQL
SELECT nickname, total_seconds
FROM users_clean
ORDER BY total_seconds DESC
LIMIT 10;
SQL
```

## 중요: `_clean` VIEW만 사용할 것

원본 테이블(`users`, `voice_sessions` 등)은 **봇과 테스트 계정이 포함**되어 있어서 통계가 왜곡된다. 개굴이는 이 원본 테이블에 접근 권한이 **없다**(DB 레벨 차단).

대신 `_clean` VIEW를 사용해라. 이 VIEW들은 `excluded_user_ids` 테이블 기반으로 자동 필터링된다.

### 접근 가능한 VIEW (봇/테스트 제외됨)

- `users_clean` — 실제 유저 (1162명)
- `voice_sessions_clean` — 음성 채팅 (봇 제외)
- `daily_streaks_clean` — 출석 스트릭
- `chat_activity_clean` — 채팅 활동
- `reaction_usage_clean` — 이모지 사용

### 그 외 접근 가능한 테이블 (필터 불필요)

- `todos`, `recurring_todos`, `pomodoro_settings` — 투두/뽀모도로
- `personal_awards`, `house_awards`, `house_images` — 어워드/하우스
- `masahak_documents` — 마법사관학교 문서
- `excluded_user_ids` — 제외된 유저 목록 (참고용)

### 현재 제외된 유저

| user_id | 이름 | 사유 |
|---------|------|------|
| 1325460722355798036 | ✦뮤지✦ | 음악봇 |
| 826698986970677278 | ✦알로항✦ | 봇 |
| 9990000001 | [테스트] 민수 | 테스트 계정 |
| 9990000002 | [테스트] 지연 | 테스트 계정 |

## 권한 (DB 레벨에서 강제됨)

- **SELECT만 가능** — INSERT/UPDATE/DELETE/DROP/ALTER 등은 DB가 거부함
- **BYPASSRLS** — 분석 목적이므로 RLS 정책 우회
- **민감 테이블 접근 불가** (DB 권한 자체가 없음):
  - `diaries`, `diary_replies`, `device_tokens`, `notifications`, `notification_settings`
- **원본 테이블 접근 불가** (봇 데이터 오염 방지): `users`, `voice_sessions`, `daily_streaks`, `chat_activity`, `reaction_usage`

## 주의사항

1. **개인정보 보호**: 특정 사용자의 개인 데이터를 일반 멤버에게 노출하지 말 것. 통계는 OK.
2. **결과 검증**: 쿼리 결과를 그대로 답하지 말고, 사람이 이해하기 쉽게 가공해서 보고할 것.
3. **위험한 쿼리 거부**: DROP/DELETE/UPDATE/INSERT/ALTER/TRUNCATE 등은 "이 봇은 read-only 입니다"라고 거절.
4. **민감 테이블 직접 요청 거부**: `diaries`, `device_tokens` 등은 "프라이버시상 접근 불가" 답변.
5. **LIMIT 필수**: LIMIT 없이 큰 테이블 전체 조회 금지. 적절히 LIMIT/집계.

## 예시 쿼리

```sql
-- 활동 시간 TOP 10
SELECT nickname, total_seconds, level
FROM users_clean
ORDER BY total_seconds DESC
LIMIT 10;

-- 이번 주 음성 채팅 시간
SELECT
  u.nickname,
  SUM(v.duration_seconds)/3600.0 AS hours
FROM voice_sessions_clean v
JOIN users_clean u ON u.user_id = v.user_id
WHERE v.started_at >= NOW() - INTERVAL '7 days'
GROUP BY u.nickname
ORDER BY hours DESC
LIMIT 10;
```

## 환경

스크립트는 `/workspace/global/tools.env`에서 `DB_URL_READONLY`를 로드한다.
이 파일이 없으면 호스트의 `groups/global/tools.env`를 확인할 것.
