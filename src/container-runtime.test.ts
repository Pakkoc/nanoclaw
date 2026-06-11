import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process — store the mock fns so tests can configure them
const mockExecSync = vi.fn();
const mockExecFileSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

import {
  CONTAINER_RUNTIME_BIN,
  INSTANCE_ID,
  INSTANCE_LABEL_KEY,
  instanceLabelArgs,
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });
});

describe('instanceLabelArgs', () => {
  it('stamps containers with this install identity', () => {
    expect(instanceLabelArgs()).toEqual([
      '--label',
      `${INSTANCE_LABEL_KEY}=${INSTANCE_ID}`,
    ]);
    expect(INSTANCE_ID).toBe(process.cwd());
  });
});

describe('stopContainer', () => {
  it('calls docker stop for valid container names', () => {
    stopContainer('nanoclaw-test-123');
    expect(mockExecFileSync).toHaveBeenCalledWith(
      CONTAINER_RUNTIME_BIN,
      ['stop', '-t', '1', 'nanoclaw-test-123'],
      { stdio: 'pipe' },
    );
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow(
      'Invalid container name',
    );
    expect(() => stopContainer('foo$(whoami)')).toThrow(
      'Invalid container name',
    );
    expect(() => stopContainer('foo`id`')).toThrow('Invalid container name');
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(logger.debug).toHaveBeenCalledWith(
      'Container runtime already running',
    );
  });

  it('throws when docker info fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow(
      'Container runtime is required but failed to start',
    );
    expect(logger.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('stops orphaned containers owned by this install', () => {
    // docker ps returns container names, one per line
    mockExecFileSync.mockReturnValueOnce(
      'nanoclaw-group1-111\nnanoclaw-group2-222\n',
    );
    // stop calls succeed
    mockExecFileSync.mockReturnValue('');

    cleanupOrphans();

    // ps + 2 stop calls
    expect(mockExecFileSync).toHaveBeenCalledTimes(3);
    // Regression guard: must filter by THIS install's ownership label, never
    // by the shared "nanoclaw-" name prefix — a name filter lets one install
    // kill another install's live containers.
    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      1,
      CONTAINER_RUNTIME_BIN,
      [
        'ps',
        '--filter',
        `label=${INSTANCE_LABEL_KEY}=${INSTANCE_ID}`,
        '--format',
        '{{.Names}}',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      2,
      CONTAINER_RUNTIME_BIN,
      ['stop', '-t', '1', 'nanoclaw-group1-111'],
      { stdio: 'pipe' },
    );
    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      3,
      CONTAINER_RUNTIME_BIN,
      ['stop', '-t', '1', 'nanoclaw-group2-222'],
      { stdio: 'pipe' },
    );
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'] },
      'Stopped orphaned containers',
    );
  });

  it('does nothing when no orphans exist', () => {
    mockExecFileSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });

    cleanupOrphans(); // should not throw

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up orphaned containers',
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    mockExecFileSync.mockReturnValueOnce('nanoclaw-a-1\nnanoclaw-b-2\n');
    // First stop fails
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    // Second stop succeeds
    mockExecFileSync.mockReturnValueOnce('');

    cleanupOrphans(); // should not throw

    expect(mockExecFileSync).toHaveBeenCalledTimes(3);
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-a-1', 'nanoclaw-b-2'] },
      'Stopped orphaned containers',
    );
  });
});
