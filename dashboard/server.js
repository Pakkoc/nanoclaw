// 개굴이 NanoClaw 대시보드 — Express 백엔드
// 포트 18790, Basic auth, 읽기 전용
//
// OpenClaw 시절 대시보드에서 포팅. 모든 경로를 ~/nanoclaw/ 로 재설정하고
// scheduled_tasks / registered_groups / messages / docker container 같은
// NanoClaw 메타데이터 라우트를 추가했다.

const express = require('express');
const basicAuth = require('express-basic-auth');
const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const Database = require('better-sqlite3');

const app = express();
const PORT = 18790;
const HOME = process.env.HOME || require('os').homedir();

// ===== 경로 (NanoClaw) =====
const NANOCLAW_ROOT = process.env.NANOCLAW_ROOT || path.resolve(HOME, 'nanoclaw');
const GROUPS_DIR = path.join(NANOCLAW_ROOT, 'groups');
const MAIN_GROUP_DIR = path.join(GROUPS_DIR, 'discord_main');
const MEMORY_DIR = path.join(MAIN_GROUP_DIR, 'daily-memories');
const MEMORIES_FILE = path.join(MAIN_GROUP_DIR, 'memories.md');
const SKILLS_DIR = path.join(NANOCLAW_ROOT, 'container', 'skills');
const DOCS_DIR = path.join(NANOCLAW_ROOT, 'docs');
const NANOCLAW_DB = path.join(NANOCLAW_ROOT, 'store', 'messages.db');

// ===== 환경변수 =====
// .env (TZ, ASSISTANT_NAME, ONECLI_URL 등 비-비밀)
require('dotenv').config({ path: path.join(NANOCLAW_ROOT, '.env') });
// tools.env (DB_URL_READONLY, DISCORD_BOT_TOKEN, GMAIL_*, DASHBOARD_USER/PASS — 비밀)
require('dotenv').config({ path: path.join(GROUPS_DIR, 'global', 'tools.env') });

const DASHBOARD_USER = process.env.DASHBOARD_USER || 'admin';
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || 'changeme';
const DB_URL_READONLY = process.env.DB_URL_READONLY || '';

// 이메일 설정 (Gmail SMTP)
const GMAIL_USER = process.env.GMAIL_USER || '';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || '';
const REPORT_RECIPIENT = process.env.REPORT_RECIPIENT || GMAIL_USER;

let mailTransporter = null;
if (GMAIL_USER && GMAIL_APP_PASSWORD) {
  mailTransporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });
  console.log(`이메일 활성: ${GMAIL_USER} → ${REPORT_RECIPIENT}`);
} else {
  console.log('이메일 비활성 (GMAIL_USER/GMAIL_APP_PASSWORD 미설정)');
}

// ===== 미들웨어 =====
app.use(basicAuth({
  users: { [DASHBOARD_USER]: DASHBOARD_PASS },
  challenge: true,
  realm: 'NanoClaw Admin Dashboard',
}));
app.use(express.static(path.join(__dirname, 'public')));

// ===== 유틸: 메모리 파일 검색 =====
// daily-memories/YYYY/MM/YYYY-MM-DD*.md 패턴
function findMemoryFilesForDate(dateStr) {
  const [year, month] = dateStr.split('-');
  const hierarchicalDir = path.join(MEMORY_DIR, year, month);
  const results = [];

  if (fs.existsSync(hierarchicalDir) && fs.statSync(hierarchicalDir).isDirectory()) {
    for (const f of fs.readdirSync(hierarchicalDir)) {
      if (f.startsWith(dateStr) && f.endsWith('.md')) {
        const full = path.join(hierarchicalDir, f);
        results.push({ file: f, full, mtime: fs.statSync(full).mtime });
      }
    }
  }

  // 평탄형 fallback (혹시 있을 경우)
  if (results.length === 0) {
    const flatFile = path.join(MEMORY_DIR, `${dateStr}.md`);
    if (fs.existsSync(flatFile)) {
      results.push({ file: `${dateStr}.md`, full: flatFile, mtime: fs.statSync(flatFile).mtime });
    }
  }

  return results.sort((a, b) => a.file.localeCompare(b.file));
}

function readMemoryFile(fileInfo) {
  const content = fs.readFileSync(fileInfo.full, 'utf8');
  return {
    file: fileInfo.file,
    mtime: fileInfo.mtime,
    content,
    html: marked.parse(content),
  };
}

function ymd(date) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(date);
}

const DAILY_PATTERN = /^\d{4}-\d{2}-\d{2}\.md$/;
const SESSION_DUMP_PATTERN = /^\d{4}-\d{2}-\d{2}-\d{4}\.md$/;

// ===== API: 최근 N일 업무일지 =====
app.get('/api/recent-work', (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 7, 30);
    const result = [];
    for (let i = 0; i < days; i++) {
      const date = new Date(Date.now() - i * 86400000);
      const dateStr = ymd(date);
      const files = findMemoryFilesForDate(dateStr);
      const dailyFile = files.find(f => DAILY_PATTERN.test(f.file));
      const sessionDumps = files.filter(f => SESSION_DUMP_PATTERN.test(f.file));
      result.push({
        date: dateStr,
        daily: dailyFile ? readMemoryFile(dailyFile) : null,
        sessions: sessionDumps.map(readMemoryFile),
      });
    }
    res.json({ days: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== API: 장기 기억 (groups/discord_main/memories.md) =====
app.get('/api/memory/long', (req, res) => {
  try {
    if (!fs.existsSync(MEMORIES_FILE)) {
      return res.json({ exists: false, html: '<em>memories.md 없음</em>' });
    }
    const content = fs.readFileSync(MEMORIES_FILE, 'utf8');
    res.json({
      exists: true,
      content,
      html: marked.parse(content),
      mtime: fs.statSync(MEMORIES_FILE).mtime,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== API: 최근 수정된 메모리 파일 =====
app.get('/api/memory/recent', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const all = [];
    function walk(dir) {
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (name.endsWith('.md')) {
          all.push({
            path: path.relative(MEMORY_DIR, full).replace(/\\/g, '/'),
            size: stat.size,
            mtime: stat.mtime,
          });
        }
      }
    }
    walk(MEMORY_DIR);
    all.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    res.json(all.slice(0, limit));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== API: PM2 (호스트의 모든 PM2 프로세스) =====
app.get('/api/system/pm2', (req, res) => {
  try {
    const out = execSync('pm2 jlist 2>/dev/null', {
      encoding: 'utf8',
      shell: '/bin/bash',
    });
    const list = JSON.parse(out);
    const simplified = list.map(p => ({
      name: p.name,
      pid: p.pid,
      status: p.pm2_env.status,
      uptime: p.pm2_env.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : 0,
      restarts: p.pm2_env.restart_time,
      cpu: p.monit.cpu,
      memory: p.monit.memory,
    }));
    res.json(simplified);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== API: NanoClaw systemd 서비스 상태 =====
app.get('/api/nanoclaw/service', (req, res) => {
  try {
    let active = 'unknown';
    let mainPid = null;
    let memory = null;
    try {
      active = execSync('systemctl --user is-active nanoclaw', { encoding: 'utf8' }).trim();
    } catch (e) {
      active = 'inactive';
    }
    try {
      const show = execSync('systemctl --user show nanoclaw -p MainPID,MemoryCurrent,ActiveEnterTimestamp', { encoding: 'utf8' });
      const props = {};
      for (const line of show.trim().split('\n')) {
        const [k, ...v] = line.split('=');
        props[k] = v.join('=');
      }
      mainPid = parseInt(props.MainPID) || null;
      memory = parseInt(props.MemoryCurrent) || null;
      res.json({
        active,
        main_pid: mainPid,
        memory_bytes: memory,
        active_since: props.ActiveEnterTimestamp || null,
      });
    } catch (e) {
      res.json({ active, error: e.message });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== API: NanoClaw 에이전트 컨테이너 =====
app.get('/api/nanoclaw/containers', (req, res) => {
  try {
    const out = execSync('docker ps -a --filter name=nanoclaw --format "{{.Names}}|{{.Status}}|{{.Image}}|{{.RunningFor}}|{{.ID}}"', {
      encoding: 'utf8',
    });
    const lines = out.trim().split('\n').filter(l => l);
    const containers = lines.map(l => {
      const [name, status, image, age, id] = l.split('|');
      return { name, status, image, age, id };
    });
    res.json(containers);
  } catch (e) {
    res.status(500).json({ error: e.message, containers: [] });
  }
});

// ===== API: NanoClaw scheduled_tasks =====
app.get('/api/nanoclaw/scheduled-tasks', (req, res) => {
  try {
    const db = new Database(NANOCLAW_DB, { readonly: true });
    const tasks = db.prepare(`
      SELECT id, group_folder, chat_jid, schedule_type, schedule_value,
             next_run, last_run, last_result, status, context_mode, created_at,
             substr(prompt, 1, 200) AS prompt_preview,
             length(prompt) AS prompt_length
      FROM scheduled_tasks
      ORDER BY
        CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
        next_run
    `).all();
    db.close();
    res.json(tasks);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/nanoclaw/scheduled-tasks/:id', (req, res) => {
  try {
    const db = new Database(NANOCLAW_DB, { readonly: true });
    const task = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(req.params.id);
    db.close();
    if (!task) return res.status(404).json({ error: 'not found' });
    res.json(task);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== API: NanoClaw 등록 그룹 =====
app.get('/api/nanoclaw/registered-groups', (req, res) => {
  try {
    const db = new Database(NANOCLAW_DB, { readonly: true });
    const groups = db.prepare(`
      SELECT jid, name, folder, trigger_pattern, requires_trigger, is_main, added_at
      FROM registered_groups
      ORDER BY is_main DESC, added_at
    `).all();
    db.close();
    res.json(groups);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== API: NanoClaw 최근 메시지 =====
app.get('/api/nanoclaw/messages', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 30, 200);
    const chatJid = req.query.chat_jid || null;
    const db = new Database(NANOCLAW_DB, { readonly: true });

    const where = chatJid ? 'WHERE chat_jid = ?' : '';
    const args = chatJid ? [chatJid, limit] : [limit];

    const messages = db.prepare(`
      SELECT m.id, m.chat_jid, m.sender, m.sender_name, m.content,
             m.timestamp, m.is_from_me, m.is_bot_message,
             m.reply_to_sender_name, m.reply_to_message_content,
             c.name AS chat_name
      FROM messages m
      LEFT JOIN chats c ON c.jid = m.chat_jid
      ${where}
      ORDER BY m.timestamp DESC
      LIMIT ?
    `).all(...args);
    db.close();
    res.json(messages);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== API: NanoClaw chats (라우팅 가능한 채널 목록) =====
app.get('/api/nanoclaw/chats', (req, res) => {
  try {
    const db = new Database(NANOCLAW_DB, { readonly: true });
    const chats = db.prepare(`
      SELECT c.jid, c.name, c.channel, c.is_group, c.last_message_time,
             (SELECT COUNT(*) FROM messages WHERE chat_jid = c.jid) AS message_count
      FROM chats c
      ORDER BY c.last_message_time DESC
      LIMIT 50
    `).all();
    db.close();
    res.json(chats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== API: 호스트 리소스 =====
app.get('/api/system/host', (req, res) => {
  try {
    const diskOut = execSync('df -h / | tail -1', { encoding: 'utf8' });
    const memOut = execSync('free -m | grep Mem', { encoding: 'utf8' });
    const uptimeOut = execSync('uptime -p', { encoding: 'utf8' });
    const loadOut = execSync('cat /proc/loadavg', { encoding: 'utf8' });

    const diskParts = diskOut.trim().split(/\s+/);
    const memParts = memOut.trim().split(/\s+/);

    res.json({
      disk: { size: diskParts[1], used: diskParts[2], avail: diskParts[3], percent: diskParts[4] },
      memory: { total: parseInt(memParts[1]), used: parseInt(memParts[2]), free: parseInt(memParts[3]) },
      uptime: uptimeOut.trim(),
      load: loadOut.trim().split(/\s+/).slice(0, 3).join(' '),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== DB 쿼리 (Supabase, 호스트 직접 psql) =====
function runDbQuery(sql) {
  if (!DB_URL_READONLY) {
    throw new Error('DB_URL_READONLY 미설정 (groups/global/tools.env 확인)');
  }
  const escaped = sql.replace(/"/g, '\\"').replace(/\$/g, '\\$');
  const out = execSync(`psql "${DB_URL_READONLY}" -P pager=off -F " | " -A -c "${escaped}"`, {
    encoding: 'utf8',
    shell: '/bin/bash',
    maxBuffer: 10 * 1024 * 1024,
  });
  return out;
}

function parseDbOutput(raw) {
  const lines = raw.trim().split('\n').filter(l => l && !l.startsWith('(') && !l.match(/^-+\+/));
  if (lines.length < 1) return { headers: [], rows: [] };
  const headers = lines[0].split(' | ').map(s => s.trim());
  const rows = lines.slice(1).map(line => {
    const values = line.split(' | ').map(s => s.trim());
    const obj = {};
    headers.forEach((h, i) => obj[h] = values[i]);
    return obj;
  });
  return { headers, rows };
}

// ===== Supabase 통계 라우트 =====
app.get('/api/stats/ranking', (req, res) => {
  try {
    const period = req.query.period || 'all';
    let sql;
    if (period === 'all') {
      sql = `
        SELECT u.nickname, u.dormitory, u.level,
               ROUND(u.total_seconds/3600.0, 1) AS hours
        FROM users_clean u
        WHERE u.total_seconds > 0
        ORDER BY u.total_seconds DESC
        LIMIT 20
      `;
    } else {
      let whereClause;
      if (period === '7d') whereClause = "v.started_at >= CURRENT_DATE - INTERVAL '7 days'";
      else if (period === '30d') whereClause = "v.started_at >= CURRENT_DATE - INTERVAL '30 days'";
      else if (period === 'month') whereClause = "v.started_at >= DATE_TRUNC('month', CURRENT_DATE)";
      else return res.status(400).json({ error: 'invalid period' });
      sql = `
        SELECT u.nickname, u.dormitory, u.level,
               ROUND(SUM(v.duration_seconds)/3600.0, 1) AS hours
        FROM voice_sessions_clean v
        JOIN users_clean u ON u.user_id = v.user_id AND u.guild_id = v.guild_id
        WHERE ${whereClause} AND v.duration_seconds > 0
        GROUP BY u.nickname, u.dormitory, u.level
        ORDER BY SUM(v.duration_seconds) DESC
        LIMIT 20
      `;
    }
    res.json(parseDbOutput(runDbQuery(sql)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/stats/dormitory', (req, res) => {
  try {
    const sql = `
      SELECT dormitory, COUNT(*) AS count,
             ROUND(SUM(total_seconds)/3600.0, 1) AS total_hours
      FROM users_clean
      WHERE dormitory IS NOT NULL
      GROUP BY dormitory
      ORDER BY count DESC
    `;
    res.json(parseDbOutput(runDbQuery(sql)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/stats/streaks', (req, res) => {
  try {
    const sql = `
      SELECT streak_date, COUNT(DISTINCT user_id) AS active_users
      FROM daily_streaks_clean
      WHERE streak_date >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY streak_date
      ORDER BY streak_date DESC
    `;
    res.json(parseDbOutput(runDbQuery(sql)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/stats/emoji', (req, res) => {
  try {
    const period = req.query.period || '30d';
    let whereClause = '';
    if (period === 'month') whereClause = "WHERE r.usage_date >= DATE_TRUNC('month', CURRENT_DATE)";
    else if (period === '30d') whereClause = "WHERE r.usage_date >= CURRENT_DATE - INTERVAL '30 days'";
    else if (period === '7d') whereClause = "WHERE r.usage_date >= CURRENT_DATE - INTERVAL '7 days'";
    else if (period !== 'all') return res.status(400).json({ error: 'invalid period' });
    const sql = `
      SELECT u.nickname, SUM(r.count) AS total
      FROM reaction_usage_clean r
      JOIN users_clean u ON u.user_id = r.user_id AND u.guild_id = r.guild_id
      ${whereClause}
      GROUP BY u.nickname
      ORDER BY total DESC
      LIMIT 15
    `;
    res.json(parseDbOutput(runDbQuery(sql)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/stats/overview', (req, res) => {
  try {
    const sql = `
      SELECT
        (SELECT COUNT(*) FROM users_clean) AS total_users,
        (SELECT COUNT(*) FROM users_clean WHERE joined_at IS NOT NULL AND joined_at <= CURRENT_DATE - INTERVAL '7 days') AS users_7d_ago,
        (SELECT COUNT(*) FROM users_clean WHERE joined_at IS NOT NULL AND joined_at >= CURRENT_DATE - INTERVAL '7 days') AS new_users_7d,
        (SELECT COUNT(DISTINCT user_id) FROM voice_sessions_clean WHERE started_at >= CURRENT_DATE) AS dau_today,
        (SELECT COUNT(DISTINCT user_id) FROM voice_sessions_clean WHERE started_at >= CURRENT_DATE - INTERVAL '1 day' AND started_at < CURRENT_DATE) AS dau_yesterday,
        (SELECT COUNT(DISTINCT user_id) FROM voice_sessions_clean WHERE started_at >= CURRENT_DATE - INTERVAL '7 days') AS wau_7d,
        (SELECT COUNT(DISTINCT user_id) FROM voice_sessions_clean WHERE started_at >= CURRENT_DATE - INTERVAL '30 days') AS mau_30d,
        (SELECT COUNT(*) FROM voice_sessions_clean) AS total_sessions,
        (SELECT ROUND(SUM(duration_seconds)/3600.0, 0) FROM voice_sessions_clean) AS total_hours,
        (SELECT COUNT(*) FROM masahak_documents) AS docs
    `;
    res.json(parseDbOutput(runDbQuery(sql)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/stats/heatmap', (req, res) => {
  try {
    const sql = `
      SELECT
        EXTRACT(DOW FROM (started_at AT TIME ZONE 'Asia/Seoul'))::int AS dow,
        EXTRACT(HOUR FROM (started_at AT TIME ZONE 'Asia/Seoul'))::int AS hour,
        COUNT(*) AS count
      FROM voice_sessions_clean
      WHERE started_at >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY dow, hour
      ORDER BY dow, hour
    `;
    res.json(parseDbOutput(runDbQuery(sql)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/stats/growth', (req, res) => {
  try {
    const signupsSql = `
      SELECT TO_CHAR(DATE_TRUNC('month', joined_at), 'YYYY-MM') AS month,
             COUNT(*) AS new_users
      FROM users_clean
      WHERE joined_at IS NOT NULL AND joined_at >= CURRENT_DATE - INTERVAL '12 months'
      GROUP BY DATE_TRUNC('month', joined_at)
      ORDER BY month
    `;
    const retentionSql = `
      WITH cohort AS (
        SELECT user_id, guild_id, DATE_TRUNC('month', joined_at) AS cohort_month, joined_at
        FROM users_clean
        WHERE joined_at IS NOT NULL AND joined_at >= CURRENT_DATE - INTERVAL '6 months'
      )
      SELECT TO_CHAR(c.cohort_month, 'YYYY-MM') AS cohort,
             COUNT(DISTINCT c.user_id) AS cohort_size,
             ROUND(100.0 * COUNT(DISTINCT CASE WHEN v.user_id IS NOT NULL THEN c.user_id END) / NULLIF(COUNT(DISTINCT c.user_id), 0), 1) AS retention_pct
      FROM cohort c
      LEFT JOIN voice_sessions_clean v
        ON v.user_id = c.user_id AND v.guild_id = c.guild_id
        AND v.started_at >= c.joined_at AND v.started_at < c.joined_at + INTERVAL '28 days'
      GROUP BY c.cohort_month
      ORDER BY c.cohort_month
    `;
    res.json({
      signups: parseDbOutput(runDbQuery(signupsSql)),
      retention: parseDbOutput(runDbQuery(retentionSql)),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/stats/churn-risk', (req, res) => {
  try {
    const days = Math.max(1, Math.min(parseInt(req.query.days) || 14, 365));
    const minHours = Math.max(0, Math.min(parseInt(req.query.min_hours) || 10, 10000));
    const sql = `
      SELECT nickname, dormitory, level,
             ROUND(total_seconds/3600.0, 1) AS total_hours,
             TO_CHAR(last_seen_at, 'YYYY-MM-DD') AS last_seen,
             (CURRENT_DATE - last_seen_at::date) AS days_inactive
      FROM users_clean
      WHERE last_seen_at IS NOT NULL
        AND last_seen_at < CURRENT_DATE - INTERVAL '${days} days'
        AND total_seconds > ${minHours * 3600}
        AND status = 'active'
      ORDER BY total_seconds DESC
      LIMIT 20
    `;
    res.json(parseDbOutput(runDbQuery(sql)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== 파일 브라우저 (NanoClaw groups + container/skills + repo files) =====
function safePath(root, relPath) {
  const fullPath = path.resolve(root, relPath || '.');
  if (!fullPath.startsWith(root)) {
    throw new Error('Access denied: path traversal');
  }
  return fullPath;
}

function walkTree(dir, rootForRel, depth = 0) {
  if (depth > 5) return [];
  if (!fs.existsSync(dir)) return [];
  const items = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.') && name !== '.env') continue;
    if (name === 'node_modules') continue;
    if (name === 'tools.env') continue; // 비밀 — UI 노출 금지
    const full = path.join(dir, name);
    const rel = path.relative(rootForRel, full).replace(/\\/g, '/');
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      items.push({ name, path: rel, type: 'dir', children: walkTree(full, rootForRel, depth + 1) });
    } else {
      items.push({ name, path: rel, type: 'file', size: stat.size, mtime: stat.mtime });
    }
  }
  return items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// "워크스페이스" = NanoClaw groups/ 폴더 (CLAUDE.md, soul.md, memories, 등)
app.get('/api/files/tree', (req, res) => {
  try {
    res.json(walkTree(GROUPS_DIR, GROUPS_DIR));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/files/read', (req, res) => {
  try {
    const rel = req.query.path;
    if (!rel) return res.status(400).json({ error: 'path required' });
    if (rel.includes('tools.env')) return res.status(403).json({ error: 'forbidden' });
    const full = safePath(GROUPS_DIR, rel);
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'not found' });
    const stat = fs.statSync(full);
    if (stat.isDirectory()) return res.status(400).json({ error: 'is directory' });
    if (stat.size > 2 * 1024 * 1024) return res.status(413).json({ error: 'file too large' });
    const content = fs.readFileSync(full, 'utf8');
    const ext = path.extname(full).toLowerCase();
    const isMarkdown = ['.md', '.markdown'].includes(ext);
    res.json({
      path: rel,
      size: stat.size,
      mtime: stat.mtime,
      content,
      html: isMarkdown ? marked.parse(content) : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// "운영 문서" = NanoClaw docs/ 폴더
app.get('/api/docs/tree', (req, res) => {
  try {
    if (!fs.existsSync(DOCS_DIR)) return res.json([]);
    res.json(walkTree(DOCS_DIR, DOCS_DIR));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/docs/recent', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const all = [];
    function walk(dir) {
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith('.')) continue;
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (name.endsWith('.md')) {
          all.push({
            path: path.relative(DOCS_DIR, full).replace(/\\/g, '/'),
            size: stat.size,
            mtime: stat.mtime,
          });
        }
      }
    }
    walk(DOCS_DIR);
    all.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    res.json(all.slice(0, limit));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const SEARCH_QUERY_PATTERN = /^[\p{Letter}\p{Number}\s\-_.#@!?'"%/+]+$/u;
app.get('/api/docs/search', (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.status(400).json({ error: '검색어는 2자 이상' });
    if (q.length > 100) return res.status(400).json({ error: '검색어는 100자 이하' });
    if (!SEARCH_QUERY_PATTERN.test(q)) return res.status(400).json({ error: '검색어에 허용되지 않는 문자가 있음' });

    let out = '';
    try {
      out = execFileSync('grep', [
        '-rn', '-i', '-F', '--include=*.md', '--max-count=10', q, DOCS_DIR,
      ], { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 });
    } catch (e) {
      if (e.status === 1) return res.json({ query: q, count: 0, results: [] });
      throw e;
    }

    const byFile = {};
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const firstColon = line.indexOf(':');
      const secondColon = line.indexOf(':', firstColon + 1);
      if (firstColon < 0 || secondColon < 0) continue;
      const fullPath = line.slice(0, firstColon);
      const lineNum = parseInt(line.slice(firstColon + 1, secondColon));
      const text = line.slice(secondColon + 1);
      if (isNaN(lineNum)) continue;
      const relPath = path.relative(DOCS_DIR, fullPath).replace(/\\/g, '/');
      if (!byFile[relPath]) byFile[relPath] = [];
      byFile[relPath].push({
        line: lineNum,
        text: text.length > 200 ? text.slice(0, 200) + '…' : text,
      });
    }

    const results = Object.entries(byFile)
      .slice(0, 50)
      .map(([file, matches]) => ({ file, total: matches.length, matches }));
    res.json({ query: q, count: results.length, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/docs/read', (req, res) => {
  try {
    const rel = req.query.path;
    if (!rel) return res.status(400).json({ error: 'path required' });
    const full = safePath(DOCS_DIR, rel);
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'not found' });
    const stat = fs.statSync(full);
    if (stat.isDirectory()) return res.status(400).json({ error: 'is directory' });
    if (stat.size > 2 * 1024 * 1024) return res.status(413).json({ error: 'file too large' });
    const content = fs.readFileSync(full, 'utf8');
    const ext = path.extname(full).toLowerCase();
    const isMarkdown = ['.md', '.markdown'].includes(ext);
    res.json({
      path: rel,
      size: stat.size,
      mtime: stat.mtime,
      content,
      html: isMarkdown ? marked.parse(content) : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== 스킬 인덱스 (container/skills) =====
app.get('/api/skills', (req, res) => {
  try {
    if (!fs.existsSync(SKILLS_DIR)) return res.json([]);
    const skills = [];
    for (const name of fs.readdirSync(SKILLS_DIR)) {
      const dir = path.join(SKILLS_DIR, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      const skillFile = path.join(dir, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;

      const content = fs.readFileSync(skillFile, 'utf8');

      // YAML frontmatter 파싱 (name + description)
      let fmName = name;
      let fmDesc = '';
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const fm = fmMatch[1];
        const nameLine = fm.match(/^name:\s*(.+)$/m);
        const descLine = fm.match(/^description:\s*(.+)$/m);
        if (nameLine) fmName = nameLine[1].trim();
        if (descLine) fmDesc = descLine[1].trim();
      }

      // H1 추출 (frontmatter 다음)
      const afterFm = fmMatch ? content.slice(fmMatch[0].length) : content;
      const titleMatch = afterFm.match(/^#\s+(.+)$/m);
      const title = titleMatch ? titleMatch[1].trim() : fmName;

      // 트리거 섹션 추출
      const triggerMatch = afterFm.match(/##\s*트리거[\s\S]*?(?=\n##|\n$)/);
      const triggers = [];
      if (triggerMatch) {
        const bullets = triggerMatch[0].match(/-\s*["「『]?([^"「』\n]+?)["」』]?\s*$/gm);
        if (bullets) {
          for (const b of bullets.slice(0, 6)) {
            const clean = b.replace(/^-\s*/, '').replace(/["「『」』]/g, '').trim();
            if (clean) triggers.push(clean);
          }
        }
      }

      // 파일 목록 (스킬 폴더 안의 .sh, .py, .js 등 실행 파일)
      const files = fs.readdirSync(dir).filter(f => f !== 'SKILL.md');

      skills.push({
        name: fmName,
        title,
        description: fmDesc,
        triggers,
        files,
        mtime: fs.statSync(skillFile).mtime,
      });
    }
    skills.sort((a, b) => a.name.localeCompare(b.name));
    res.json(skills);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== Git 상태 (NanoClaw repo) =====
app.get('/api/system/git', (req, res) => {
  try {
    const log = execSync(`cd ${NANOCLAW_ROOT} && git log --oneline -10`, {
      encoding: 'utf8',
      shell: '/bin/bash',
    });
    const status = execSync(`cd ${NANOCLAW_ROOT} && git status --short`, {
      encoding: 'utf8',
      shell: '/bin/bash',
    });
    res.json({
      recent: log.trim().split('\n'),
      status: status.trim() || '(clean)',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== 이메일 발송 (업무일지) =====
function collectReportStats() {
  const stats = { overview: null, retention: [], churn: [], error: null };
  try {
    const overviewSql = `
      SELECT
        (SELECT COUNT(*) FROM users_clean) AS total_users,
        (SELECT COUNT(*) FROM users_clean WHERE joined_at IS NOT NULL AND joined_at >= CURRENT_DATE - INTERVAL '7 days') AS new_users_7d,
        (SELECT COUNT(DISTINCT user_id) FROM voice_sessions_clean WHERE started_at >= CURRENT_DATE) AS dau_today,
        (SELECT COUNT(DISTINCT user_id) FROM voice_sessions_clean WHERE started_at >= CURRENT_DATE - INTERVAL '1 day' AND started_at < CURRENT_DATE) AS dau_yesterday,
        (SELECT COUNT(DISTINCT user_id) FROM voice_sessions_clean WHERE started_at >= CURRENT_DATE - INTERVAL '7 days') AS wau_7d,
        (SELECT COUNT(DISTINCT user_id) FROM voice_sessions_clean WHERE started_at >= CURRENT_DATE - INTERVAL '30 days') AS mau_30d,
        (SELECT ROUND(SUM(duration_seconds)/3600.0, 0) FROM voice_sessions_clean) AS total_hours
    `;
    stats.overview = parseDbOutput(runDbQuery(overviewSql)).rows[0] || null;

    const retentionSql = `
      WITH cohort AS (
        SELECT user_id, guild_id, DATE_TRUNC('month', joined_at) AS cohort_month, joined_at
        FROM users_clean
        WHERE joined_at IS NOT NULL AND joined_at >= CURRENT_DATE - INTERVAL '3 months'
      )
      SELECT TO_CHAR(c.cohort_month, 'YYYY-MM') AS cohort,
             COUNT(DISTINCT c.user_id) AS cohort_size,
             ROUND(100.0 * COUNT(DISTINCT CASE WHEN v.user_id IS NOT NULL THEN c.user_id END) / NULLIF(COUNT(DISTINCT c.user_id), 0), 1) AS retention_pct
      FROM cohort c
      LEFT JOIN voice_sessions_clean v
        ON v.user_id = c.user_id AND v.guild_id = c.guild_id
        AND v.started_at >= c.joined_at AND v.started_at < c.joined_at + INTERVAL '28 days'
      GROUP BY c.cohort_month
      ORDER BY c.cohort_month DESC
      LIMIT 3
    `;
    stats.retention = parseDbOutput(runDbQuery(retentionSql)).rows;

    const churnSql = `
      SELECT nickname, dormitory, ROUND(total_seconds/3600.0, 1) AS total_hours,
        TO_CHAR(last_seen_at, 'YYYY-MM-DD') AS last_seen,
        (CURRENT_DATE - last_seen_at::date) AS days_inactive
      FROM users_clean
      WHERE last_seen_at IS NOT NULL
        AND last_seen_at < CURRENT_DATE - INTERVAL '14 days'
        AND total_seconds > 36000
        AND status = 'active'
      ORDER BY total_seconds DESC
      LIMIT 5
    `;
    stats.churn = parseDbOutput(runDbQuery(churnSql)).rows;
  } catch (e) {
    stats.error = e.message;
  }
  return stats;
}

function buildStatsHtml(stats) {
  if (!stats || stats.error) {
    return `<div style="margin-top:24px;padding:12px;background:#fff3e0;border-radius:6px;color:#e65100;font-size:13px">📊 지표 수집 실패: ${stats?.error || 'unknown'}</div>`;
  }
  const o = stats.overview || {};
  const n = (k) => parseInt(o[k]) || 0;
  const total = n('total_users');
  const newUsers = n('new_users_7d');
  const dau = n('dau_today');
  const dauY = n('dau_yesterday');
  const wau = n('wau_7d');
  const mau = n('mau_30d');
  const hours = n('total_hours');
  const dauMau = mau > 0 ? (dau / mau * 100).toFixed(1) : '0.0';
  const dauDelta = dau - dauY;
  const dauSign = dauDelta > 0 ? '▲' : dauDelta < 0 ? '▼' : '=';

  const kpiCards = `
    <table role="presentation" style="width:100%;border-collapse:separate;border-spacing:8px;margin:0 -8px">
      <tr>
        ${[
          { v: total.toLocaleString(), l: '전체 유저', d: `신규 7일 +${newUsers}` },
          { v: dau, l: '오늘 활성', d: `${dauSign} ${Math.abs(dauDelta)} (어제 ${dauY})` },
          { v: wau, l: '주간 활성', d: `월간 ${mau}` },
          { v: `${dauMau}%`, l: 'DAU/MAU', d: parseFloat(dauMau) >= 15 ? '양호' : '개선 필요' },
        ].map(c => `
          <td style="background:#f1f8f4;border-radius:8px;padding:14px 8px;text-align:center;width:25%">
            <div style="font-size:22px;font-weight:700;color:#4caf50">${c.v}</div>
            <div style="font-size:11px;color:#888;margin-top:2px">${c.l}</div>
            <div style="font-size:10px;color:#4caf50;margin-top:4px">${c.d}</div>
          </td>
        `).join('')}
      </tr>
    </table>
  `;

  const retentionRows = stats.retention.length
    ? stats.retention.map(r => `
        <tr>
          <td style="padding:6px 10px;border-bottom:1px solid #eee">${r.cohort}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center">${r.cohort_size}명</td>
          <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;font-weight:600;color:#4caf50">${r.retention_pct}%</td>
        </tr>
      `).join('')
    : '<tr><td colspan="3" style="padding:10px;color:#888">데이터 없음</td></tr>';

  const churnRows = stats.churn.length
    ? stats.churn.map(c => {
        const days = parseInt(c.days_inactive) || 0;
        const color = days > 60 ? '#d32f2f' : '#f57c00';
        return `
          <tr>
            <td style="padding:6px 10px;border-bottom:1px solid #eee"><strong>${c.nickname || 'unknown'}</strong></td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee;color:#666">${c.dormitory || '-'}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${c.total_hours}h</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;color:${color};font-weight:600">${days}일</td>
          </tr>
        `;
      }).join('')
    : '<tr><td colspan="4" style="padding:10px;color:#4caf50">이탈 위험 없음 🎉</td></tr>';

  return `
    <div style="margin-top:32px">
      <h2 style="font-size:16px;border-left:4px solid #4caf50;padding-left:10px;margin-bottom:14px">📊 현재 지표 (참고)</h2>
      ${kpiCards}
      <div style="margin-top:8px;padding:10px 14px;background:#fafafa;border-radius:6px;font-size:12px;color:#555">
        <strong style="color:#4caf50">총 활동:</strong> ${hours.toLocaleString()}시간 누적
      </div>
      <h3 style="font-size:14px;margin:24px 0 8px;color:#2c3e50">🎯 최근 코호트 유지율 (28일 내 음성 활동)</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#f5f5f5">
            <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #ddd">가입 월</th>
            <th style="padding:8px 10px;text-align:center;border-bottom:2px solid #ddd">가입자</th>
            <th style="padding:8px 10px;text-align:right;border-bottom:2px solid #ddd">유지율</th>
          </tr>
        </thead>
        <tbody>${retentionRows}</tbody>
      </table>
      <h3 style="font-size:14px;margin:24px 0 8px;color:#2c3e50">⚠️ 이탈 위험 TOP 5</h3>
      <p style="font-size:11px;color:#888;margin-bottom:6px">과거 10시간+ 활동 / 14일 이상 미활동</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#f5f5f5">
            <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #ddd">유저</th>
            <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #ddd">기숙사</th>
            <th style="padding:8px 10px;text-align:right;border-bottom:2px solid #ddd">누적</th>
            <th style="padding:8px 10px;text-align:right;border-bottom:2px solid #ddd">미활동</th>
          </tr>
        </thead>
        <tbody>${churnRows}</tbody>
      </table>
    </div>
  `;
}

function buildReportHtml(date, content, stats) {
  const body = marked.parse(content);
  const statsHtml = buildStatsHtml(stats);
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans KR', sans-serif; max-width: 720px; margin: 0 auto; padding: 24px; color: #333; line-height: 1.6; background: #f5f5f5; }
  .container { background: #fff; border-radius: 12px; padding: 32px; box-shadow: 0 2px 8px rgba(0,0,0,0.05); }
  .header { border-bottom: 3px solid #4caf50; padding-bottom: 16px; margin-bottom: 24px; }
  .header h1 { margin: 0; color: #4caf50; font-size: 22px; }
  .header .date { color: #888; font-size: 13px; margin-top: 4px; }
  .body h1, .body h2, .body h3 { color: #2c3e50; margin-top: 24px; }
  .body h2 { font-size: 18px; border-left: 4px solid #4caf50; padding-left: 10px; }
  .body h3 { font-size: 15px; }
  .body ul, .body ol { margin-left: 20px; }
  .body code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-size: 13px; }
  .body pre { background: #f8f8f8; padding: 12px; border-radius: 6px; overflow-x: auto; border: 1px solid #e0e0e0; }
  .divider { border: none; border-top: 1px dashed #ddd; margin: 32px 0; }
  .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #e0e0e0; color: #aaa; font-size: 12px; text-align: center; }
</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🐸 개굴이 업무일지</h1>
      <div class="date">${date}</div>
    </div>
    <div class="body">${body}</div>
    <hr class="divider">
    ${statsHtml}
    <div class="footer">
      마법사관학교 개굴이 NanoClaw 대시보드 · 자동 발송
    </div>
  </div>
</body>
</html>`;
}

function getTodayReport(allowFallback = true, specificDate = null) {
  const today = specificDate || ymd(new Date());
  let files = findMemoryFilesForDate(today);
  let dailyFile = files.find(f => DAILY_PATTERN.test(f.file));
  let actualDate = today;

  if (!dailyFile && allowFallback && !specificDate) {
    for (let i = 1; i <= 14; i++) {
      const past = new Date(Date.now() - i * 86400000);
      const pastStr = ymd(past);
      const pastFiles = findMemoryFilesForDate(pastStr);
      const pastDaily = pastFiles.find(f => DAILY_PATTERN.test(f.file));
      if (pastDaily) {
        dailyFile = pastDaily;
        actualDate = pastStr;
        break;
      }
    }
  }

  if (!dailyFile) {
    return { date: today, found: false };
  }
  const content = fs.readFileSync(dailyFile.full, 'utf8');
  const stats = collectReportStats();
  return {
    date: actualDate,
    requested_date: today,
    is_fallback: actualDate !== today && !specificDate,
    found: true,
    content,
    html: buildReportHtml(actualDate, content, stats),
  };
}

async function sendTodayReport(opts = {}) {
  if (!mailTransporter) {
    throw new Error('이메일이 설정되지 않음 (GMAIL_USER/GMAIL_APP_PASSWORD)');
  }
  const allowFallback = opts.allowFallback !== false;
  const specificDate = opts.date || null;
  const report = getTodayReport(allowFallback, specificDate);
  if (!report.found) {
    throw new Error(`업무일지 파일이 없음: ${report.date}`);
  }
  const subjectPrefix = specificDate
    ? '[개굴이][재발송]'
    : (report.is_fallback ? '[개굴이][이전]' : '[개굴이]');
  const info = await mailTransporter.sendMail({
    from: `"개굴이 🐸" <${GMAIL_USER}>`,
    to: REPORT_RECIPIENT,
    subject: `${subjectPrefix} ${report.date} 업무일지`,
    html: report.html,
    text: report.content,
  });
  return {
    messageId: info.messageId,
    date: report.date,
    is_fallback: report.is_fallback,
    specific_date: specificDate,
    recipient: REPORT_RECIPIENT,
  };
}

app.post('/api/send-report', express.json(), async (req, res) => {
  try {
    const date = req.query.date || (req.body && req.body.date) || null;
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ ok: false, error: 'date 파라미터 형식: YYYY-MM-DD' });
    }
    const result = await sendTodayReport({ date });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/email/status', (req, res) => {
  res.json({
    enabled: !!mailTransporter,
    from: GMAIL_USER || null,
    recipient: REPORT_RECIPIENT || null,
  });
});

if (mailTransporter) {
  cron.schedule('30 9 * * *', async () => {
    try {
      const result = await sendTodayReport({ allowFallback: false });
      console.log(`[cron] 자동 이메일 발송 완료: ${result.date} → ${result.recipient}`);
    } catch (e) {
      console.error(`[cron] 자동 이메일 발송 실패: ${e.message}`);
    }
  }, { timezone: 'Asia/Seoul' });
  console.log('자동 업무일지 이메일 예약: 매일 09:30 KST');
}

// ===== 시작 =====
app.listen(PORT, '0.0.0.0', () => {
  console.log(`개굴이 NanoClaw 대시보드 시작: http://0.0.0.0:${PORT}`);
  console.log(`NanoClaw 루트: ${NANOCLAW_ROOT}`);
  console.log(`그룹: ${GROUPS_DIR}`);
  console.log(`업무일지: ${MEMORY_DIR}`);
  console.log(`스킬: ${SKILLS_DIR}`);
  console.log(`DB: ${NANOCLAW_DB}`);
  console.log(`인증 사용자: ${DASHBOARD_USER}`);
});

// deploy hook verification 2026-04-15T22:00:35+09:00
