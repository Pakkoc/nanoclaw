import { beforeEach, describe, expect, it } from 'vitest';

import {
  HelpdeskConfig,
  _resetHelpdeskState,
  checkHelpdeskCaps,
  classifyHelpdeskText,
  looksResolved,
  recordHelpdeskWake,
} from './helpdesk.js';

const config: HelpdeskConfig = {
  enabled: true,
  chatChannelIds: ['1'],
  forumChannelIds: ['2'],
  delaySeconds: 180,
  dailyWakeLimit: 2,
  userCooldownMinutes: 30,
  minLength: 6,
  maxLength: 600,
  topicKeywords: ['다이어리', '기숙사', '레벨'],
  questionPatterns: ['\\?', '나요', '어떻게'],
  excludePatterns: ['^ㅋ+$'],
  skipRepliesToOthers: true,
  skipIfMentionsOthers: true,
  contextBefore: 5,
  contextAfter: 10,
  resolvedPatterns: ['해결', '감사'],
};

describe('classifyHelpdeskText', () => {
  it('passes a topic question', () => {
    const r = classifyHelpdeskText('다이어리 어떻게 만들어요', 'chat', config);
    expect(r).toEqual({ pass: true, keyword: '다이어리', reason: 'candidate' });
  });

  it('drops chat without a topic keyword', () => {
    expect(
      classifyHelpdeskText('오늘 점심 뭐 먹나요?', 'chat', config),
    ).toEqual({
      pass: false,
      reason: 'no-keyword',
    });
  });

  it('drops topic chat that is not a question', () => {
    const r = classifyHelpdeskText('기숙사 너무 좋다 진짜', 'chat', config);
    expect(r.reason).toBe('not-question');
    expect(r.keyword).toBe('기숙사');
  });

  it('exempts forum starters from the question check', () => {
    const r = classifyHelpdeskText(
      '레벨 관련 문의\n레벨이 안 올라감',
      'forum-starter',
      config,
    );
    expect(r.pass).toBe(true);
  });

  it('keyword match is case-insensitive', () => {
    const c = { ...config, topicKeywords: ['XP'] };
    expect(classifyHelpdeskText('xp는 어떻게 오르나요', 'chat', c).pass).toBe(
      true,
    );
  });

  it('enforces length bounds', () => {
    expect(classifyHelpdeskText('레벨?', 'chat', config).reason).toBe(
      'too-short',
    );
    const long = '레벨?' + 'ㄱ'.repeat(700);
    expect(classifyHelpdeskText(long, 'chat', config).reason).toBe('too-long');
  });

  it('ignores invalid regex sources', () => {
    const c = { ...config, questionPatterns: ['(', '\\?'] };
    expect(classifyHelpdeskText('다이어리 신청은?', 'chat', c).pass).toBe(true);
  });
});

describe('looksResolved', () => {
  it('matches resolved phrases', () => {
    expect(looksResolved('아 찾았다 감사합니다', config)).toBe(true);
    expect(looksResolved('아직 모르겠어요', config)).toBe(false);
  });
});

describe('caps', () => {
  beforeEach(() => _resetHelpdeskState());

  it('applies per-user cooldown', () => {
    const t = Date.parse('2026-10-27T03:00:00Z');
    expect(checkHelpdeskCaps('u1', config, t)).toBeNull();
    recordHelpdeskWake('u1', t);
    expect(checkHelpdeskCaps('u1', config, t + 10 * 60_000)).toBe(
      'user-cooldown',
    );
    expect(checkHelpdeskCaps('u1', config, t + 31 * 60_000)).toBeNull();
    expect(checkHelpdeskCaps('u2', config, t)).toBeNull();
  });

  it('applies the daily limit and resets the next day', () => {
    const t = Date.parse('2026-10-27T03:00:00Z');
    recordHelpdeskWake('u1', t);
    recordHelpdeskWake('u2', t);
    expect(checkHelpdeskCaps('u3', config, t)).toBe('daily-limit');
    expect(checkHelpdeskCaps('u3', config, t + 24 * 3600_000)).toBeNull();
  });
});
