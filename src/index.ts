import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  ONECLI_URL,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  deleteSession,
  getAllTasks,
  countTodayBotResponses,
  getLastBotMessageTimestamp,
  listChatJidsByPrefix,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSessionCleanup } from './session-cleanup.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

/** Folders whose channels have a hard daily response limit (enforced at host level). */
const DIARY_FOLDER_PREFIX = 'diaries/';
/** Maximum bot responses per day for diary channels. */
const DIARY_DAILY_LIMIT = 5;

const channels: Channel[] = [];
const queue = new GroupQueue();

const onecli = new OneCLI({ url: ONECLI_URL });

function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
  if (group.isMain) return;
  const identifier = group.folder.toLowerCase().replace(/[_/]/g, '-');
  onecli.ensureAgent({ name: group.name, identifier }).then(
    (res) => {
      logger.info(
        { jid, identifier, created: res.created },
        'OneCLI agent ensured',
      );
    },
    (err) => {
      logger.debug(
        { jid, identifier, err: String(err) },
        'OneCLI agent ensure skipped',
      );
    },
  );
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);

  if (existing && botTs && existing > botTs) {
    // Cursor is ahead of the last bot reply — this means we advanced the
    // cursor (e.g. in the pipe path or diary-limit skip) but the agent never
    // actually sent a response. Roll back to the last bot reply so those
    // missed messages get re-processed.
    logger.warn(
      { chatJid, cursor: existing, lastBotReply: botTs },
      'Cursor ahead of last bot reply — rolling back to prevent missed messages',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }

  if (existing) return existing;

  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(
  jid: string,
  group: RegisteredGroup,
  templateFolder?: string,
): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  // templateFolder overrides the default ('main' for isMain, 'global' otherwise)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const resolvedTemplate =
      templateFolder ?? (group.isMain ? 'main' : 'global');
    const templateFile = path.join(GROUPS_DIR, resolvedTemplate, 'CLAUDE.md');
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info(
        { folder: group.folder, templateFolder: resolvedTemplate },
        'Created CLAUDE.md from template',
      );
    }
  }

  // Ensure a corresponding OneCLI agent exists (best-effort, non-blocking)
  ensureOneCLIAgent(jid, group);

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );

  // Backfill: if there are already-stored messages that arrived before this
  // group was registered (e.g. the very first message in a new diary channel),
  // enqueue them immediately so they are not silently dropped.
  const pending = getMessagesSince(
    jid,
    getOrRecoverCursor(jid),
    ASSISTANT_NAME,
  );
  if (pending.length > 0) {
    logger.info(
      { jid, name: group.name, pendingCount: pending.length },
      'Backfilling messages received before group registration',
    );
    queue.enqueueMessageCheck(jid);
  }
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  // Hard daily response limit for diary channels — enforced at host level so
  // parallel containers cannot race past it.  GroupQueue serialises calls per
  // JID, so the count read here is always up-to-date.
  if (group.folder.startsWith(DIARY_FOLDER_PREFIX)) {
    const todayCount = countTodayBotResponses(
      group.folder,
      ASSISTANT_NAME,
      TIMEZONE,
    );
    if (todayCount >= DIARY_DAILY_LIMIT) {
      // Silently advance cursor so these messages are not retried.
      lastAgentTimestamp[chatJid] =
        missedMessages[missedMessages.length - 1].timestamp;
      saveState();
      logger.info(
        { group: group.name, folder: group.folder, todayCount, limit: DIARY_DAILY_LIMIT },
        'Daily diary limit reached — skipping response',
      );
      return true;
    }
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      // Detect stale/corrupt session — clear it so the next retry starts fresh.
      // The session .jsonl can go missing after a crash mid-write, manual
      // deletion, or disk-full. The existing backoff in group-queue.ts
      // handles the retry; we just need to remove the broken session ID.
      const isStaleSession =
        sessionId &&
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          output.error,
        );

      if (isStaleSession) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error: output.error },
          'Stale session detected — clearing for next retry',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

/**
 * On startup, scan messages table for chat_jids that are missing from
 * registered_groups and ask each connected channel to (re-)register them.
 * Closes the gap where a message was stored before discord.ts auto-registration
 * fired (e.g. an early NanoClaw version, a deploy race, or a Channel adapter
 * code path that bypassed registration), so daily-limit counting can never
 * silently lose a chat again.
 */
async function backfillUnregisteredChannels(): Promise<void> {
  const candidates = listChatJidsByPrefix('dc:').filter(
    (jid) => !registeredGroups[jid] && /^dc:\d+$/.test(jid),
  );
  if (candidates.length === 0) return;
  let backfilled = 0;
  for (const jid of candidates) {
    for (const ch of channels) {
      if (!ch.ensureGroupRegistered) continue;
      try {
        if (await ch.ensureGroupRegistered(jid)) {
          backfilled++;
          break;
        }
      } catch (err) {
        logger.debug({ jid, err: String(err) }, 'Backfill attempt failed');
      }
    }
  }
  logger.info(
    { scanned: candidates.length, backfilled },
    'Diary registration backfill complete',
  );
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        // Process main group first, then others
        const sortedEntries = [...messagesByGroup.entries()].sort(
          ([jidA], [jidB]) => {
            const isMainA = registeredGroups[jidA]?.isMain ? 1 : 0;
            const isMainB = registeredGroups[jidB]?.isMain ? 1 : 0;
            return isMainB - isMainA;
          },
        );

        for (const [chatJid, groupMessages] of sortedEntries) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Hard daily limit check for diary channels — same guard as in
          // processGroupMessages, but applied here for the piping path
          // (active container already running).
          if (group.folder.startsWith(DIARY_FOLDER_PREFIX)) {
            const todayCount = countTodayBotResponses(
              group.folder,
              ASSISTANT_NAME,
              TIMEZONE,
            );
            if (todayCount >= DIARY_DAILY_LIMIT) {
              lastAgentTimestamp[chatJid] =
                groupMessages[groupMessages.length - 1].timestamp;
              saveState();
              logger.info(
                { group: group.name, folder: group.folder, todayCount, limit: DIARY_DAILY_LIMIT },
                'Daily diary limit reached (pipe path) — skipping',
              );
              continue;
            }
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

/**
 * Deploy flag watcher — polls data/ipc/deploy.flag every 5 seconds. When the
 * flag appears, runs the full deploy pipeline on the host:
 *   1. git add -A
 *   2. git commit (if there are staged changes) with bot identity
 *   3. git push origin main (uses host ~/.ssh/id_ed25519)
 *   4. npm run build
 *   5. process.exit(0) → systemd restarts NanoClaw with the new dist
 *
 * The agent inside the admin (main) container triggers a deploy by writing
 * the desired commit message into /workspace/project/data/ipc/deploy.flag.
 * The SSH private key stays on the host — the agent never sees it, so it can
 * trigger pushes without credential exposure.
 *
 * All step results (success + stderr slices) are appended to
 * data/ipc/deploy.log so the next agent session can verify outcomes.
 */
function startDeployWatcher(): void {
  const projectRoot = process.cwd();
  const ipcDir = path.join(projectRoot, 'data', 'ipc');
  const flagPath = path.join(ipcDir, 'deploy.flag');
  const logPath = path.join(ipcDir, 'deploy.log');
  fs.mkdirSync(ipcDir, { recursive: true });

  const POLL_MS = 5000;

  const appendLog = (line: string): void => {
    try {
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`);
    } catch (err) {
      logger.warn({ err }, 'deploy.log append failed');
    }
  };

  const runStep = (
    label: string,
    cmd: string,
  ): { ok: boolean; out: string } => {
    try {
      const out = execSync(cmd, {
        cwd: projectRoot,
        encoding: 'utf-8',
        timeout: 180000,
        shell: '/bin/bash',
      });
      const lastLines = out.trim().split('\n').slice(-3).join(' | ');
      appendLog(`  [${label}] OK ${lastLines}`);
      return { ok: true, out };
    } catch (err) {
      const e = err as { stderr?: Buffer; stdout?: Buffer; message?: string };
      const msg = String(e?.stderr || e?.stdout || e?.message || err).slice(
        0,
        500,
      );
      appendLog(`  [${label}] FAIL ${msg}`);
      logger.error({ step: label, err: msg }, 'Deploy step failed');
      return { ok: false, out: msg };
    }
  };

  const processDeploy = (): void => {
    if (!fs.existsSync(flagPath)) return;

    let message: string;
    try {
      message = fs.readFileSync(flagPath, 'utf-8').trim() || 'automated deploy';
    } catch (err) {
      logger.warn({ err }, 'Failed to read deploy.flag');
      return;
    }
    logger.info({ message }, 'Deploy flag detected, starting deploy');
    appendLog(`BEGIN: ${message}`);

    // Remove flag immediately so a failed/stuck step doesn't loop
    try {
      fs.unlinkSync(flagPath);
    } catch (err) {
      logger.warn({ err }, 'Failed to unlink deploy.flag');
    }

    // 1. Stage everything
    const add = runStep('git-add', 'git add -A');
    if (!add.ok) {
      appendLog('END: aborted at git add');
      return;
    }

    // 2. Check for staged changes
    const status = runStep('git-status', 'git diff --cached --name-only');
    if (status.ok && !status.out.trim()) {
      appendLog(
        '  [git-status] no staged changes — skipping commit/push, doing build only',
      );
    } else {
      // 3. Commit with bot identity
      const escaped = message.replace(/["\\$`]/g, '\\$&');
      const commit = runStep(
        'git-commit',
        `git -c user.email="bot@nanoclaw.local" -c user.name="NanoClaw-Bot" commit -m "${escaped}"`,
      );
      if (!commit.ok) {
        appendLog('END: aborted at git commit');
        return;
      }

      // 4. Push to origin/main (uses host SSH key)
      const push = runStep('git-push', 'git push origin main');
      if (!push.ok) {
        appendLog(
          'END: aborted at git push — local commit saved, host intervention needed',
        );
        return;
      }
    }

    // 5. Rebuild TypeScript
    const build = runStep('npm-build', 'npm run build');
    if (!build.ok) {
      appendLog('END: aborted at npm run build');
      return;
    }

    // 6. If dashboard/ files changed, restart the gaegul-dashboard PM2
    // process. The dashboard is a separate Node process managed by PM2,
    // not by NanoClaw, so a NanoClaw systemd restart does NOT pick up
    // dashboard/server.js or dashboard/public/* changes. Detect via
    // git diff-tree on the just-made commit.
    const dashboardCheck = runStep(
      'detect-dashboard',
      "git diff-tree --no-commit-id --name-only -r HEAD | grep -c '^dashboard/' || true",
    );
    const dashboardTouched =
      dashboardCheck.ok && parseInt(dashboardCheck.out.trim(), 10) > 0;
    if (dashboardTouched) {
      const pm2Restart = runStep(
        'pm2-restart-dashboard',
        'pm2 restart gaegul-dashboard --update-env',
      );
      if (!pm2Restart.ok) {
        appendLog(
          '  [pm2-restart-dashboard] WARN: dashboard files committed but PM2 restart failed — host intervention needed',
        );
        // Do NOT abort: the commit/push/build succeeded, so NanoClaw
        // restart should still proceed. Operator will see the warning.
      }
    }

    // 7. Exit for systemd to restart with the new dist
    appendLog(`END: deploy success — exiting for systemd restart`);
    logger.info('Deploy successful, exiting for systemd restart in 500ms');
    setTimeout(() => process.exit(0), 500);
  };

  setInterval(() => {
    try {
      processDeploy();
    } catch (err) {
      logger.error({ err }, 'Deploy watcher tick failed');
    }
  }, POLL_MS);

  logger.info({ flagPath }, 'Deploy watcher started');
}

/**
 * Pull watcher — polls origin/main every 30 seconds. When origin is ahead
 * of local HEAD (i.e. Windows or another operator pushed new commits), the
 * host runs:
 *   1. git pull origin main --ff-only
 *   2. npm run build
 *   3. pm2 restart gaegul-dashboard (if dashboard/ changed)
 *   4. process.exit(0) → systemd restarts NanoClaw with the new dist
 *
 * This is the symmetric counterpart to the deploy watcher. Together they
 * make the mini PC auto-sync with GitHub in both directions:
 *   - Outbound: admin agent writes data/ipc/deploy.flag → deploy watcher
 *     commits/pushes to origin, builds, restarts.
 *   - Inbound: external push (Windows VS Code, GitHub UI, CI) → pull watcher
 *     fetches, FF-pulls, builds, restarts.
 *
 * Skip conditions (all quiet, no action):
 *   - data/ipc/deploy.flag exists (outbound deploy in progress, let it finish)
 *   - Uncommitted local changes (would block FF)
 *   - Local and origin are identical (nothing to pull)
 *   - Local is ahead of origin (we pushed more than origin has — odd state,
 *     don't overwrite)
 *
 * Failure modes (logged, never crash):
 *   - git fetch unreachable (offline, GitHub down) → debug log, next tick
 *   - FF not possible (divergent history, force-push) → warn log, skip
 *   - Build error → log, skip (keep running on old dist)
 */
function startPullWatcher(): void {
  const projectRoot = process.cwd();
  const ipcDir = path.join(projectRoot, 'data', 'ipc');
  const flagPath = path.join(ipcDir, 'deploy.flag');
  const logPath = path.join(ipcDir, 'pull.log');
  fs.mkdirSync(ipcDir, { recursive: true });

  const POLL_MS = 30_000;

  const appendLog = (line: string): void => {
    try {
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`);
    } catch (err) {
      logger.warn({ err }, 'pull.log append failed');
    }
  };

  const runStep = (
    label: string,
    cmd: string,
  ): { ok: boolean; out: string } => {
    try {
      const out = execSync(cmd, {
        cwd: projectRoot,
        encoding: 'utf-8',
        timeout: 180000,
        shell: '/bin/bash',
      });
      return { ok: true, out };
    } catch (err) {
      const e = err as { stderr?: Buffer; stdout?: Buffer; message?: string };
      const msg = String(e?.stderr || e?.stdout || e?.message || err).slice(
        0,
        500,
      );
      appendLog(`  [${label}] FAIL ${msg}`);
      return { ok: false, out: msg };
    }
  };

  const processPull = (): void => {
    // Skip if deploy is in progress — deploy watcher owns the commit path
    if (fs.existsSync(flagPath)) return;

    // Quick fetch to refresh origin/main
    const fetch = runStep('git-fetch', 'git fetch origin main --quiet');
    if (!fetch.ok) {
      // Offline or GitHub hiccup — silent, don't spam logs
      logger.debug({ err: fetch.out }, 'git fetch skipped');
      return;
    }

    // Compare local vs origin
    const local = runStep('git-rev-parse-head', 'git rev-parse HEAD');
    const remote = runStep('git-rev-parse-remote', 'git rev-parse origin/main');
    if (!local.ok || !remote.ok) return;

    const localSha = local.out.trim();
    const remoteSha = remote.out.trim();
    if (localSha === remoteSha) return; // Already in sync

    // Check if local is ahead of remote (we pushed more than origin has).
    // This can happen temporarily during deploy; skip so we don't clobber.
    const mergeBase = runStep(
      'git-merge-base',
      `git merge-base ${localSha} ${remoteSha}`,
    );
    if (!mergeBase.ok) return;
    const base = mergeBase.out.trim();
    if (base === remoteSha) {
      // Local is ahead or diverged — do not pull
      return;
    }
    if (base !== localSha) {
      // Diverged history (not a clean FF) — log once and skip
      appendLog(
        `DIVERGENT: local=${localSha.slice(0, 7)} remote=${remoteSha.slice(0, 7)} base=${base.slice(0, 7)} — skipping pull, manual rebase needed`,
      );
      return;
    }

    // local is a strict ancestor of remote → clean FF
    appendLog(
      `BEGIN pull: local=${localSha.slice(0, 7)} → remote=${remoteSha.slice(0, 7)}`,
    );

    // Guard against uncommitted changes that would block FF pull
    const dirty = runStep('git-dirty-check', 'git status --porcelain');
    if (dirty.ok && dirty.out.trim()) {
      appendLog(
        `  [git-dirty-check] SKIP: uncommitted local changes present, not pulling`,
      );
      return;
    }

    // Fast-forward pull
    const pull = runStep('git-pull-ff', 'git pull origin main --ff-only');
    if (!pull.ok) {
      appendLog('END pull: aborted at git pull (FF rejected)');
      return;
    }
    appendLog(`  [git-pull-ff] OK to ${remoteSha.slice(0, 7)}`);

    // Rebuild TypeScript
    const build = runStep('npm-build', 'npm run build');
    if (!build.ok) {
      appendLog('END pull: aborted at npm run build (running stale dist)');
      return;
    }
    appendLog('  [npm-build] OK');

    // Dashboard file detection (same logic as deploy watcher)
    const dashboardCheck = runStep(
      'detect-dashboard',
      `git diff-tree --no-commit-id --name-only -r ${localSha}..${remoteSha} | grep -c '^dashboard/' || true`,
    );
    const dashboardTouched =
      dashboardCheck.ok && parseInt(dashboardCheck.out.trim(), 10) > 0;
    if (dashboardTouched) {
      const pm2Restart = runStep(
        'pm2-restart-dashboard',
        'pm2 restart gaegul-dashboard --update-env',
      );
      if (pm2Restart.ok) {
        appendLog('  [pm2-restart-dashboard] OK');
      } else {
        appendLog(
          '  [pm2-restart-dashboard] WARN: dashboard pulled but PM2 restart failed',
        );
      }
    }

    // Exit for systemd to restart with the new dist
    appendLog('END pull: success — exiting for systemd restart');
    logger.info(
      { from: localSha.slice(0, 7), to: remoteSha.slice(0, 7) },
      'Remote ahead, pulled and rebuilt, exiting for restart',
    );
    setTimeout(() => process.exit(0), 500);
  };

  setInterval(() => {
    try {
      processPull();
    } catch (err) {
      logger.error({ err }, 'Pull watcher tick failed');
    }
  }, POLL_MS);

  logger.info({ intervalMs: POLL_MS }, 'Pull watcher started');
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  restoreRemoteControl();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
    registerGroup: (
      jid: string,
      group: RegisteredGroup,
      templateFolder?: string,
    ) => registerGroup(jid, group, templateFolder),
    defaultTrigger: () => DEFAULT_TRIGGER,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  startSessionCleanup();
  startDeployWatcher();
  startPullWatcher();
  queue.setProcessMessagesFn(processGroupMessages);
  await backfillUnregisteredChannels();
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
