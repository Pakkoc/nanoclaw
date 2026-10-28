import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { processPm2RestartFlag, siblingBotMounts } from './sibling-bots.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sibling-bots-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('siblingBotMounts', () => {
  it('mounts every sibling folder read-write, skipping NanoClaw itself', () => {
    for (const d of ['nanoclaw', 'musi_bot', 'studycard', '.hidden']) {
      fs.mkdirSync(path.join(tmp, d));
    }
    fs.writeFileSync(path.join(tmp, 'notes.txt'), '');

    const mounts = siblingBotMounts(tmp, path.join(tmp, 'nanoclaw'));

    expect(mounts.map((m) => m.containerPath).sort()).toEqual([
      '/workspace/discord-bot/musi_bot',
      '/workspace/discord-bot/studycard',
    ]);
    expect(mounts.every((m) => m.readonly === false)).toBe(true);
  });

  it('returns nothing when BOTS_ROOT is unset or missing', () => {
    expect(siblingBotMounts('', tmp)).toEqual([]);
    expect(siblingBotMounts(path.join(tmp, 'nope'), tmp)).toEqual([]);
  });
});

describe('processPm2RestartFlag', () => {
  const flag = () => path.join(tmp, 'pm2-restart.flag');

  it('does nothing without a flag', () => {
    const restart = vi.fn();
    expect(processPm2RestartFlag(tmp, ['music-bot'], restart)).toBeNull();
    expect(restart).not.toHaveBeenCalled();
  });

  it('restarts an allowlisted app and removes the flag', () => {
    fs.writeFileSync(flag(), 'music-bot\n');
    const restart = vi.fn(() => '');
    const out = processPm2RestartFlag(tmp, ['music-bot'], restart);
    expect(restart).toHaveBeenCalledWith('music-bot');
    expect(out).toMatch(/^OK music-bot/);
    expect(fs.existsSync(flag())).toBe(false);
    expect(fs.readFileSync(path.join(tmp, 'pm2-restart.log'), 'utf-8')).toMatch(
      /OK music-bot/,
    );
  });

  it('refuses apps outside the allowlist', () => {
    fs.writeFileSync(flag(), '01-team-finder');
    const restart = vi.fn();
    expect(processPm2RestartFlag(tmp, ['music-bot'], restart)).toMatch(
      /^REFUSED/,
    );
    expect(restart).not.toHaveBeenCalled();
    expect(fs.existsSync(flag())).toBe(false);
  });

  it('logs a failed restart without throwing', () => {
    fs.writeFileSync(flag(), 'music-bot');
    const restart = vi.fn(() => {
      throw new Error('pm2 not found');
    });
    expect(processPm2RestartFlag(tmp, ['music-bot'], restart)).toMatch(
      /^FAIL music-bot — pm2 not found/,
    );
  });
});
