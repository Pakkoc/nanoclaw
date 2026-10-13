#!/bin/bash
# memory-cleanup: 오래된 세션 덤프 파일 정리
#
# 파일명 규칙:
#   YYYY-MM-DD.md          → 업무일지 (보존, 절대 건드리지 않음)
#   YYYY-MM-DD-HHMM.md     → 세션 덤프 (N일 지나면 삭제)
#
# 세션 파일 (Claude SDK JSONL):
#   data/sessions/**/projects/-workspace-group/<uuid>.jsonl  → 90일 지나면 삭제
#   data/sessions/**/projects/-workspace-group/<uuid>/       → 대응 jsonl 없으면 함께 삭제
#   data/sessions/**/*.jsonl.bak                             → 90일 지나면 삭제

set -euo pipefail

MEMORY_DIR="${MEMORY_DIR:-/workspace/group/daily-memories}"
DAYS_OLD="${1:-7}"
SESSION_DAYS=90
DRY_RUN=""
if [ "${2:-}" = "--dry-run" ]; then
  DRY_RUN="yes"
fi

if [ ! -d "$MEMORY_DIR" ]; then
  echo "ERROR: $MEMORY_DIR 이 없습니다" >&2
  exit 1
fi

PATTERN='.*/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-[0-9][0-9][0-9][0-9]\.md$'

echo "memory-cleanup 실행"
echo "  대상 디렉토리: $MEMORY_DIR"
echo "  기준: ${DAYS_OLD}일 이상 경과"
[ -n "$DRY_RUN" ] && echo "  모드: DRY RUN (실제 삭제 안 함)"
echo ""

# ── 1. 세션 덤프 MD 파일 정리 ─────────────────────────────────────

TOTAL=$(find "$MEMORY_DIR" -type f -regex "$PATTERN" 2>/dev/null | wc -l)
TARGETS=$(find "$MEMORY_DIR" -type f -regex "$PATTERN" -mtime +${DAYS_OLD} 2>/dev/null | wc -l)

echo "현재 세션 덤프 총: ${TOTAL}개"
echo "삭제 대상: ${TARGETS}개"
echo ""

DELETED=0
if [ "$TARGETS" -gt 0 ]; then
  while IFS= read -r f; do
    if [ -n "$DRY_RUN" ]; then
      echo "[DRY] 삭제 예정: $f"
    else
      rm -f "$f"
      echo "삭제: $f"
    fi
    DELETED=$((DELETED + 1))
  done < <(find "$MEMORY_DIR" -type f -regex "$PATTERN" -mtime +${DAYS_OLD} 2>/dev/null)
fi

if [ "$DELETED" -eq 0 ] && [ "$TARGETS" -eq 0 ]; then
  echo "정리할 파일 없음"
fi

# ── 2. Claude SDK 세션 JSONL 파일 정리 (90일 기준) ─────────────────

SESSION_BASE="/workspace/project/data/sessions"
SESSION_DELETED=0

if [ -d "$SESSION_BASE" ]; then
  echo ""
  echo "세션 JSONL 정리 (${SESSION_DAYS}일 이상 경과)"

  # 90일 이상 된 .jsonl 파일 삭제 + 대응 UUID 폴더 삭제
  while IFS= read -r jf; do
    uuid_dir="${jf%.jsonl}"
    if [ -n "$DRY_RUN" ]; then
      echo "[DRY] 삭제 예정: $jf"
      [ -d "$uuid_dir" ] && echo "[DRY] 삭제 예정: $uuid_dir/"
    else
      rm -f "$jf"
      [ -d "$uuid_dir" ] && rm -rf "$uuid_dir"
      echo "삭제: $jf"
    fi
    SESSION_DELETED=$((SESSION_DELETED + 1))
  done < <(find "$SESSION_BASE" -name "*.jsonl" -mtime +${SESSION_DAYS} 2>/dev/null)

  # jsonl 없이 남은 오래된 UUID 폴더 삭제
  # (uuid 패턴: 8-4-4-4-12 hex)
  UUID_PATTERN='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  while IFS= read -r proj_dir; do
    while IFS= read -r uuid_dir; do
      uuid=$(basename "$uuid_dir")
      if echo "$uuid" | grep -qE "$UUID_PATTERN"; then
        if [ ! -f "${uuid_dir}.jsonl" ] && [ "$(find "$uuid_dir" -mtime -${SESSION_DAYS} 2>/dev/null | wc -l)" -eq 0 ]; then
          if [ -n "$DRY_RUN" ]; then
            echo "[DRY] 삭제 예정 (고아 폴더): $uuid_dir/"
          else
            rm -rf "$uuid_dir"
            echo "삭제 (고아 폴더): $uuid_dir/"
          fi
          SESSION_DELETED=$((SESSION_DELETED + 1))
        fi
      fi
    done < <(find "$proj_dir" -maxdepth 1 -mindepth 1 -type d 2>/dev/null)
  done < <(find "$SESSION_BASE" -type d -name "-workspace-group" 2>/dev/null)

  # .jsonl.bak 파일 정리 (90일 이상)
  while IFS= read -r bak; do
    if [ -n "$DRY_RUN" ]; then
      echo "[DRY] 삭제 예정: $bak"
    else
      rm -f "$bak"
      echo "삭제: $bak"
    fi
    SESSION_DELETED=$((SESSION_DELETED + 1))
  done < <(find "$SESSION_BASE" -name "*.jsonl.bak" -mtime +${SESSION_DAYS} 2>/dev/null)

  if [ "$SESSION_DELETED" -eq 0 ]; then
    echo "  정리할 세션 파일 없음"
  fi
fi

echo ""
if [ -n "$DRY_RUN" ]; then
  echo "DRY RUN 완료: MD ${DELETED}개 + 세션 ${SESSION_DELETED}개 삭제 예정"
else
  echo "완료: MD ${DELETED}개 삭제 / 세션 ${SESSION_DELETED}개 삭제"
fi
