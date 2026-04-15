#!/usr/bin/env node
// scripts/seed-tasks.mjs
//
// Seeds (or re-seeds) the OpenClaw-migrated scheduled_tasks for 개굴이.
// Single source of truth for the 3 operational cron tasks:
//   - 월간 랭킹 공지 (매월 1일 9시)
//   - 업무일지 작성 heartbeat (매일 9시)
//   - 세션 덤프 정리 heartbeat (매일 새벽 3시)
//
// Usage: from repo root, after NanoClaw setup:
//   npx tsx scripts/seed-tasks.mjs          # insert / overwrite all tasks
//   npx tsx scripts/seed-tasks.mjs --dry    # preview without writing
//
// Safe to re-run: existing rows with the same id are deleted and recreated.
// Edit the PROMPTS section below to change behavior, then re-run.

import Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = path.join(REPO_ROOT, 'store', 'messages.db');
const TZ = process.env.TZ || 'Asia/Seoul';

// ─────────────── 대상 그룹 / 채널 ───────────────

const GROUP_FOLDER = 'discord_main';
const CHAT_JID = 'dc:1489283292489449585';     // 🐸개굴이-업무전달
const ADMIN_CHANNEL = '1489283292489449585';
const NOTICE_CHANNEL = '1231132864867860511';    // 월간 랭킹 공지 대상

// ─────────────── Prompts ───────────────

const dailyLogPrompt = `매일 오전 9시 — 업무일지 작성 (HEARTBEAT, 크로스 그룹 요약 포함)

**사전 확인**: 오늘 날짜의 \`daily-memories/YYYY/MM/YYYY-MM-DD.md\` 파일이 이미 존재하면 "HEARTBEAT_OK"만 응답하고 종료.

없으면 아래 전체 절차 수행.

---

## 📥 수집 대상 기간

전날 09:00:00 KST ~ 오늘 08:59:59 KST (24시간 윈도우)

KST는 UTC+9. 시간 비교 시 SQLite의 \`datetime(timestamp, '+9 hours')\` 로 변환하거나, 단순히 \`datetime(timestamp) >= datetime('now', '-24 hours')\` 를 쓰면 실행 시점 기준 24시간 전 범위와 동일.

---

## 🔍 수집 절차

### 1️⃣ 자기 그룹(discord_main) 활동 — 기존

- 전날 업무일지(\`daily-memories/YYYY/MM/(어제).md\`) 읽기
- 자기 그룹 \`conversations/\` 디렉토리의 최근 세션 덤프 확인 (있으면)
- 자기 그룹 메시지 로그 쿼리:

\`\`\`bash
sqlite3 /workspace/project/store/messages.db <<SQL
SELECT datetime(timestamp) AS time, is_from_me, sender_name, substr(content, 1, 300) AS content
FROM messages
WHERE chat_jid = 'dc:${ADMIN_CHANNEL}'
  AND datetime(timestamp) >= datetime('now', '-24 hours')
ORDER BY timestamp;
SQL
\`\`\`

여기서 추출: 주요 질문/답변, 관리자 지시사항, 오고 간 대화의 핵심

### 2️⃣ 🆕 티켓 그룹(discord_tickets) 활동 — NEW

티켓 카테고리 아래 모든 채널(ticket-*)의 인바운드/아웃바운드를 쿼리:

\`\`\`bash
sqlite3 /workspace/project/store/messages.db <<SQL
SELECT datetime(timestamp) AS time, is_from_me, sender_name, substr(content, 1, 400) AS content
FROM messages
WHERE chat_jid = 'dc:tickets'
  AND datetime(timestamp) >= datetime('now', '-24 hours')
ORDER BY timestamp;
SQL
\`\`\`

- 각 티켓 채널별로 그룹핑 (content 앞에 \`[ticket-channel:<CHANNEL_ID> #ticket-XXXX]\` 프리픽스가 붙어있음 — 그 안에서 ticket ID 추출)
- is_from_me=0 = 사용자 요청, is_from_me=1 = 개굴이(티켓 그룹 세션) 응답
- 요약 포맷 예: \`ticket-0776 (4lpaka): 다이어리 생성 요청 → 소용돌이 기숙사 채널 #<닉네임> 생성 완료\`
- 에러/미해결 티켓이 있으면 별도 표기

티켓 컨테이너가 실행한 bash 도구 결과(예: create-diary.sh 8단계 출력)는 메시지 로그엔 안 남지만, 티켓 세션 jsonl에는 있다. 필요하면 참고:

\`\`\`bash
ls /workspace/project/data/sessions/discord_tickets/.claude/projects/-workspace-group/ 2>/dev/null
# jsonl 파일 있으면 tail로 최근 tool_result 확인 가능 (선택적)
\`\`\`

### 3️⃣ 🆕 스케줄 태스크 실행 결과 — NEW

전날 24시간 동안 실행된 자동 태스크들 확인:

\`\`\`bash
sqlite3 /workspace/project/store/messages.db <<SQL
SELECT id, schedule_value, datetime(last_run) AS last_run,
       substr(last_result, 1, 200) AS result_preview, status
FROM scheduled_tasks
WHERE last_run IS NOT NULL
  AND datetime(last_run) >= datetime('now', '-24 hours')
ORDER BY last_run DESC;
SQL
\`\`\`

예상되는 태스크:
- \`migrated-heartbeat-memory-cleanup\` (매일 03:00) — 세션 덤프 정리 결과
- \`migrated-heartbeat-daily-log\` (어제 09:00) — 어제의 업무일지 작성 이력
- \`migrated-monthly-ranking\` (매월 1일 09:00) — 해당 일이 1일인 경우

각 태스크의 성공/실패를 한 줄로 요약.

### 4️⃣ 🆕 에러/이상 징후 — NEW (선택)

\`task_run_logs\` 테이블에 실패 기록이 있으면 포함:

\`\`\`bash
sqlite3 /workspace/project/store/messages.db <<SQL
SELECT datetime(run_at) AS run_at, task_id, status, substr(error, 1, 200) AS error
FROM task_run_logs
WHERE status = 'error' AND datetime(run_at) >= datetime('now', '-24 hours')
ORDER BY run_at DESC
LIMIT 10;
SQL
\`\`\`

결과가 있으면 "⚠️ 특이사항"에 포함. 없으면 섹션 생략.

---

## 📝 파일 작성

경로: \`daily-memories/YYYY/MM/YYYY-MM-DD.md\` (반드시 **계층 경로**, 평탄 경로 금지)
경로 없으면 \`mkdir -p\` 먼저.

### 파일 템플릿

\`\`\`markdown
# 업무일지 — YYYY-MM-DD (요일)

## 대상 기간
(전날) 09:00 ~ (오늘) 08:59 (KST)

## 📋 관리자 채널 활동

### 주요 질문/답변
- ...

### 관리자 지시사항
- ... (지시자 이름 포함, 완료/미완료 표기)

### 주요 활동
- ... (파일 수정, 스킬 실행, DB 쿼리 등)

## 🎫 티켓 그룹 활동

- **ticket-XXXX** (<닉네임>): <요청> → <결과>
- **ticket-YYYY** (<닉네임>): <요청> → <결과>
- 총 N건 처리 (성공 N, 실패 N, 미해결 N)

## ⏰ 자동 태스크 실행

| 태스크 | 시각 | 상태 | 결과 |
|---|---|---|---|
| migrated-heartbeat-memory-cleanup | 03:00 | ✅ | 삭제 0개 |
| migrated-heartbeat-daily-log (어제분) | 09:00 | ✅ | 작성 완료 |

## ⚠️ 특이사항
- ... (에러, 이상 동작, 호스트 개입 필요 사항 등)
\`\`\`

섹션 중 **해당 이벤트가 없는 섹션은 "(없음)" 또는 생략**. 강제로 채우지 말 것.

---

## 📤 후속 작업

1. Write 도구로 파일 저장
2. Read로 재확인 (저장 성공 검증)
3. 관리자 채널(${ADMIN_CHANNEL})에 **짧은 요약** 전달 (예: "업무일지 작성 완료 — 티켓 N건, 태스크 M건, 특이사항 X건")
4. 긴 본문을 관리자 채널에 붙여넣지 말 것. 파일만 저장하고 한 줄 알림.

**경로 규칙**: 반드시 계층 경로(\`daily-memories/YYYY/MM/YYYY-MM-DD.md\`). 평탄 경로 금지.`;

const memoryCleanupPrompt = `매일 새벽 3시 — 오래된 세션 덤프 정리 (HEARTBEAT)

이미 오늘 실행했으면 다시 하지 않는다.

1. memory-cleanup 스킬 실행:
   bash /home/node/.claude/skills/memory-cleanup/cleanup.sh 7

2. 결과 로그 확인 (삭제 개수, 보존 개수)

3. 업무일지(YYYY-MM-DD.md)는 절대 건드리지 않는다 (스킬이 세션 덤프 YYYY-MM-DD-HHMM.md만 타겟팅)

4. 삭제된 파일이 100개 이상이면 관리자 채널(${ADMIN_CHANNEL})에 보고, 적으면 조용히 처리.`;

// SQL queries need single quotes. We build them with \u0027 to avoid
// escaping gymnastics inside the template literal.
const Q = '\u0027';

const monthlyRankingPrompt = `매월 1일 오전 9시 — 월간 랭킹 공지

## 날짜 계산 (먼저 한다)

오늘은 매월 1일 09:00 KST. **전월(=직전 달)** 의 데이터를 집계한다.

1. 오늘 날짜를 KST 기준으로 확인 (예: 2026-05-01 → 전월=2026-04 = 4월)
2. 전월의 월 숫자를 \`{PREV_MONTH}\` 로 둔다 (1~12)
3. 전월 기간 = 전월1일 00:00 KST ~ 당월1일 00:00 KST (exclusive)
   - 예: 전월=2026-04 → \`2026-04-01\` ~ \`2026-04-30\` (또는 \`< 2026-05-01\`)

## DB 쿼리 (bash)

1. 공부시간 TOP 10 — SQL의 날짜 리터럴은 위에서 계산한 실제 날짜로 치환:
   \`\`\`bash
   bash /home/node/.claude/skills/db-query/db-query.sh "SELECT u.user_id, u.nickname, u.level, ROUND(SUM(v.duration_seconds)/3600.0, 1) AS hours FROM voice_sessions_clean v JOIN users_clean u ON u.user_id = v.user_id WHERE v.started_at >= ${Q}<전월1일>${Q} AND v.started_at < ${Q}<당월1일>${Q} GROUP BY u.user_id, u.nickname, u.level ORDER BY hours DESC LIMIT 10"
   \`\`\`
2. 이모지 반응 TOP 3:
   \`\`\`bash
   bash /home/node/.claude/skills/db-query/db-query.sh "SELECT u.user_id, u.nickname, u.level, SUM(r.count) AS emoji_count FROM reaction_usage_clean r JOIN users_clean u ON u.user_id = r.user_id WHERE r.usage_date >= ${Q}<전월1일>${Q} AND r.usage_date < ${Q}<당월1일>${Q} GROUP BY u.user_id, u.nickname, u.level ORDER BY emoji_count DESC LIMIT 3"
   \`\`\`
   (\`<전월1일>\`, \`<당월1일>\`은 \`YYYY-MM-DD\` 형식 실제 날짜로 치환)

## 송신 방법

NanoClaw의 streaming은 에이전트의 **마지막 응답만** 현재 그룹 채널로 보낸다. 공지 채널(${NOTICE_CHANNEL})은 현재 그룹의 채널이 아니므로 NanoClaw 텍스트 응답으로는 도달할 수 없다. 대신 **\`post-discord\` 스킬**로 Discord API에 직접 게시한다:

\`\`\`bash
bash /home/node/.claude/skills/post-discord/post-discord.sh ${NOTICE_CHANNEL} <<'EOM'
# <a:zbutterfly_pink:1371314035194335295> {PREV_MONTH}월 랭킹 발표 <a:zbutterfly_pink:1371314035194335295>

### 공부시간
1. <@user_id> (레벨마법사) - XXh XXm
...

### 이모지 반응
1. <@user_id> (레벨마법사) - XX개
...

||@everyone ||
EOM
\`\`\`

(\`{PREV_MONTH}\`는 위에서 계산한 실제 월 숫자로 치환. heredoc 안에 그대로 두지 말 것)

송신 성공(\`{"id":..., "channel_id":...}\` JSON 응답) 확인 후 업무일지(\`/workspace/group/daily-memories/YYYY/MM/YYYY-MM-DD.md\`)에 한 줄 append:

\`\`\`
## 월간 랭킹 공지 — <YYYY>-<MM>-<DD>
- 공지 채널(${NOTICE_CHANNEL})에 {PREV_MONTH}월 랭킹 게시 완료
- 공부시간 TOP1: <닉네임> - XXh XXm
- 이모지 반응 TOP1: <닉네임> - XX개
\`\`\`

마지막 응답(=관리자 채널 확인용): \`{PREV_MONTH}월 랭킹 공지 완료 ✅\` 한 줄로 짧게.

## 양식 규칙

- **제목 \`{PREV_MONTH}\`는 반드시 실제 숫자로 치환** (예: \`# ... 4월 랭킹 발표 ...\`). \`{PREV_MONTH}\` 라는 글자를 그대로 두지 말 것
- 레벨 매핑: 1=수습, 2=초급, 3=중급, 4=중급, 5=중급, 6=중급, 7=상급, 8=정예, 9=숙련
- 시간 변환: hours → \`XXh XXm\` (예: 93.9시간 → \`93h 54m\`, 311.6시간 → \`311h 36m\`)
- 멘션은 \`<@user_id>\` 형식으로 (닉네임 아닌 실제 Discord user_id)
- TOP10/TOP3 모두 1위부터 순서대로`;

// ─────────────── 태스크 정의 ───────────────

const TASKS = [
  {
    id: 'migrated-heartbeat-daily-log',
    schedule_value: '0 9 * * *',       // 매일 09:00 KST
    prompt: dailyLogPrompt,
  },
  {
    id: 'migrated-heartbeat-memory-cleanup',
    schedule_value: '0 3 * * *',       // 매일 03:00 KST
    prompt: memoryCleanupPrompt,
  },
  {
    id: 'migrated-monthly-ranking',
    schedule_value: '0 9 1 * *',       // 매월 1일 09:00 KST
    prompt: monthlyRankingPrompt,
  },
];

// ─────────────── 실행 ───────────────

const dryRun = process.argv.includes('--dry');
const nextRun = (expr) =>
  CronExpressionParser.parse(expr, { tz: TZ }).next().toDate().toISOString();

if (dryRun) {
  console.log(`[DRY] TZ=${TZ}, DB=${DB_PATH}`);
  for (const t of TASKS) {
    console.log(
      `[DRY] ${t.id} (${t.schedule_value}) → next: ${nextRun(t.schedule_value)}`,
    );
    console.log(`       prompt: ${t.prompt.slice(0, 80)}...`);
  }
  process.exit(0);
}

const db = new Database(DB_PATH);
const now = new Date().toISOString();

// UPSERT (ON CONFLICT) — DELETE+INSERT는 task_run_logs FK 제약에 걸린다.
// UPDATE in-place로 prompt/schedule을 갱신하고, 행이 없으면 INSERT.
const upsert = db.prepare(
  `INSERT INTO scheduled_tasks (
    id, group_folder, chat_jid, prompt, script,
    schedule_type, schedule_value, context_mode,
    next_run, status, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    group_folder = excluded.group_folder,
    chat_jid = excluded.chat_jid,
    prompt = excluded.prompt,
    script = excluded.script,
    schedule_type = excluded.schedule_type,
    schedule_value = excluded.schedule_value,
    context_mode = excluded.context_mode,
    next_run = excluded.next_run,
    status = excluded.status`,
);

const tx = db.transaction(() => {
  for (const t of TASKS) {
    const nr = nextRun(t.schedule_value);
    upsert.run(
      t.id,
      GROUP_FOLDER,
      CHAT_JID,
      t.prompt,
      null,
      'cron',
      t.schedule_value,
      'group',
      nr,
      'active',
      now,
    );
    console.log(`✓ ${t.id} — next run: ${nr}`);
  }
});

tx();

console.log('\n=== all cron-type scheduled tasks ===');
for (const row of db
  .prepare(
    "SELECT id, schedule_value, next_run, status FROM scheduled_tasks WHERE schedule_type='cron' ORDER BY id",
  )
  .all()) {
  console.log(row);
}
db.close();
