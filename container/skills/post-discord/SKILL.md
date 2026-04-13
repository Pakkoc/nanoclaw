---
name: post-discord
description: Discord 봇 토큰으로 임의의 채널에 메시지를 게시한다. NanoClaw의 기본 채널 라우팅을 우회해서 다른 채널(공지 채널, 다른 카테고리 채널 등)에 직접 보낼 때 사용한다.
---

# Post Discord — 임의 채널에 직접 게시

NanoClaw는 에이전트의 응답을 현재 그룹의 채널로만 라우팅한다. 다른 채널(예: 공지 채널, 이벤트 채널)에 메시지를 보내려면 Discord API에 직접 호출해야 한다. 이 스킬이 그걸 처리한다.

## 트리거

- 관리자가 "X 채널에 공지해줘"
- 월간 랭킹 / 이벤트 알림 등 **현재 채널이 아닌 곳**에 메시지를 보내야 할 때
- 스케줄 태스크에서 다른 채널로 송신이 필요할 때

## 사용법

채널 ID를 인자로 주고, 본문을 stdin(보통 heredoc)으로 전달:

```bash
bash /home/node/.claude/skills/post-discord/post-discord.sh <CHANNEL_ID> <<'EOM'
공지 본문 첫 줄
공지 본문 둘째 줄
...
EOM
```

또는 한 줄 메시지를 인자로 직접:

```bash
echo "짧은 알림" | bash /home/node/.claude/skills/post-discord/post-discord.sh <CHANNEL_ID>
```

## 동작

1. `/workspace/global/tools.env`에서 `DISCORD_BOT_TOKEN` 로드
2. stdin의 본문을 python3로 JSON-escape (마크다운, 이모지, 멘션, 따옴표, 개행 모두 안전)
3. `POST https://discord.com/api/v10/channels/<CHANNEL_ID>/messages` 호출
4. 성공 시: 응답 JSON(message.id, channel_id 등) 출력
5. 실패 시: HTTP 코드와 에러 메시지 출력 후 exit 1

## 제약

- **2000자 제한**: Discord 메시지는 단일 메시지당 2000자 한도. 더 길면 사전에 분할해서 여러 번 호출
- **봇 권한**: 봇이 해당 채널의 SEND_MESSAGES 권한이 있어야 함
- **embed 미지원**: 이 스킬은 plain content 필드만 사용. 임베드/컴포넌트가 필요하면 별도 처리
- **rate limit**: Discord는 채널당 5메시지/5초 한도. 빠른 반복 호출 금지

## 환경

- `DISCORD_BOT_TOKEN`은 `groups/global/tools.env`에 저장돼 있음 (호스트 파일, 컨테이너 내 `/workspace/global/tools.env`로 마운트)
- `python3`, `curl`은 컨테이너 이미지에 이미 포함됨 (Dockerfile 참고)
