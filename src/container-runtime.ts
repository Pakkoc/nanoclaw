/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execFileSync, execSync } from 'child_process';
import os from 'os';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/**
 * Per-install ownership label. cleanupOrphans must only ever claim containers
 * spawned by THIS install — all NanoClaw-family installs share the "nanoclaw-"
 * name prefix, so a name-based filter lets one install kill another install's
 * live containers (observed 2026-06-11: a crash-looping second install killed
 * every agent container of this one within seconds of spawn).
 */
export const INSTANCE_LABEL_KEY = 'nanoclaw.instance';
export const INSTANCE_ID = process.cwd();

/** CLI args that stamp a spawned container as owned by this install. */
export function instanceLabelArgs(): string[] {
  return ['--label', `${INSTANCE_LABEL_KEY}=${INSTANCE_ID}`];
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name. Uses execFileSync (no shell) to avoid injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execFileSync(CONTAINER_RUNTIME_BIN, ['stop', '-t', '1', name], {
    stdio: 'pipe',
  });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      '║  1. Ensure Docker is installed and running                     ║',
    );
    console.error(
      '║  2. Run: docker info                                           ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/**
 * Kill orphaned containers from previous runs of THIS install.
 * Filters by ownership label, never by name — a name filter would let one
 * install kill another install's live containers.
 *
 * Migration note: containers spawned before the label existed are never
 * claimed by this filter, and they do NOT time out on their own (idle/hard
 * timeouts are enforced host-side, and the host that spawned them is gone).
 * When deploying this change onto a host with live unlabeled containers,
 * stop them once manually while the old service is down:
 *   docker ps --filter name=nanoclaw- --format '{{.Names}}' | xargs -r docker stop -t 1
 */
export function cleanupOrphans(): void {
  try {
    const output = execFileSync(
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
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
