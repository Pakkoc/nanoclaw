#!/bin/bash
# nickname-sync.sh — 직군 역할과 닉네임 태그 불일치 멤버 자동 수정
# 수석/차석 특별 태그가 있는 멤버는 건드리지 않음

source /workspace/global/tools.env

GUILD_ID="1213133289498615818"
API_BASE="https://discord.com/api/v10"

declare -A ROLE_TAG=(
  [1231137889820348466]="직장인"
  [1231137947986690058]="취준생"
  [1214915849173864449]="대학원생"
  [1231137780587827280]="대학생"
  [1214226040982081617]="N수생"
  [1231137854927671359]="고등학생"
  [1213786818424606730]="중학생"
  [1216973850659524709]="독학법사"
)

changed=()
errors=()
after=""

while true; do
  URL="${API_BASE}/guilds/${GUILD_ID}/members?limit=1000"
  [ -n "$after" ] && URL="${URL}&after=${after}"

  MEMBERS=$(curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" -H "User-Agent: DiscordBot/1.0" "$URL")
  COUNT=$(echo "$MEMBERS" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo 0)
  [ "$COUNT" -eq 0 ] && break

  # 불일치 멤버 찾기
  CHANGES=$(echo "$MEMBERS" | python3 -c "
import json, sys, re

members = json.load(sys.stdin)

ROLE_TAG = {
  '1231137889820348466': '직장인',
  '1231137947986690058': '취준생',
  '1214915849173864449': '대학원생',
  '1231137780587827280': '대학생',
  '1214226040982081617': 'N수생',
  '1231137854927671359': '고등학생',
  '1213786818424606730': '중학생',
  '1216973850659524709': '독학법사',
}

SPECIAL_TAGS = ['수석', '차석']

for m in members:
  user = m.get('user', {})
  user_id = user.get('id', '')
  if user.get('bot'):
    continue

  roles = m.get('roles', [])
  matched_tag = None
  for r in roles:
    if r in ROLE_TAG:
      matched_tag = ROLE_TAG[r]
      break

  if not matched_tag:
    continue

  nick = m.get('nick') or user.get('global_name') or user.get('username') or ''

  # 수석/차석 태그 있으면 스킵
  if any(st in nick for st in SPECIAL_TAGS):
    continue

  tag_match = re.match(r'^\[([^\]]+)\]', nick)
  current_tag = tag_match.group(1) if tag_match else None

  if current_tag == matched_tag:
    continue

  if tag_match:
    new_nick = re.sub(r'^\[[^\]]+\]', f'[{matched_tag}]', nick)
  else:
    new_nick = f'[{matched_tag}] {nick}'

  print(f'{user_id}|{nick}|{new_nick}')
" 2>/dev/null)

  # 닉네임 변경 실행
  while IFS='|' read -r user_id old_nick new_nick; do
    [ -z "$user_id" ] && continue

    PAYLOAD=$(python3 -c "import json,sys; print(json.dumps({'nick': sys.argv[1]}))" "$new_nick")
    RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH \
      "${API_BASE}/guilds/${GUILD_ID}/members/${user_id}" \
      -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
      -H "Content-Type: application/json" \
      -H "User-Agent: DiscordBot/1.0" \
      -d "$PAYLOAD")

    if [ "$RESPONSE" = "200" ] || [ "$RESPONSE" = "204" ]; then
      changed+=("${old_nick} → ${new_nick}")
    else
      errors+=("${old_nick} (HTTP $RESPONSE)")
    fi

    sleep 0.3
  done <<< "$CHANGES"

  after=$(echo "$MEMBERS" | python3 -c "import json,sys; m=json.load(sys.stdin); print(m[-1]['user']['id']) if m else print('')" 2>/dev/null)
  [ "$COUNT" -lt 1000 ] && break
done

# JSON 결과 출력
python3 -c "
import json, sys

changed = sys.argv[1].split('|||') if sys.argv[1] else []
errors = sys.argv[2].split('|||') if sys.argv[2] else []

wake = len(changed) > 0 or len(errors) > 0
print(json.dumps({
  'wakeAgent': wake,
  'data': {
    'changed': changed,
    'errors': errors,
    'changed_count': len(changed),
    'error_count': len(errors)
  }
}))
" "$(IFS='|||'; echo "${changed[*]}")" "$(IFS='|||'; echo "${errors[*]}")"
