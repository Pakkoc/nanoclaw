// 개굴이 NanoClaw 대시보드 — 프런트엔드 로직

const charts = {};

// ===== 탭 전환 =====
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.section;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`section-${target}`).classList.add('active');
  });
});

// ===== 유틸 =====
function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}

function fmtDuration(ms) {
  if (!ms) return '-';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtRelTime(dateStr) {
  if (!dateStr) return '-';
  const diff = Date.now() - new Date(dateStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}초 전`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  const d = Math.floor(h / 24);
  return `${d}일 전`;
}

function fmtAbsTime(dateStr) {
  if (!dateStr) return '-';
  try {
    return new Date(dateStr).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  } catch {
    return dateStr;
  }
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// ===== Section 1: 오늘의 개굴이 =====
async function loadRecentWork() {
  try {
    const data = await fetchJson('/api/recent-work?days=7');
    const container = document.getElementById('recent-work');
    container.innerHTML = data.days.map(day => {
      const hasDaily = !!day.daily;
      const sessionCount = day.sessions.length;

      if (!hasDaily && sessionCount === 0) {
        return `<div class="day-block">
          <div class="day-header">📅 ${day.date}</div>
          <div class="empty-day">기록 없음</div>
        </div>`;
      }

      const dailyHtml = hasDaily ? `
        <div class="session-block daily">
          <div class="session-header daily-label">📋 업무일지 · ${fmtRelTime(day.daily.mtime)}</div>
          <div class="session-content">${day.daily.html}</div>
        </div>
      ` : '<div class="empty-day">업무일지 없음</div>';

      const sessionsHtml = sessionCount > 0 ? `
        <details class="sessions-detail">
          <summary>💬 세션 덤프 ${sessionCount}개 펼치기</summary>
          ${day.sessions.map(s => `
            <div class="session-block dump">
              <div class="session-header">📄 ${escapeHtml(s.file)} · ${fmtRelTime(s.mtime)}</div>
              <div class="session-content">${s.html}</div>
            </div>
          `).join('')}
        </details>
      ` : '';

      return `<div class="day-block">
        <div class="day-header">📅 ${day.date}${sessionCount > 0 ? ` · 세션 ${sessionCount}개` : ''}</div>
        ${dailyHtml}
        ${sessionsHtml}
      </div>`;
    }).join('');
  } catch (e) {
    document.getElementById('recent-work').innerHTML = `<div class="loading">에러: ${e.message}</div>`;
  }
}

async function loadLongMemory() {
  try {
    const data = await fetchJson('/api/memory/long');
    const el = document.getElementById('long-memory');
    if (!data.exists) {
      el.innerHTML = '<div class="loading">memories.md 없음</div>';
      return;
    }
    el.innerHTML = data.html;
  } catch (e) {
    document.getElementById('long-memory').innerHTML = `<div class="loading">에러: ${e.message}</div>`;
  }
}

async function loadRecentMemory() {
  try {
    const data = await fetchJson('/api/memory/recent?limit=10');
    const el = document.getElementById('recent-memory');
    if (!data.length) {
      el.innerHTML = '<div class="loading">기록 없음</div>';
      return;
    }
    el.innerHTML = data.map(f => `
      <div class="item">
        <span class="path">${escapeHtml(f.path)}</span>
        <span class="time">${fmtRelTime(f.mtime)}</span>
      </div>
    `).join('');
  } catch (e) {
    document.getElementById('recent-memory').innerHTML = `<div class="loading">에러: ${e.message}</div>`;
  }
}

async function loadNanoclawService() {
  try {
    const data = await fetchJson('/api/nanoclaw/service');
    const isActive = data.active === 'active';
    document.getElementById('nanoclaw-service').innerHTML = `
      <table>
        <tr><td>상태</td><td class="${isActive ? 'status-online' : 'status-stopped'}">${escapeHtml(data.active)}</td></tr>
        <tr><td>Main PID</td><td>${data.main_pid || '-'}</td></tr>
        <tr><td>메모리</td><td>${data.memory_bytes ? fmtBytes(data.memory_bytes) : '-'}</td></tr>
        <tr><td>시작 시각</td><td>${escapeHtml(data.active_since || '-')}</td></tr>
      </table>
    `;
  } catch (e) {
    document.getElementById('nanoclaw-service').innerHTML = `<div class="loading">에러: ${e.message}</div>`;
  }
}

// ===== Section 2: NanoClaw 메타데이터 =====
async function loadScheduledTasks() {
  try {
    const tasks = await fetchJson('/api/nanoclaw/scheduled-tasks');
    if (!tasks.length) {
      document.getElementById('scheduled-tasks').innerHTML = '<div class="loading">등록된 태스크 없음</div>';
      return;
    }
    const rows = tasks.map(t => {
      const statusCls = t.status === 'active' ? 'status-online' : t.status === 'paused' ? 'warning' : '';
      return `
        <tr>
          <td><strong>${escapeHtml(t.id)}</strong><div class="subtle" style="font-size:11px">${escapeHtml(t.group_folder)}</div></td>
          <td><code>${escapeHtml(t.schedule_type)}</code></td>
          <td><code>${escapeHtml(t.schedule_value)}</code></td>
          <td>${fmtAbsTime(t.next_run)}</td>
          <td>${fmtAbsTime(t.last_run)}</td>
          <td class="${statusCls}">${escapeHtml(t.status)}</td>
        </tr>
        <tr class="task-prompt-row">
          <td colspan="6">
            <details>
              <summary>📋 prompt 미리보기 (${t.prompt_length}자)</summary>
              <pre style="white-space:pre-wrap;font-size:12px;color:var(--text-dim);margin-top:8px">${escapeHtml(t.prompt_preview)}${t.prompt_length > 200 ? '…' : ''}</pre>
            </details>
            ${t.last_result ? `<details><summary>🔚 last_result</summary><pre style="white-space:pre-wrap;font-size:12px;color:var(--text-dim);margin-top:8px">${escapeHtml(t.last_result.slice(0, 500))}${t.last_result.length > 500 ? '…' : ''}</pre></details>` : ''}
          </td>
        </tr>
      `;
    }).join('');
    document.getElementById('scheduled-tasks').innerHTML = `
      <table class="task-table">
        <thead>
          <tr>
            <th>ID / 그룹</th>
            <th>type</th>
            <th>schedule</th>
            <th>next_run</th>
            <th>last_run</th>
            <th>상태</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  } catch (e) {
    document.getElementById('scheduled-tasks').innerHTML = `<div class="loading">에러: ${e.message}</div>`;
  }
}

async function loadRegisteredGroups() {
  try {
    const groups = await fetchJson('/api/nanoclaw/registered-groups');
    if (!groups.length) {
      document.getElementById('registered-groups').innerHTML = '<div class="loading">등록된 그룹 없음</div>';
      return;
    }
    const rows = groups.map(g => `
      <tr>
        <td><strong>${escapeHtml(g.folder)}</strong>${g.is_main ? ' <span class="badge-main">MAIN</span>' : ''}</td>
        <td>${escapeHtml(g.name)}</td>
        <td><code>${escapeHtml(g.jid)}</code></td>
        <td><code>${escapeHtml(g.trigger_pattern)}</code></td>
        <td>${g.requires_trigger ? '✓' : '<span class="subtle">불필요</span>'}</td>
        <td>${fmtAbsTime(g.added_at)}</td>
      </tr>
    `).join('');
    document.getElementById('registered-groups').innerHTML = `
      <table>
        <thead>
          <tr><th>folder</th><th>name</th><th>jid</th><th>trigger</th><th>require</th><th>등록</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  } catch (e) {
    document.getElementById('registered-groups').innerHTML = `<div class="loading">에러: ${e.message}</div>`;
  }
}

async function loadNanoclawContainers() {
  try {
    const containers = await fetchJson('/api/nanoclaw/containers');
    if (!containers.length) {
      document.getElementById('nanoclaw-containers').innerHTML = '<div class="loading">실행 중인 컨테이너 없음</div>';
      return;
    }
    const rows = containers.map(c => {
      const isUp = c.status?.startsWith('Up');
      return `
        <tr>
          <td><strong>${escapeHtml(c.name)}</strong></td>
          <td class="${isUp ? 'status-online' : 'status-stopped'}">${escapeHtml(c.status)}</td>
          <td>${escapeHtml(c.image)}</td>
          <td>${escapeHtml(c.age)}</td>
          <td><code>${escapeHtml(c.id?.slice(0, 12))}</code></td>
        </tr>
      `;
    }).join('');
    document.getElementById('nanoclaw-containers').innerHTML = `
      <table>
        <thead><tr><th>이름</th><th>상태</th><th>이미지</th><th>경과</th><th>ID</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  } catch (e) {
    document.getElementById('nanoclaw-containers').innerHTML = `<div class="loading">에러: ${e.message}</div>`;
  }
}

async function loadRecentMessages() {
  try {
    const msgs = await fetchJson('/api/nanoclaw/messages?limit=30');
    if (!msgs.length) {
      document.getElementById('recent-messages').innerHTML = '<div class="loading">메시지 없음</div>';
      return;
    }
    const rows = msgs.map(m => {
      const direction = m.is_from_me ? '⬆️' : '⬇️';
      const cls = m.is_from_me ? 'msg-out' : 'msg-in';
      return `
        <tr class="${cls}">
          <td>${direction}</td>
          <td>${fmtAbsTime(m.timestamp)}</td>
          <td>${escapeHtml(m.chat_name || m.chat_jid)}</td>
          <td>${escapeHtml(m.sender_name || m.sender || '?')}</td>
          <td class="msg-content">${escapeHtml((m.content || '').slice(0, 200))}${m.content && m.content.length > 200 ? '…' : ''}</td>
        </tr>
      `;
    }).join('');
    document.getElementById('recent-messages').innerHTML = `
      <table class="msg-table">
        <thead><tr><th></th><th>시각</th><th>채널</th><th>발신자</th><th>내용</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  } catch (e) {
    document.getElementById('recent-messages').innerHTML = `<div class="loading">에러: ${e.message}</div>`;
  }
}

async function loadNanoclawSkills() {
  try {
    const skills = await fetchJson('/api/skills');
    if (!skills.length) {
      document.getElementById('nanoclaw-skills').innerHTML = '<div class="loading">스킬 없음</div>';
      return;
    }
    document.getElementById('nanoclaw-skills').innerHTML = `<div class="skills-list">${skills.map(s => `
      <div class="skill-card">
        <div class="name">${escapeHtml(s.title || s.name)}</div>
        <div class="desc">${escapeHtml(s.description)}</div>
        ${s.files && s.files.length ? `<div class="subtle" style="margin-top:6px;font-size:11px">파일: ${s.files.map(f => `<code>${escapeHtml(f)}</code>`).join(' ')}</div>` : ''}
        ${s.triggers && s.triggers.length ? `<div class="triggers">${s.triggers.map(t => `<span class="trigger">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
      </div>
    `).join('')}</div>`;
  } catch (e) {
    document.getElementById('nanoclaw-skills').innerHTML = `<div class="loading">에러: ${e.message}</div>`;
  }
}

// ===== Section 3: DB 통계 =====
async function loadOverview() {
  try {
    const data = await fetchJson('/api/stats/overview');
    const r = data.rows[0] || {};
    const n = (k) => parseInt(r[k]) || 0;

    const totalUsers = n('total_users');
    const newUsers7d = n('new_users_7d');
    const dauToday = n('dau_today');
    const dauYesterday = n('dau_yesterday');
    const wau = n('wau_7d');
    const mau = n('mau_30d');
    const totalHours = n('total_hours');
    const dauMauRatio = mau > 0 ? (dauToday / mau * 100).toFixed(1) : '0.0';

    const dauDelta = dauToday - dauYesterday;
    const dauSign = dauDelta > 0 ? '▲' : dauDelta < 0 ? '▼' : '=';

    const cards = [
      { label: '전체 유저', value: totalUsers.toLocaleString(), delta: `신규 7일 +${newUsers7d}`, positive: newUsers7d > 0 },
      { label: '오늘 활성 (DAU)', value: dauToday, delta: `${dauSign} ${Math.abs(dauDelta)} (어제 ${dauYesterday})`, positive: dauDelta >= 0 },
      { label: '주간 활성 (WAU)', value: wau, delta: `월간 ${mau}` },
      { label: 'DAU / MAU', value: `${dauMauRatio}%`, delta: parseFloat(dauMauRatio) >= 15 ? '양호 (≥15%)' : '개선 필요', positive: parseFloat(dauMauRatio) >= 15 },
      { label: '총 활동 시간', value: `${totalHours.toLocaleString()}h`, delta: `${n('total_sessions').toLocaleString()} 세션` },
    ];

    document.getElementById('overview').innerHTML = cards.map(c => `
      <div class="stat-card">
        <div class="value">${c.value}</div>
        <div class="label">${c.label}</div>
        ${c.delta ? `<div class="delta ${c.positive === true ? 'positive' : c.positive === false ? 'negative' : ''}">${escapeHtml(c.delta)}</div>` : ''}
      </div>
    `).join('');
  } catch (e) {
    document.getElementById('overview').innerHTML = `<div class="loading">에러: ${e.message}</div>`;
  }
}

async function loadGrowth() {
  try {
    const data = await fetchJson('/api/stats/growth');
    const sLabels = data.signups.rows.map(r => r.month);
    const sValues = data.signups.rows.map(r => parseInt(r.new_users));
    renderBarChart('chart-signups', sLabels, sValues, '신규 가입', false);
    const rLabels = data.retention.rows.map(r => r.cohort);
    const rValues = data.retention.rows.map(r => parseFloat(r.retention_pct));
    renderLineChart('chart-retention', rLabels, rValues, '유지율 (%)');
  } catch (e) {
    console.error('growth', e);
  }
}

async function loadHeatmap() {
  try {
    const data = await fetchJson('/api/stats/heatmap');
    const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
    let max = 0;
    for (const row of data.rows) {
      const d = parseInt(row.dow);
      const h = parseInt(row.hour);
      const c = parseInt(row.count);
      if (!isNaN(d) && !isNaN(h)) {
        grid[d][h] = c;
        if (c > max) max = c;
      }
    }

    const days = ['일', '월', '화', '수', '목', '금', '토'];
    let html = '<table class="heatmap-table"><thead><tr><th></th>';
    for (let h = 0; h < 24; h++) html += `<th>${h}</th>`;
    html += '</tr></thead><tbody>';
    for (let d = 0; d < 7; d++) {
      html += `<tr><th>${days[d]}</th>`;
      for (let h = 0; h < 24; h++) {
        const count = grid[d][h];
        const intensity = max > 0 ? count / max : 0;
        const alpha = intensity === 0 ? 0.04 : 0.15 + intensity * 0.85;
        const bg = `rgba(76, 175, 80, ${alpha.toFixed(2)})`;
        html += `<td title="${days[d]}요일 ${h}시: ${count}건" style="background:${bg}">${count || ''}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    document.getElementById('heatmap').innerHTML = html;
  } catch (e) {
    document.getElementById('heatmap').innerHTML = `<div class="loading">에러: ${e.message}</div>`;
  }
}

async function loadChurnRisk() {
  try {
    const data = await fetchJson('/api/stats/churn-risk');
    if (!data.rows.length) {
      document.getElementById('churn-risk').innerHTML = '<div class="loading">이탈 위험 유저 없음 🎉</div>';
      return;
    }
    const rows = data.rows.map(r => {
      const days = parseInt(r.days_inactive) || 0;
      const cls = days > 60 ? 'danger' : 'warning';
      return `
        <tr>
          <td><strong>${escapeHtml(r.nickname || 'unknown')}</strong></td>
          <td>${escapeHtml(r.dormitory || '-')}</td>
          <td>Lv.${escapeHtml(r.level || '-')}</td>
          <td>${escapeHtml(r.total_hours)}h</td>
          <td>${escapeHtml(r.last_seen || '-')}</td>
          <td class="${cls}">${days}일</td>
        </tr>
      `;
    }).join('');
    document.getElementById('churn-risk').innerHTML = `
      <table>
        <thead><tr><th>유저</th><th>기숙사</th><th>레벨</th><th>누적</th><th>마지막 활동</th><th>미활동</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  } catch (e) {
    document.getElementById('churn-risk').innerHTML = `<div class="loading">에러: ${e.message}</div>`;
  }
}

let rankingPeriod = 'all';
async function loadRanking() {
  try {
    const data = await fetchJson(`/api/stats/ranking?period=${rankingPeriod}`);
    const labels = data.rows.map(r => r.nickname || 'unknown');
    const values = data.rows.map(r => parseFloat(r.hours) || 0);
    renderBarChart('chart-ranking', labels, values, '활동 시간 (h)', true);
  } catch (e) {
    console.error('ranking', e);
  }
}
document.getElementById('ranking-period')?.addEventListener('click', (e) => {
  if (!e.target.classList.contains('period-btn')) return;
  document.querySelectorAll('#ranking-period .period-btn').forEach(b => b.classList.remove('active'));
  e.target.classList.add('active');
  rankingPeriod = e.target.dataset.period;
  loadRanking();
});

async function loadDormitory() {
  try {
    const data = await fetchJson('/api/stats/dormitory');
    const labels = data.rows.map(r => r.dormitory);
    const values = data.rows.map(r => parseInt(r.count));
    renderDoughnut('chart-dormitory', labels, values);
  } catch (e) {
    console.error('dormitory', e);
  }
}

async function loadStreaks() {
  try {
    const data = await fetchJson('/api/stats/streaks');
    const sorted = data.rows.slice().reverse();
    const labels = sorted.map(r => r.streak_date?.slice(5) || '');
    const values = sorted.map(r => parseInt(r.active_users));
    renderLineChart('chart-streaks', labels, values, '활성 유저 수');
  } catch (e) {
    console.error('streaks', e);
  }
}

let emojiPeriod = '30d';
async function loadEmoji() {
  try {
    const data = await fetchJson(`/api/stats/emoji?period=${emojiPeriod}`);
    const labels = data.rows.map(r => r.nickname || 'unknown');
    const values = data.rows.map(r => parseInt(r.total));
    renderBarChart('chart-emoji', labels, values, '사용 횟수', true);
  } catch (e) {
    console.error('emoji', e);
  }
}
document.getElementById('emoji-period')?.addEventListener('click', (e) => {
  if (!e.target.classList.contains('period-btn')) return;
  document.querySelectorAll('#emoji-period .period-btn').forEach(b => b.classList.remove('active'));
  e.target.classList.add('active');
  emojiPeriod = e.target.dataset.period;
  loadEmoji();
});

function renderBarChart(id, labels, values, label, horizontal) {
  const ctx = document.getElementById(id);
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label, data: values, backgroundColor: '#4caf50', borderRadius: 4 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: horizontal ? 'y' : 'x',
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#8b949e', autoSkip: false }, grid: { color: '#2d3544' } },
        y: { ticks: { color: '#8b949e', autoSkip: false }, grid: { color: '#2d3544' } },
      },
    },
  });
}

function renderDoughnut(id, labels, values) {
  const ctx = document.getElementById(id);
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data: values, backgroundColor: ['#4caf50', '#2196f3', '#ff9800', '#e91e63'] }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { color: '#e6edf3' } } } },
  });
}

function renderLineChart(id, labels, values, label) {
  const ctx = document.getElementById(id);
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [{ label, data: values, borderColor: '#4caf50', backgroundColor: 'rgba(76, 175, 80, 0.1)', tension: 0.3, fill: true }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#8b949e' }, grid: { color: '#2d3544' } },
        y: { ticks: { color: '#8b949e' }, grid: { color: '#2d3544' } },
      },
    },
  });
}

// ===== Section 4: 운영 문서 =====
async function loadSkills() {
  // 동일한 /api/skills를 ops 탭에서도 사용
  try {
    const data = await fetchJson('/api/skills');
    const el = document.getElementById('skills-index');
    if (!data.length) {
      el.innerHTML = '<div class="loading">스킬 없음</div>';
      return;
    }
    el.innerHTML = `<div class="skills-list">${data.map(s => `
      <div class="skill-card">
        <div class="name">${escapeHtml(s.title || s.name)}</div>
        <div class="desc">${escapeHtml(s.description)}</div>
        ${s.triggers && s.triggers.length ? `<div class="triggers">${s.triggers.map(t => `<span class="trigger">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
      </div>
    `).join('')}</div>`;
  } catch (e) {
    document.getElementById('skills-index').innerHTML = `<div class="loading">에러: ${e.message}</div>`;
  }
}

async function loadDocsTree() {
  try {
    const tree = await fetchJson('/api/docs/tree');
    document.getElementById('docs-tree').innerHTML = renderTree(tree);
  } catch (e) {
    document.getElementById('docs-tree').innerHTML = `<div class="loading">에러: ${e.message}</div>`;
  }
}

async function loadRecentDocs() {
  try {
    const data = await fetchJson('/api/docs/recent?limit=10');
    const el = document.getElementById('recent-docs');
    if (!data.length) {
      el.innerHTML = '<div class="loading">문서 없음</div>';
      return;
    }
    el.innerHTML = data.map(f => `
      <div class="item" data-path="${escapeHtml(f.path)}">
        <span class="path">${escapeHtml(f.path)}</span>
        <span class="time">${fmtRelTime(f.mtime)}</span>
      </div>
    `).join('');
  } catch (e) {
    document.getElementById('recent-docs').innerHTML = `<div class="loading">에러: ${e.message}</div>`;
  }
}

async function openDocInViewer(p) {
  const viewer = document.getElementById('docs-viewer');
  viewer.innerHTML = '<div class="loading">읽는 중...</div>';
  try {
    const data = await fetchJson(`/api/docs/read?path=${encodeURIComponent(p)}`);
    renderFileViewer(viewer, data);
    document.querySelector('.docs-browser')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    viewer.innerHTML = `<div class="loading">에러: ${e.message}</div>`;
  }
}

document.getElementById('recent-docs')?.addEventListener('click', (e) => {
  const item = e.target.closest('.item');
  if (!item) return;
  openDocInViewer(item.dataset.path);
});

async function doDocsSearch() {
  const input = document.getElementById('docs-search-input');
  const results = document.getElementById('docs-search-results');
  const q = input.value.trim();
  if (q.length < 2) {
    results.innerHTML = '<div class="search-summary">2자 이상 입력하세요</div>';
    return;
  }
  results.innerHTML = '<div class="search-summary">🔍 검색 중...</div>';
  try {
    const data = await fetchJson(`/api/docs/search?q=${encodeURIComponent(q)}`);
    if (data.count === 0) {
      results.innerHTML = `<div class="search-summary">'${escapeHtml(q)}' — 결과 없음</div>`;
      return;
    }
    const totalMatches = data.results.reduce((s, r) => s + r.total, 0);
    results.innerHTML = `
      <div class="search-summary">🔍 '${escapeHtml(q)}' — ${data.count}개 파일, 총 ${totalMatches}건 매치</div>
      ${data.results.map(r => `
        <div class="search-result" data-path="${escapeHtml(r.file)}">
          <div><span class="file">📄 ${escapeHtml(r.file)}</span><span class="match-count">${r.total}건</span></div>
          ${r.matches.slice(0, 3).map(m => `
            <div class="preview"><span class="line-num">${m.line}:</span>${escapeHtml(m.text)}</div>
          `).join('')}
        </div>
      `).join('')}
    `;
  } catch (e) {
    results.innerHTML = `<div class="search-summary">에러: ${e.message}</div>`;
  }
}

document.getElementById('docs-search-btn')?.addEventListener('click', doDocsSearch);
document.getElementById('docs-search-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doDocsSearch();
});
document.getElementById('docs-search-clear')?.addEventListener('click', () => {
  document.getElementById('docs-search-input').value = '';
  document.getElementById('docs-search-results').innerHTML = '';
});
document.getElementById('docs-search-results')?.addEventListener('click', (e) => {
  const result = e.target.closest('.search-result');
  if (!result) return;
  openDocInViewer(result.dataset.path);
});

document.getElementById('send-report-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('send-report-btn');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '📤 발송 중...';
  try {
    const res = await fetch('/api/send-report', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      btn.textContent = `✅ ${data.recipient}로 발송됨`;
      setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 4000);
    } else {
      btn.textContent = `❌ ${data.error}`;
      setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 5000);
    }
  } catch (e) {
    btn.textContent = `❌ ${e.message}`;
    setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 5000);
  }
});

document.getElementById('docs-tree')?.addEventListener('click', async (e) => {
  if (!e.target.classList.contains('file')) return;
  const p = e.target.dataset.path;
  document.querySelectorAll('#docs-tree li.selected').forEach(el => el.classList.remove('selected'));
  e.target.classList.add('selected');
  const viewer = document.getElementById('docs-viewer');
  viewer.innerHTML = '<div class="loading">읽는 중...</div>';
  try {
    const data = await fetchJson(`/api/docs/read?path=${encodeURIComponent(p)}`);
    renderFileViewer(viewer, data);
  } catch (e) {
    viewer.innerHTML = `<div class="loading">에러: ${e.message}</div>`;
  }
});

function renderFileViewer(viewer, data) {
  const header = `<div style="margin-bottom:12px"><strong>${escapeHtml(data.path)}</strong> <span style="color:var(--text-dim)">${fmtBytes(data.size)}</span></div><hr style="border-color:var(--border);margin-bottom:16px">`;
  if (data.html) {
    viewer.innerHTML = header + data.html;
  } else {
    viewer.innerHTML = header + `<pre><code>${escapeHtml(data.content)}</code></pre>`;
  }
}

// ===== Section 5: 그룹 폴더 브라우저 =====
async function loadFileTree() {
  try {
    const tree = await fetchJson('/api/files/tree');
    document.getElementById('file-tree').innerHTML = renderTree(tree);
  } catch (e) {
    document.getElementById('file-tree').innerHTML = `<div class="loading">에러: ${e.message}</div>`;
  }
}

function renderTree(items, depth = 0) {
  return `<ul>${items.map(item => {
    if (item.type === 'dir') {
      const openAttr = depth === 0 ? ' open' : '';
      const children = item.children ? renderTree(item.children, depth + 1) : '';
      return `<li class="dir-item">
        <details${openAttr}>
          <summary class="dir-summary">📁 ${escapeHtml(item.name)}</summary>
          ${children}
        </details>
      </li>`;
    } else {
      return `<li class="file" data-path="${escapeHtml(item.path)}">📄 ${escapeHtml(item.name)}</li>`;
    }
  }).join('')}</ul>`;
}

document.getElementById('file-tree')?.addEventListener('click', async (e) => {
  if (!e.target.classList.contains('file')) return;
  const p = e.target.dataset.path;
  document.querySelectorAll('#file-tree li.selected').forEach(el => el.classList.remove('selected'));
  e.target.classList.add('selected');
  const viewer = document.getElementById('file-viewer');
  viewer.innerHTML = '<div class="loading">읽는 중...</div>';
  try {
    const data = await fetchJson(`/api/files/read?path=${encodeURIComponent(p)}`);
    renderFileViewer(viewer, data);
  } catch (e) {
    viewer.innerHTML = `<div class="loading">에러: ${e.message}</div>`;
  }
});

// ===== Section 6: 시스템 =====
async function loadHost() {
  try {
    const data = await fetchJson('/api/system/host');
    document.getElementById('host-info').innerHTML = `
      <table>
        <tr><td>Uptime</td><td>${data.uptime}</td></tr>
        <tr><td>Load</td><td>${data.load}</td></tr>
        <tr><td>디스크</td><td>${data.disk.used} / ${data.disk.size} (${data.disk.percent})</td></tr>
        <tr><td>메모리</td><td>${data.memory.used}MB / ${data.memory.total}MB</td></tr>
      </table>
    `;
  } catch (e) {
    document.getElementById('host-info').innerHTML = `<div class="loading">에러: ${e.message}</div>`;
  }
}

async function loadPm2() {
  try {
    const data = await fetchJson('/api/system/pm2');
    const rows = data.map(p => `
      <tr>
        <td><strong>${escapeHtml(p.name)}</strong></td>
        <td class="${p.status === 'online' ? 'status-online' : 'status-stopped'}">${p.status}</td>
        <td>${fmtDuration(p.uptime)}</td>
        <td>${p.restarts}</td>
        <td>${fmtBytes(p.memory)}</td>
      </tr>
    `).join('');
    document.getElementById('pm2-list').innerHTML = `
      <table>
        <thead><tr><th>이름</th><th>상태</th><th>Uptime</th><th>재시작</th><th>메모리</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  } catch (e) {
    document.getElementById('pm2-list').innerHTML = `<div class="loading">에러: ${e.message}</div>`;
  }
}

async function loadGit() {
  try {
    const data = await fetchJson('/api/system/git');
    document.getElementById('git-info').innerHTML = `
      <div class="git-log">${data.recent.map(l => `<div>${escapeHtml(l)}</div>`).join('')}</div>
      <hr style="margin:12px 0; border-color:var(--border)">
      <div style="color:var(--text-dim); font-size:12px">작업 디렉토리: ${escapeHtml(data.status)}</div>
    `;
  } catch (e) {
    document.getElementById('git-info').innerHTML = `<div class="loading">에러: ${e.message}</div>`;
  }
}

// ===== 전체 새로고침 =====
async function loadAll() {
  const btn = document.getElementById('refresh-btn');
  btn.disabled = true;
  btn.textContent = '⏳ 불러오는 중...';
  await Promise.allSettled([
    // Section 1
    loadRecentWork(),
    loadLongMemory(),
    loadRecentMemory(),
    loadNanoclawService(),
    // Section 2 (NanoClaw)
    loadScheduledTasks(),
    loadRegisteredGroups(),
    loadNanoclawContainers(),
    loadRecentMessages(),
    loadNanoclawSkills(),
    // Section 3 (DB)
    loadOverview(),
    loadRanking(),
    loadDormitory(),
    loadStreaks(),
    loadEmoji(),
    loadGrowth(),
    loadHeatmap(),
    loadChurnRisk(),
    // Section 4 (docs)
    loadSkills(),
    loadDocsTree(),
    loadRecentDocs(),
    // Section 5 (files)
    loadFileTree(),
    // Section 6 (system)
    loadHost(),
    loadPm2(),
    loadGit(),
  ]);
  document.getElementById('last-updated').textContent = `최근 업데이트: ${new Date().toLocaleString('ko-KR')}`;
  btn.disabled = false;
  btn.textContent = '🔄 새로고침';
}

loadAll();
