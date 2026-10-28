/**
 * Sibling bots — the other bots living next to NanoClaw under BOTS_ROOT
 * (e.g. ~/discord-bot/musi_bot). The main (admin) container can edit them,
 * and can ask the host to restart their PM2 process through a flag file,
 * the same way deploy.flag works for NanoClaw itself.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, BOTS_ROOT, RESTARTABLE_PM2_APPS } from './config.js';
import { logger } from './logger.js';

export const SIBLING_BOTS_CONTAINER_DIR = '/workspace/discord-bot';

/**
 * One read-write mount per subfolder of botsRoot, except NanoClaw itself
 * (already mounted at /workspace/project — a second path to the same tree
 * would only invite edits that bypass the rules written for that path).
 */
export function siblingBotMounts(
  botsRoot: string,
  projectRoot: string,
): { hostPath: string; containerPath: string; readonly: boolean }[] {
  if (!botsRoot || !fs.existsSync(botsRoot)) return [];
  const self = path.resolve(projectRoot);
  return fs
    .readdirSync(botsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => path.join(botsRoot, d.name))
    .filter((p) => path.resolve(p) !== self)
    .map((hostPath) => ({
      hostPath,
      containerPath: `${SIBLING_BOTS_CONTAINER_DIR}/${path.basename(hostPath)}`,
      readonly: false,
    }));
}

/**
 * Handle one pm2-restart.flag if present. The flag's first line is the PM2
 * app name; it must be on the allowlist exactly. Returns the outcome line
 * that was appended to the log, or null when there was no flag.
 */
export function processPm2RestartFlag(
  ipcDir: string,
  allowed: string[],
  restart: (app: string) => string = (app) =>
    execFileSync('pm2', ['restart', app, '--update-env'], {
      encoding: 'utf-8',
      timeout: 60000,
    }),
): string | null {
  const flagPath = path.join(ipcDir, 'pm2-restart.flag');
  if (!fs.existsSync(flagPath)) return null;

  let app = '';
  try {
    app = fs.readFileSync(flagPath, 'utf-8').split('\n')[0].trim();
  } finally {
    // Remove first so a failing restart can't loop every tick.
    fs.rmSync(flagPath, { force: true });
  }

  let outcome: string;
  if (!allowed.includes(app)) {
    outcome = `REFUSED "${app}" — not in RESTARTABLE_PM2_APPS (${allowed.join(', ') || 'empty'})`;
    logger.warn({ app }, 'PM2 restart refused');
  } else {
    try {
      restart(app);
      outcome = `OK ${app} restarted`;
      logger.info({ app }, 'PM2 app restarted on request');
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      outcome = `FAIL ${app} — ${String(e.stderr || e.message || err).slice(0, 300)}`;
      logger.error({ app, err: outcome }, 'PM2 restart failed');
    }
  }
  fs.appendFileSync(
    path.join(ipcDir, 'pm2-restart.log'),
    `[${new Date().toISOString()}] ${outcome}\n`,
  );
  return outcome;
}

/** Polls data/ipc/pm2-restart.flag every 5 seconds. */
export function startPm2RestartWatcher(): void {
  const ipcDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcDir, { recursive: true });
  setInterval(() => {
    try {
      processPm2RestartFlag(ipcDir, RESTARTABLE_PM2_APPS);
    } catch (err) {
      logger.error({ err }, 'PM2 restart watcher tick failed');
    }
  }, 5000);
  logger.info(
    { botsRoot: BOTS_ROOT, apps: RESTARTABLE_PM2_APPS },
    'PM2 restart watcher started',
  );
}
