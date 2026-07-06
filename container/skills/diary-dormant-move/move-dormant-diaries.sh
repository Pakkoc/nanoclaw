#!/bin/bash
# move-dormant-diaries.sh — 휴면 다이어리 이동 스크립트
# NanoClaw 스케줄 태스크의 script로 실행
# 출력: {"wakeAgent": true, "data": {...}} 또는 {"wakeAgent": false}

TOOLS_ENV="/workspace/global/tools.env"
if [ -z "${DISCORD_BOT_TOKEN:-}" ] && [ -f "$TOOLS_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$TOOLS_ENV"
  set +a
fi

if [ -z "${DISCORD_BOT_TOKEN:-}" ]; then
  echo '{"wakeAgent": false, "error": "DISCORD_BOT_TOKEN not found"}' >&2
  exit 1
fi

python3 << PYEOF
import os, json, time, sys
from urllib.request import urlopen, Request
from urllib.error import HTTPError

GUILD_ID = "1213133289498615818"
API_BASE = "https://discord.com/api/v10"
TOKEN = os.environ["DISCORD_BOT_TOKEN"]

# 기숙사 카테고리 (채널 소스)
DORM_CATEGORIES = {
    "1236979261529657426": "소용돌이",
    "1236979345529114664": "노블레빗",
    "1236979439879848028": "볼리베어",
    "1386697214910529687": "펭도리야",
}

# 휴면 카테고리 (이동 목적지) — 순서대로 빈 자리 채움
DORMANT_CATEGORIES = [
    "1231241329384620134",  # ~휴면 다이어리 1~
    "1354671983664828549",  # ~휴면 다이어리 2~
    "1422467951109345300",  # ~휴면 다이어리 3~
    "1476394387784077405",  # ~휴면 다이어리 4~
    "1522048332967575712",  # ~휴면 다이어리 5~
]

# 6개월 기준 (180일)
SIX_MONTHS_MS = 180 * 24 * 60 * 60 * 1000
now_ms = int(time.time() * 1000)
cutoff_ms = now_ms - SIX_MONTHS_MS


def api_get(path):
    req = Request(f"{API_BASE}{path}", headers={
        "Authorization": f"Bot {TOKEN}",
        "User-Agent": "DiscordBot (https://nanoclaw.ai, 1.0)"
    })
    try:
        with urlopen(req) as r:
            return json.loads(r.read())
    except HTTPError as e:
        return json.loads(e.read())


def api_patch(path, data):
    body = json.dumps(data).encode()
    req = Request(f"{API_BASE}{path}", data=body, method="PATCH", headers={
        "Authorization": f"Bot {TOKEN}",
        "Content-Type": "application/json",
        "User-Agent": "DiscordBot (https://nanoclaw.ai, 1.0)"
    })
    try:
        with urlopen(req) as r:
            return json.loads(r.read())
    except HTTPError as e:
        return json.loads(e.read())


def api_post(path, data):
    body = json.dumps(data).encode()
    req = Request(f"{API_BASE}{path}", data=body, method="POST", headers={
        "Authorization": f"Bot {TOKEN}",
        "Content-Type": "application/json",
        "User-Agent": "DiscordBot (https://nanoclaw.ai, 1.0)"
    })
    try:
        with urlopen(req) as r:
            return json.loads(r.read())
    except HTTPError as e:
        return json.loads(e.read())


def snowflake_to_ms(snowflake_id):
    return (int(snowflake_id) >> 22) + 1420070400000


def get_owner_from_first_message(channel_id):
    """첫 메시지의 멘션된 유저 ID를 소유자로 반환. 없으면 None."""
    try:
        msgs = api_get(f"/channels/{channel_id}/messages?limit=1&after=0")
        if isinstance(msgs, list) and msgs:
            mentions = msgs[0].get("mentions", [])
            if mentions:
                return mentions[0].get("id")
    except Exception:
        pass
    return None


# ─── 1. 서버 전체 채널 조회 ─────────────────────────────────────────────
all_channels = api_get(f"/guilds/{GUILD_ID}/channels")
if not isinstance(all_channels, list):
    print(json.dumps({"wakeAgent": False, "error": "채널 조회 실패"}))
    sys.exit(0)

# ─── 2. 서버 멤버 전체 조회 (페이지네이션) ─────────────────────────────
members = set()
after = "0"
while True:
    batch = api_get(f"/guilds/{GUILD_ID}/members?limit=1000&after={after}")
    if not isinstance(batch, list) or not batch:
        break
    for m in batch:
        uid = (m.get("user") or {}).get("id")
        if uid:
            members.add(uid)
    if len(batch) < 1000:
        break
    after = batch[-1].get("user", {}).get("id", "0")
    time.sleep(0.5)

# ─── 3. 휴면 카테고리별 현재 채널 수 ───────────────────────────────────
dormant_counts = {}
for c in all_channels:
    pid = c.get("parent_id")
    if pid in DORMANT_CATEGORIES:
        dormant_counts[pid] = dormant_counts.get(pid, 0) + 1

# 신규 생성된 카테고리 (동적 추가)
created_categories = []


def get_dormant_target():
    """여유 있는 휴면 카테고리 ID 반환. 없으면 None."""
    for cat_id in DORMANT_CATEGORIES + created_categories:
        if dormant_counts.get(cat_id, 0) < 50:
            return cat_id
    return None


def create_new_dormant_category():
    """새 ~휴면 다이어리 N~ 카테고리 생성"""
    num = len(DORMANT_CATEGORIES) + len(created_categories) + 1
    result = api_post(f"/guilds/{GUILD_ID}/channels", {
        "name": f"~휴면 다이어리 {num}~",
        "type": 4
    })
    if result.get("id"):
        new_id = result["id"]
        created_categories.append(new_id)
        dormant_counts[new_id] = 0
        return new_id
    return None


# ─── 4. 이동 대상 수집 ──────────────────────────────────────────────────
to_move = []
for c in all_channels:
    if c.get("type") != 0:  # 텍스트 채널만
        continue
    if c.get("parent_id") not in DORM_CATEGORIES:
        continue

    channel_id = c["id"]
    reason = None
    owner_id = None

    # type=1(사용자) 오버라이드 찾기
    for p in c.get("permission_overwrites", []):
        if p.get("type") == 1:
            owner_id = p["id"]
            break

    # type=1 없으면 첫 메시지 멘션으로 소유자 파악
    # (Discord는 서버 탈퇴 시 type=1 오버라이드를 자동 삭제함)
    if not owner_id:
        owner_id = get_owner_from_first_message(channel_id)
        if owner_id:
            time.sleep(0.2)  # API rate limit 방지

    # 조건 2: 탈퇴 멤버
    if owner_id and owner_id not in members:
        reason = f"탈퇴 멤버 (user_id={owner_id})"

    # 조건 1: 6개월 비활성 (탈퇴 멤버가 아닌 채널만)
    if reason is None:
        last_msg_id = c.get("last_message_id")
        if last_msg_id:
            if snowflake_to_ms(last_msg_id) < cutoff_ms:
                reason = "6개월 비활성"
        else:
            # 한 번도 메시지 없음 → 채널 생성일 기준
            if snowflake_to_ms(channel_id) < cutoff_ms:
                reason = "메시지 없음 (6개월 이상)"

    if reason:
        to_move.append({
            "id": channel_id,
            "name": c.get("name", ""),
            "reason": reason,
            "owner_id": owner_id,
            "dorm": DORM_CATEGORIES.get(c.get("parent_id"), "?"),
        })

if not to_move:
    print(json.dumps({"wakeAgent": False}))
    sys.exit(0)

# ─── 5. 이동 실행 ───────────────────────────────────────────────────────
moved = []
errors = []

for ch in to_move:
    target = get_dormant_target()
    if target is None:
        target = create_new_dormant_category()
    if target is None:
        errors.append({"id": ch["id"], "name": ch["name"], "error": "카테고리 생성 실패"})
        continue

    result = api_patch(f"/channels/{ch['id']}", {"parent_id": target})
    if result.get("id"):
        moved.append({
            "id": ch["id"],
            "name": ch["name"],
            "reason": ch["reason"],
            "from_dorm": ch["dorm"],
        })
        dormant_counts[target] = dormant_counts.get(target, 0) + 1
    else:
        errors.append({
            "id": ch["id"],
            "name": ch["name"],
            "error": str(result)[:150]
        })
    time.sleep(0.3)

print(json.dumps({
    "wakeAgent": True,
    "data": {
        "moved": moved,
        "errors": errors,
        "new_categories": created_categories
    }
}))
PYEOF
