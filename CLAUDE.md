# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## ⚠️ Fork 전용 배포 정보 (개굴이 운영)

이 fork는 **Windows 개발 머신이 아닌 미니 PC에서 운영**된다. Windows는 코드 편집/커밋 전용, 실제 서비스는 미니 PC에서 돈다.

### 배포 타겟

- **호스트**: `ssh s980903@192.168.0.102` (Ubuntu 24.04, SSH 키 인증 설정됨)
- **리포 경로**: `~/nanoclaw` (미니 PC), `C:\dev\magicschool_discord\nanoclaw` (Windows)
- **Node**: 미니 PC는 **nvm Node 22** 전용 사용. `nvm alias default 22` 금지 (다른 PM2 봇들이 시스템 Node 18에 의존)
- **서비스**: `systemctl --user {start,stop,restart,status} nanoclaw` (systemd user, linger enabled)
- **컨테이너 런타임**: Docker 29.x (user가 docker 그룹 멤버, sudo 불필요)
- **크리덴셜**: OneCLI gateway (`http://172.17.0.1:10254`) + `groups/global/tools.env` (DB/Discord 토큰, git 제외)

### 봇 정체성 & 등록된 그룹

- **이름**: 개굴이 (말티즈 강아지 AI, 마법사관학교✦STUDY Discord 서버)
- **관리자 4명**: 성호(`364764044948799491`), 죨디(`459757901251346452`), 요나새(`276024344101257216`), 호녈(`1341276764827156555`)
- **`discord_main`** (is_main) — 🐸개굴이-업무전달 `dc:1489283292489449585`. 관리자 전용, 트리거 불필요
- **`discord_tickets`** (non-main, non-trigger) — 가상 JID `dc:tickets`. 카테고리 `1227530533567991881` 하위 `ticket-*` 채널 캐치올. 인바운드 프리픽스 `[ticket-channel:<id> #ticket-XXXX]`, 아웃바운드 프리픽스 `[reply-channel:<id>]` 필수 (`src/channels/discord.ts`에서 파싱)
- 운영 규칙은 각 그룹 폴더의 `CLAUDE.md`에 있다. 에이전트 동작을 바꾸려면 그쪽을 편집할 것
- 정체성은 `groups/global/soul.md`, 관리자 정보는 `groups/global/user-context.md`

### 커스텀 컨테이너 스킬 (OpenClaw에서 마이그레이션)

`container/skills/` 아래 3개. 컨테이너 내 `/home/node/.claude/skills/`로 싱크됨.

- **`db-query`** — 마법사관학교 Supabase read-only psql 쿼리. `_clean` VIEW만. `/workspace/global/tools.env`에서 `DB_URL_READONLY` 로드. `postgresql-client`가 Dockerfile에 포함됨
- **`diary-create`** — Discord API로 사용자 기숙사에 다이어리 채널 생성 (권한/멘션/완료 메시지까지). `DISCORD_BOT_TOKEN` 동일 경로. `python3`가 Dockerfile에 포함됨
- **`memory-cleanup`** — `/workspace/group/daily-memories/` 아래 7일 이상 된 세션 덤프(`YYYY-MM-DD-HHMM.md`) 삭제. 업무일지(`YYYY-MM-DD.md`)는 보존

### 등록된 스케줄 태스크 (`scheduled_tasks` 테이블, 미니 PC DB)

세 개 모두 `group_folder=discord_main`, `context_mode=group`, 타임존 Asia/Seoul:

- `migrated-monthly-ranking` — cron `0 9 1 * *` — 매월 1일 9시, 월간 랭킹을 공지 채널 `1231132864867860511`에 게시 (DB TOP10 공부시간 + TOP3 이모지)
- `migrated-heartbeat-daily-log` — cron `0 9 * * *` — 매일 9시 업무일지 작성 (`daily-memories/YYYY/MM/YYYY-MM-DD.md`)
- `migrated-heartbeat-memory-cleanup` — cron `0 3 * * *` — 매일 새벽 3시 memory-cleanup 실행

### 외부 의존 서비스 (NanoClaw 바깥)

- **`gaegul-dashboard`** (PM2) — `/home/s980903/openclaw/workspace/dashboard/server.js`. 09:30 node-cron으로 업무일지 이메일 발송 (Gmail SMTP → `REPORT_RECIPIENT`). `~/openclaw/workspace/memory/YYYY/MM/YYYY-MM-DD.md` 경로에서 파일을 읽는데, NanoClaw는 `~/nanoclaw/groups/discord_main/daily-memories/` 에 쓰므로 **경로 연결(심볼릭 링크 또는 dashboard 코드 변경)이 필요**. 아직 미해결 상태
- **다른 PM2 봇 11개** (`01-team-finder`, `02-fox-coin`, `03_bot`, `crypto-arb`, `discord-bot`, `gaegul-dashboard`, `lavalink`, `music-bot`, `ngrok-arb` 등) — 시스템 Node 18에 의존. **절대 건드리지 말 것**. Node 기본 버전 변경 금지
- **구 OpenClaw 설치**: `~/.openclaw` (에이전트 상태), `~/openclaw` (dashboard + 스킬 원본). 마이그레이션 검증 완료되면 정리 가능

### Git 워크플로우

```
Windows 편집 → git add → git commit → git push origin main
  ↓
ssh s980903@192.168.0.102 "cd ~/nanoclaw && git pull && npm run build"
  ↓
필요시: ./container/build.sh  (Dockerfile 또는 container/skills 변경 시)
  ↓
systemctl --user restart nanoclaw
```

- **origin** = `git@github.com:Pakkoc/nanoclaw.git` (fork, SSH, 양쪽 머신 모두 push 가능)
- **upstream** = `https://github.com/qwibitai/nanoclaw.git` (원본, fetch 전용)
- **discord** = `https://github.com/qwibitai/nanoclaw-discord.git` (Discord 채널 스킬 소스, 이미 머지됨)
- 미니 PC `~/.ssh/id_ed25519.pub`가 GitHub Pakkoc 계정에 등록되어 있어 양쪽 모두 push 가능

### Git에 절대 커밋하면 안 되는 것

`.gitignore`가 이미 방어하고 있지만 명시:

- `groups/global/tools.env` — DB URL, Discord 봇 토큰, Gmail 앱 비밀번호
- `.env`, `data/env/env` — 환경변수
- `groups/*/memories.md`, `groups/*/daily-memories/`, `groups/*/logs/` — 에이전트 런타임 메모리
- `store/`, `data/`, `dist/`, `node_modules/` — 런타임/빌드 산출물

새 머신에 clone하면 `.env` + `groups/global/tools.env`를 수동으로 만들거나 `/setup`을 다시 실행해야 한다.

### 새 세션에서 디버깅/로그를 볼 때

```bash
# 서비스 상태 + 최근 로그
ssh s980903@192.168.0.102 "systemctl --user status nanoclaw --no-pager && tail -50 ~/nanoclaw/logs/nanoclaw.log"

# 에러만
ssh s980903@192.168.0.102 "tail -50 ~/nanoclaw/logs/nanoclaw.error.log"

# 실행 중인 컨테이너
ssh s980903@192.168.0.102 "docker ps | grep nanoclaw"

# DB에서 등록된 그룹/태스크
ssh s980903@192.168.0.102 "cd ~/nanoclaw && node -e 'const db=require(\"better-sqlite3\")(\"store/messages.db\");console.log(db.prepare(\"SELECT jid,folder,requires_trigger,is_main FROM registered_groups\").all());db.close();'"
```

로컬 Read/Edit/Write 도구는 Windows 파일만 볼 수 있으므로 미니 PC 파일은 `ssh cat` 또는 `scp`로 가져와야 한다.

---


## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/` | Skills loaded inside agent containers (browser, status, formatting) |

## Secrets / Credentials / Proxy (OneCLI)

API keys, secret keys, OAuth tokens, and auth credentials are managed by the OneCLI gateway — which handles secret injection into containers at request time, so no keys or tokens are ever passed to containers directly. Run `onecli --help`.

## Skills

Four types of skills exist in NanoClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/init-onecli` | Install OneCLI Agent Vault and migrate `.env` credentials to it |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
