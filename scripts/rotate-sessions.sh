#!/bin/bash
# rotate-sessions.sh — NanoClaw 세션 jsonl 로테이션
#
# Claude Agent SDK가 세션을 resume 방식으로 계속 이어가기 때문에,
# 오염된 대화 맥락이나 거대해진 jsonl이 다음 컨테이너까지 전파된다.
# 이 스크립트는 크기·나이 임계값을 넘긴 세션을 _archive/로 이동시켜
# 다음 컨테이너 spawn 때 새 세션이 시작되도록 한다.
#
# 기본 스케줄: 매일 새벽 3시 crontab
#   0 3 * * * ~/nanoclaw/scripts/rotate-sessions.sh >> ~/nanoclaw/logs/rotate-sessions.log 2>&1

set -u

BASE="${NANOCLAW_ROOT:-$HOME/nanoclaw}/data/sessions"
ARCHIVE="$BASE/_archive"
THRESHOLD_MB="${ROTATE_THRESHOLD_MB:-2}"
AGE_DAYS="${ROTATE_AGE_DAYS:-3}"
ACTIVE_WINDOW_MIN="${ROTATE_ACTIVE_WINDOW_MIN:-15}"

[ -d "$BASE" ] || { echo "[$(date -Iseconds)] base not found: $BASE"; exit 0; }
mkdir -p "$ARCHIVE"

rotated=0
skipped=0

# 최근 ACTIVE_WINDOW_MIN 분 이내에 수정된 jsonl은 활성 세션으로 간주하고 건드리지 않음.
# _archive 하위와 이미 _archived_ prefix인 파일도 제외.
while IFS= read -r f; do
  base=$(basename "$f")
  [[ "$base" == _archived_* ]] && { skipped=$((skipped + 1)); continue; }

  rel="${f#$BASE/}"
  group=$(echo "$rel" | cut -d/ -f1)

  size_mb=$(du -m "$f" 2>/dev/null | cut -f1)
  age_days=$(( ( $(date +%s) - $(stat -c %Y "$f") ) / 86400 ))

  if [ "${size_mb:-0}" -ge "$THRESHOLD_MB" ] || [ "$age_days" -ge "$AGE_DAYS" ]; then
    ts=$(date +%Y%m%d_%H%M)
    dest="$ARCHIVE/${group}_${ts}_${base%.jsonl}.jsonl.bak"
    if mv "$f" "$dest"; then
      echo "[$(date -Iseconds)] archived: $f -> $dest (${size_mb}MB, ${age_days}d)"
      rotated=$((rotated + 1))
    fi
  else
    skipped=$((skipped + 1))
  fi
done < <(find "$BASE" -name "*.jsonl" -not -path "*/_archive/*" -mmin +"$ACTIVE_WINDOW_MIN" 2>/dev/null)

echo "[$(date -Iseconds)] done: rotated=$rotated skipped=$skipped threshold=${THRESHOLD_MB}MB age=${AGE_DAYS}d active_window=${ACTIVE_WINDOW_MIN}m"
