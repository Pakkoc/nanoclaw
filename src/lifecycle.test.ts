import { describe, it, expect, beforeEach } from 'vitest';

import { folderStillRegistered, _setRegisteredGroups } from './index.js';
import { RegisteredGroup } from './types.js';

// Reset the in-memory registry before each test so cases don't leak state.
beforeEach(() => {
  _setRegisteredGroups({});
});

// Helper to build a minimal RegisteredGroup pointing at a folder.
function group(name: string, folder: string): RegisteredGroup {
  return {
    name,
    folder,
    trigger: '@Andy',
    added_at: '2024-01-01T00:00:00.000Z',
  };
}

// --- folderStillRegistered (deregisterGroup folder ref-count guard) ---

describe('folderStillRegistered', () => {
  it('returns false when no groups are registered', () => {
    expect(folderStillRegistered('diaries/discord_diary_chP')).toBe(false);
  });

  // Case A: shared diary folder — parent channel + two threads all point at the
  // same folder. Removing one thread (dc:T1) must NOT report the folder as free,
  // because surviving siblings still use it (folder state must be preserved).
  it('keeps a shared diary folder alive while a sibling survives', () => {
    const folder = 'diaries/discord_diary_chP';
    _setRegisteredGroups({
      'dc:P': group('diary parent', folder),
      'dc:T1': group('diary thread 1', folder),
      'dc:T2': group('diary thread 2', folder),
    });

    // Sanity: all three siblings share the folder.
    expect(folderStillRegistered(folder)).toBe(true);

    // Deregister one thread (delete the jid, then push the updated map).
    const remaining: Record<string, RegisteredGroup> = {
      'dc:P': group('diary parent', folder),
      'dc:T1': group('diary thread 1', folder),
      'dc:T2': group('diary thread 2', folder),
    };
    delete remaining['dc:T1'];
    _setRegisteredGroups(remaining);

    // Folder must still be considered in use — siblings dc:P and dc:T2 remain.
    expect(folderStillRegistered(folder)).toBe(true);
  });

  // Case B: last sibling gone — once every jid sharing the diary folder is
  // removed, the folder is finally reported as free so it can be cleaned up.
  it('reports the diary folder free once the last sibling is removed', () => {
    const folder = 'diaries/discord_diary_chP';
    // Empty map (all siblings removed).
    _setRegisteredGroups({});
    expect(folderStillRegistered(folder)).toBe(false);

    // A map containing only an unrelated folder should also report it free.
    _setRegisteredGroups({
      'dc:other': group('other', 'diaries/discord_diary_chOther'),
    });
    expect(folderStillRegistered(folder)).toBe(false);
  });

  // Case C: ticket channels are 1:1 (one jid per folder) — removing the single
  // jid always frees the folder, so tickets are always cleaned up.
  it('frees a 1:1 ticket folder once its single jid is removed', () => {
    const folder = 'discord_tickets_ch1';
    _setRegisteredGroups({
      'dc:1': group('ticket 1', folder),
    });
    expect(folderStillRegistered(folder)).toBe(true);

    // Remove the only jid using the folder.
    _setRegisteredGroups({});
    expect(folderStillRegistered(folder)).toBe(false);
  });
});
