---
name: memory-cleanup
description: daily-memories 폴더의 오래된 세션 덤프 파일을 정리한다. 업무일지(YYYY-MM-DD.md)는 절대 삭제하지 않고, 세션 덤프(YYYY-MM-DD-HHMM.md)만 N일 지나면 삭제한다.
---

# Memory Cleanup — 오래된 세션 덤프 정리 스킬

`/workspace/group/daily-memories/`에 쌓이는 **오래된 세션 덤프 파일**을 주기적으로 정리한다.
**일일 업무일지는 절대 건드리지 않는다.**

## 파일 종류 구분

- **업무일지** (`YYYY-MM-DD.md`): 하트비트가 매일 생성하는 일일 요약. **영구 보존**.
- **세션 덤프** (`YYYY-MM-DD-HHMM.md`): 세션 종료 시 자동 생성되는 대화 요약. **N일 지나면 삭제 대상**.

## 트리거

관리자 채널에서 다음과 같은 요청이 오면:

- "메모리 정리"
- "세션 덤프 정리"
- "오래된 세션 파일 삭제"

또는 하트비트에서 매일 새벽에 주기적으로 호출된다.

## 사용법

```bash
# 기본: 7일 이상 된 세션 덤프 삭제
bash /home/node/.claude/skills/memory-cleanup/cleanup.sh

# 14일 기준
bash /home/node/.claude/skills/memory-cleanup/cleanup.sh 14

# dry-run
bash /home/node/.claude/skills/memory-cleanup/cleanup.sh 7 --dry-run
```

## 보존 규칙 (절대 원칙)

**절대 삭제하지 않음:**
- `YYYY-MM-DD.md` (일일 업무일지)
- `memories.md` (장기 기억)
- `/workspace/group/daily-memories/` 밖의 모든 파일

**삭제 대상:**
- `YYYY-MM-DD-HHMM.md` 패턴의 파일
- **mtime 기준**으로 N일 이상 경과한 것만 (기본 7일)

## 주의사항

1. **dry-run 먼저**: 처음 실행하거나 기준을 바꿀 때는 `--dry-run`으로 먼저 확인
2. **복구 불가**: `rm -f`로 즉시 삭제
3. **mtime 기반**: 최근 수정된 파일은 삭제되지 않음
