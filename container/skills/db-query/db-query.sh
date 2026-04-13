#!/bin/bash
# db-query.sh — 마법사관학교 Supabase DB read-only 쿼리 실행
# 사용법: bash db-query.sh "SELECT count(*) FROM users_clean"
# 또는:  bash db-query.sh < query.sql

set -euo pipefail

TOOLS_ENV="/workspace/global/tools.env"
if [ -f "$TOOLS_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$TOOLS_ENV"
  set +a
fi

if [ -z "${DB_URL_READONLY:-}" ]; then
  echo "ERROR: DB_URL_READONLY 환경변수가 설정되지 않았습니다 ($TOOLS_ENV 확인)" >&2
  exit 1
fi

if [ $# -gt 0 ]; then
  QUERY="$*"
else
  QUERY=$(cat)
fi

psql "$DB_URL_READONLY" \
  -P pager=off \
  -F " | " \
  -A \
  -c "$QUERY"
