#!/bin/bash
# memory-cleanup: 오래된 세션 덤프 파일 정리
#
# 파일명 규칙:
#   YYYY-MM-DD.md          → 업무일지 (보존, 절대 건드리지 않음)
#   YYYY-MM-DD-HHMM.md     → 세션 덤프 (N일 지나면 삭제)

set -euo pipefail

MEMORY_DIR="${MEMORY_DIR:-/workspace/group/daily-memories}"
DAYS_OLD="${1:-7}"
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

TOTAL=$(find "$MEMORY_DIR" -type f -regex "$PATTERN" 2>/dev/null | wc -l)
TARGETS=$(find "$MEMORY_DIR" -type f -regex "$PATTERN" -mtime +${DAYS_OLD} 2>/dev/null | wc -l)

echo "현재 세션 덤프 총: ${TOTAL}개"
echo "삭제 대상: ${TARGETS}개"
echo ""

if [ "$TARGETS" -eq 0 ]; then
  echo "정리할 파일 없음"
  exit 0
fi

DELETED=0
while IFS= read -r f; do
  if [ -n "$DRY_RUN" ]; then
    echo "[DRY] 삭제 예정: $f"
  else
    rm -f "$f"
    echo "삭제: $f"
  fi
  DELETED=$((DELETED + 1))
done < <(find "$MEMORY_DIR" -type f -regex "$PATTERN" -mtime +${DAYS_OLD} 2>/dev/null)

echo ""
if [ -n "$DRY_RUN" ]; then
  echo "DRY RUN 완료: ${DELETED}개 삭제 예정"
else
  echo "완료: ${DELETED}개 삭제, $((TOTAL - DELETED))개 보존"
fi
