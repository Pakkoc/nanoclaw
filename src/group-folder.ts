import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';

const GROUP_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_FOLDERS = new Set(['global']);

export function isValidGroupFolder(folder: string): boolean {
  if (!folder) return false;
  if (folder !== folder.trim()) return false;
  if (!GROUP_FOLDER_PATTERN.test(folder)) return false;
  if (folder.includes('/') || folder.includes('\\')) return false;
  if (folder.includes('..')) return false;
  if (RESERVED_FOLDERS.has(folder.toLowerCase())) return false;
  return true;
}

export function assertValidGroupFolder(folder: string): void {
  if (!isValidGroupFolder(folder)) {
    throw new Error(`Invalid group folder "${folder}"`);
  }
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const rel = path.relative(baseDir, resolvedPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base directory: ${resolvedPath}`);
  }
}

export function resolveGroupFolderPath(folder: string): string {
  assertValidGroupFolder(folder);
  const groupPath = path.resolve(GROUPS_DIR, folder);
  ensureWithinBase(GROUPS_DIR, groupPath);
  return groupPath;
}

/**
 * Resolve IPC directory path for a group by its JID.
 * JIDs like "dc:1228360623960887327" are sanitized to safe filenames.
 * Each JID gets a unique IPC namespace, enabling parallel processing
 * of multiple channels that share the same group folder.
 */
export function resolveGroupIpcPath(jid: string): string {
  // Sanitize JID into a filesystem-safe name: replace non-alphanumeric chars with '_'
  const safeName = jid.replace(/[^A-Za-z0-9_-]/g, '_');
  if (!safeName) throw new Error(`Cannot resolve IPC path for empty JID`);
  const ipcBaseDir = path.resolve(DATA_DIR, 'ipc');
  const ipcPath = path.resolve(ipcBaseDir, safeName);
  ensureWithinBase(ipcBaseDir, ipcPath);
  return ipcPath;
}
