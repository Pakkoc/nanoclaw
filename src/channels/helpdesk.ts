/**
 * Helpdesk — answer server-usage questions in public channels (전체 채팅,
 * 자유질문 포럼) without waking an agent for every chat message.
 *
 * Pipeline (all host-side, no LLM until the last step):
 *   1. classifyHelpdeskText(): topic keyword + question form (free)
 *   2. caps: daily wake limit, per-user cooldown (free)
 *   3. wait delaySeconds, then skip if a human already answered (free)
 *   4. only then deliver the message to the discord_helpdesk group, whose
 *      agent decides from the server guide whether to answer.
 *
 * The filter config lives in groups/discord_helpdesk/filter.json and is
 * re-read whenever it changes, so tuning it needs no restart.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, TIMEZONE } from '../config.js';
import { logger } from '../logger.js';

export const HELPDESK_FOLDER = 'discord_helpdesk';

export interface HelpdeskConfig {
  enabled: boolean;
  chatChannelIds: string[];
  forumChannelIds: string[];
  /** Wait this long before checking whether a human already answered. */
  delaySeconds: number;
  /** Hard cap on agent wake-ups per day (KST). */
  dailyWakeLimit: number;
  /** Minimum minutes between two wake-ups for the same asker. */
  userCooldownMinutes: number;
  minLength: number;
  maxLength: number;
  /** Substring match, case-insensitive. At least one must appear. */
  topicKeywords: string[];
  /** Regex sources. At least one must match (forum starters are exempt). */
  questionPatterns: string[];
  /** Regex sources. Any match drops the message. */
  excludePatterns: string[];
  /** Drop chat messages that reply to another human (they are conversing). */
  skipRepliesToOthers: boolean;
  /** Drop chat messages that @mention another user. */
  skipIfMentionsOthers: boolean;
  /** Messages before/after the question passed to the agent as context. */
  contextBefore: number;
  contextAfter: number;
  /** Skip if the asker wrote something like this after asking. */
  resolvedPatterns: string[];
}

const DEFAULT_CONFIG: HelpdeskConfig = {
  enabled: false,
  chatChannelIds: [],
  forumChannelIds: [],
  delaySeconds: 180,
  dailyWakeLimit: 15,
  userCooldownMinutes: 30,
  minLength: 6,
  maxLength: 600,
  topicKeywords: [],
  questionPatterns: ['\\?'],
  excludePatterns: [],
  skipRepliesToOthers: true,
  skipIfMentionsOthers: true,
  contextBefore: 5,
  contextAfter: 10,
  resolvedPatterns: [],
};

const configPath = () => path.join(GROUPS_DIR, HELPDESK_FOLDER, 'filter.json');

let cached: { mtimeMs: number; config: HelpdeskConfig } | null = null;

/** Load filter.json, re-reading only when its mtime changes. */
export function loadHelpdeskConfig(): HelpdeskConfig {
  const file = configPath();
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return DEFAULT_CONFIG;
  }
  if (cached && cached.mtimeMs === mtimeMs) return cached.config;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const config = { ...DEFAULT_CONFIG, ...raw } as HelpdeskConfig;
    cached = { mtimeMs, config };
    logger.info({ file }, 'Helpdesk filter config loaded');
    return config;
  } catch (err) {
    // Keep the last good config if the file is mid-edit or invalid.
    logger.warn({ file, err }, 'Helpdesk filter config invalid');
    return cached?.config ?? DEFAULT_CONFIG;
  }
}

function compile(sources: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const src of sources) {
    try {
      out.push(new RegExp(src, 'i'));
    } catch {
      logger.warn({ src }, 'Helpdesk: bad regex in filter.json, ignored');
    }
  }
  return out;
}

export type HelpdeskKind = 'chat' | 'forum-starter' | 'forum-followup';

export interface ClassifyResult {
  pass: boolean;
  /** Matched topic keyword, if any. Used to decide whether to log. */
  keyword?: string;
  reason: string;
}

/** Stage 1: keyword + question form. Pure function, no I/O. */
export function classifyHelpdeskText(
  text: string,
  kind: HelpdeskKind,
  config: HelpdeskConfig,
): ClassifyResult {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const keyword = config.topicKeywords.find((k) =>
    lower.includes(k.toLowerCase()),
  );
  if (!keyword) return { pass: false, reason: 'no-keyword' };
  if (trimmed.length < config.minLength)
    return { pass: false, keyword, reason: 'too-short' };
  if (trimmed.length > config.maxLength)
    return { pass: false, keyword, reason: 'too-long' };
  if (compile(config.excludePatterns).some((re) => re.test(trimmed)))
    return { pass: false, keyword, reason: 'excluded' };
  if (
    kind !== 'forum-starter' &&
    !compile(config.questionPatterns).some((re) => re.test(trimmed))
  )
    return { pass: false, keyword, reason: 'not-question' };
  return { pass: true, keyword, reason: 'candidate' };
}

/** True if any resolvedPatterns matches (asker says it's solved). */
export function looksResolved(text: string, config: HelpdeskConfig): boolean {
  return compile(config.resolvedPatterns).some((re) => re.test(text));
}

// ── Stage 2: caps ─────────────────────────────────────────────────────────

let wakeDay = '';
let wakeCount = 0;
const lastWakeByUser = new Map<string, number>();

function kstDay(now = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

/** Returns a skip reason, or null if a wake-up is allowed right now. */
export function checkHelpdeskCaps(
  userId: string,
  config: HelpdeskConfig,
  now = Date.now(),
): string | null {
  const day = kstDay(new Date(now));
  if (day !== wakeDay) {
    wakeDay = day;
    wakeCount = 0;
  }
  if (wakeCount >= config.dailyWakeLimit) return 'daily-limit';
  const last = lastWakeByUser.get(userId);
  if (last && now - last < config.userCooldownMinutes * 60_000)
    return 'user-cooldown';
  return null;
}

export function recordHelpdeskWake(userId: string, now = Date.now()): void {
  const day = kstDay(new Date(now));
  if (day !== wakeDay) {
    wakeDay = day;
    wakeCount = 0;
  }
  wakeCount++;
  lastWakeByUser.set(userId, now);
}

/** Test hook. */
export function _resetHelpdeskState(): void {
  wakeDay = '';
  wakeCount = 0;
  lastWakeByUser.clear();
  cached = null;
}

// ── Log for the weekly review ─────────────────────────────────────────────

export interface HelpdeskLogEntry {
  stage: string;
  reason: string;
  kind: HelpdeskKind;
  channelId: string;
  messageId: string;
  authorId: string;
  keyword?: string;
  text?: string;
}

/**
 * Append one JSON line to groups/discord_helpdesk/logs/helpdesk-YYYY-MM.jsonl.
 * Only keyword-matched messages are logged, so ordinary chat never lands here.
 */
export function logHelpdesk(entry: HelpdeskLogEntry): void {
  try {
    const dir = path.join(GROUPS_DIR, HELPDESK_FOLDER, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const month = kstDay().slice(0, 7);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...entry,
      text: entry.text?.slice(0, 300),
    });
    fs.appendFileSync(path.join(dir, `helpdesk-${month}.jsonl`), line + '\n');
  } catch (err) {
    logger.warn({ err }, 'Helpdesk log write failed');
  }
}
