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

const dailyLogPrompt = `매일 오전 9시 — 업무일지 작성 (HEARTBEAT)

사전 확인: 오늘 날짜의 daily-memories/YYYY/MM/YYYY-MM-DD.md 파일이 이미 존재하면 "HEARTBEAT_OK"만 응답하고 종료.

없으면:
1. 전날 업무일지(daily-memories/YYYY/MM/(어제).md)와 최근 세션 덤프를 참고
2. (전날 09:00 ~ 오늘 08:59 KST) 동안의 활동 정리:
   - 주요 질문/답변 요약
   - 관리자 지시사항
   - 주요 활동 (다이어리 채널 생성, 스킬 실행, 에러 처리 등)
   - 특이사항
3. Write 도구로 daily-memories/YYYY/MM/YYYY-MM-DD.md 저장 (경로 없으면 mkdir -p 먼저)
4. 저장 후 read로 재확인
5. 관리자 채널(${ADMIN_CHANNEL})에 "업무일지 작성 완료" 전달

파일 템플릿:
# 업무일지 — YYYY-MM-DD (요일)

## 대상 기간
(전날) 09:00 ~ (오늘) 08:59 (KST)

## 주요 질문/답변
- ...

## 관리자 지시사항
- ...

## 주요 활동
- ...

## 특이사항
- ...

**경로 규칙**: 반드시 계층 경로(daily-memories/YYYY/MM/YYYY-MM-DD.md). 평탄 경로 금지.`;

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
const del = db.prepare('DELETE FROM scheduled_tasks WHERE id = ?');
const ins = db.prepare(
  `INSERT INTO scheduled_tasks (
    id, group_folder, chat_jid, prompt, script,
    schedule_type, schedule_value, context_mode,
    next_run, status, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

const tx = db.transaction(() => {
  for (const t of TASKS) {
    del.run(t.id);
    const nr = nextRun(t.schedule_value);
    ins.run(
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
