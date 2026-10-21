#!/usr/bin/env python3
"""티켓에서 운영진이 쓴 답변을 문맥과 함께 뽑는다 (서버 안내서 학습용).

discord_main 컨테이너에서 매일 학습 태스크가 실행한다.
  python3 extract-staff-replies.py            # 지난 실행 이후 대화 출력 (상태는 안 바꿈)
  python3 extract-staff-replies.py --commit T  # 처리 완료 표시: 다음 실행은 T 이후부터
"""
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timedelta, timezone

DB = os.environ.get("NANOCLAW_DB", "/workspace/project/store/messages.db")
STATE = os.environ.get(
    "GUIDE_LEARNING_STATE", "/workspace/group/guide-learning/state.json"
)

# 티켓 운영진 (src/channels/discord.ts TICKET_STAFF_IDS와 같게 유지)
STAFF = {
    "364764044948799491": "성호",
    "459757901251346452": "죨디",
    "276024344101257216": "요나새",
    "1341276764827156555": "호녈",
    "1397824633805475905": "초코슈",
    "845167421069590560": "운명교향곡",
    "537616840898248705": "나린",
}
CONTEXT_BEFORE = timedelta(days=3)
PREFIX = re.compile(r"\[ticket-channel:(\d+) (#ticket-\d+)\]\s*")
KST = timezone(timedelta(hours=9))


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def load_since(now):
    try:
        with open(STATE, encoding="utf-8") as f:
            return json.load(f)["last_ts"]
    except (OSError, KeyError, ValueError):
        return iso(now - timedelta(days=1))


def commit(ts):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE, "w", encoding="utf-8") as f:
        json.dump({"last_ts": ts}, f)
    print(f"OK last_ts={ts}")


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--commit":
        commit(sys.argv[2])
        return

    now = datetime.now(timezone.utc)
    since, until = load_since(now), iso(now)
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    ph = ",".join("?" * len(STAFF))
    staff_rows = db.execute(
        f"SELECT content, timestamp FROM messages WHERE chat_jid='dc:tickets' "
        f"AND sender IN ({ph}) AND timestamp > ? AND timestamp <= ? "
        f"ORDER BY timestamp",
        (*STAFF, since, until),
    ).fetchall()

    first_in_window = {}
    for content, ts in staff_rows:
        m = PREFIX.search(content)
        if m and m.group(1) not in first_in_window:
            first_in_window[m.group(1)] = ts

    print(f"WINDOW_START={since}")
    print(f"WINDOW_END={until}")
    print(f"STAFF_MESSAGES={len(staff_rows)} TICKETS={len(first_in_window)}")

    for channel_id, first_ts in first_in_window.items():
        start = iso(
            datetime.fromisoformat(first_ts.replace("Z", "+00:00")) - CONTEXT_BEFORE
        )
        rows = db.execute(
            "SELECT sender, is_from_me, content, timestamp, reply_to_message_content "
            "FROM messages "
            "WHERE chat_jid='dc:tickets' AND content LIKE ? "
            "AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp",
            (f"%[ticket-channel:{channel_id} %", start, until),
        ).fetchall()
        name = PREFIX.search(rows[0][2]).group(2) if rows else channel_id
        print(f"\n=== {name} ===")
        for sender, from_me, content, ts, quoted in rows:
            if sender in STAFF:
                who = f"운영진({STAFF[sender]})"
                mark = "★" if since < ts <= until else " "
            elif from_me:
                who, mark = "부엉이", " "
            else:
                who, mark = "회원", " "
            when = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(KST)
            text = PREFIX.sub("", content).strip()
            text = re.sub(r"^\[Reply to (?:[^\[\]]|\[[^\]]*\])*\]\s*", "", text)
            if quoted:
                text = f"(답장 대상: {quoted.strip()[:200]}) {text}"
            text = text.replace("\n", " / ")
            print(f"{mark} [{when:%m-%d %H:%M}] {who}: {text[:600]}")


if __name__ == "__main__":
    main()
