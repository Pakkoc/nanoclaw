import {
  ChannelType,
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  Message,
  MessageType,
  TextChannel,
  ThreadAutoArchiveDuration,
  ThreadChannel,
} from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  HELPDESK_FOLDER,
  HelpdeskKind,
  checkHelpdeskCaps,
  classifyHelpdeskText,
  loadHelpdeskConfig,
  logHelpdesk,
  looksResolved,
  recordHelpdeskWake,
} from './helpdesk.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (
    jid: string,
    group: RegisteredGroup,
    templateFolder?: string,
  ) => void;
  deregisterGroup: (jid: string) => void;
  defaultTrigger: () => string;
}

// Staff Discord IDs for ticket channel intervention check.
// When any of these users has posted in a ticket channel, Claude stays silent
// (host-level guard — not subject to LLM reasoning).
const TICKET_STAFF_IDS = new Set([
  '364764044948799491', // 성호
  '459757901251346452', // 죨디
  '276024344101257216', // 요나새
  '1341276764827156555', // 호녈
  '1397824633805475905', // 초코슈
  '845167421069590560', // 운명교향곡
  '537616840898248705', // 나린
]);

// Diary category IDs — messages in these categories are auto-registered
// as per-channel groups using the discord_diary CLAUDE.md template.
const DIARY_CATEGORY_IDS = new Set([
  '1236979261529657426', // 🩷 소용돌이 기숙사
  '1236979345529114664', // 💜 노블레빗 기숙사
  '1236979439879848028', // 🩵 볼리베어 기숙사
  '1386697214910529687', // 🩶 펭도리야 기숙사
]);

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  private ticketCategoryId: string | null;

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
    this.ticketCategoryId =
      process.env.DISCORD_TICKET_CATEGORY_ID ||
      readEnvFile(['DISCORD_TICKET_CATEGORY_ID']).DISCORD_TICKET_CATEGORY_ID ||
      null;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildVoiceStates,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // 다른 봇(music-bot, lavalink 등) 메시지는 무시하되, 자기 자신이 API로
      // 직접 보낸 메시지는 저장해야 한다. container skill(create-diary.sh,
      // post-discord.sh)들이 Discord API를 직접 호출해서 ticket 채널에 완료
      // 메시지를 보내는데, 이걸 DB에 남겨야 업무일지 크론이 집계 가능.
      const myBotId = this.client?.user?.id;
      if (message.author.bot && message.author.id !== myBotId) return;
      // startThread()가 스레드 안에 남기는 빈 시스템 메시지. 봇 작성으로 저장되면
      // 커서 복구가 이를 "마지막 봇 답장"으로 보고 원 게시글을 건너뛴다.
      if (message.type === MessageType.ThreadStarterMessage) return;

      // Helpdesk channels (전체 채팅, 자유질문 포럼): human messages never take
      // the normal path — a host-side filter decides whether to wake an agent.
      if (!message.author.bot && message.guild) {
        const kind = this.helpdeskKind(message);
        if (kind) {
          await this.handleHelpdeskMessage(message, kind);
          return;
        }
      }

      const channelId = message.channelId;
      const realJid = `dc:${channelId}`;
      let chatJid = realJid;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();

      // Ticket channel detection: ticket-* channels under the configured
      // ticket category are routed to the dc:tickets catchall JID.
      const ticketChannel =
        this.ticketCategoryId && message.guild
          ? (message.channel as TextChannel)
          : null;
      const isTicketChannel =
        ticketChannel !== null &&
        ticketChannel.parentId === this.ticketCategoryId &&
        (ticketChannel.name?.startsWith('ticket-') ?? false);

      // Tickets use a single virtual JID (dc:tickets) with per-channel prefix
      // embedded in the content, so the admin agent can query all tickets in one place.
      if (isTicketChannel) {
        chatJid = 'dc:tickets';
        const prefix = `[ticket-channel:${channelId} #${ticketChannel!.name}]`;
        content = content ? `${prefix} ${content}` : prefix;
      }

      // Thread detection: public/private threads inside diary channels.
      const isThread =
        message.channel.type === ChannelType.PublicThread ||
        message.channel.type === ChannelType.PrivateThread;

      // Diary channel detection: any channel (or thread inside a channel)
      // under a diary category is auto-registered as a per-channel group.
      // For threads, check the grandparent (thread → channel → category).
      let diaryParentId = '';
      let diaryParentChannelId = channelId; // folder key: use parent channel ID for threads
      if (isThread) {
        const thread = message.channel as ThreadChannel;
        const parentChannel = thread.parent as TextChannel | null;
        diaryParentId = parentChannel?.parentId ?? '';
        diaryParentChannelId = thread.parentId ?? channelId;
      } else if (message.guild) {
        diaryParentId = (message.channel as TextChannel).parentId ?? '';
      }
      const isDiaryChannel =
        !isTicketChannel &&
        message.guild !== null &&
        DIARY_CATEGORY_IDS.has(diaryParentId);

      logger.debug(
        {
          channelId,
          diaryParentId,
          isDiaryChannel,
          isTicketChannel,
        },
        'Discord channel routing',
      );
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Thread-session channels (containerConfig.threadSessions): every
      // top-level post opens its own Discord thread, and the conversation —
      // with its own Claude session — continues only inside that thread.
      // If thread creation fails we fall through and handle the message in
      // the channel as before.
      let sessionThread: ThreadChannel | null = null;
      if (message.guild && !message.author.bot) {
        if (isThread) {
          const thread = message.channel as ThreadChannel;
          const parentGroup =
            this.opts.registeredGroups()[`dc:${thread.parentId}`];
          if (parentGroup?.containerConfig?.threadSessions) {
            this.ensureThreadSessionGroup(realJid, thread.name, parentGroup);
          }
        } else {
          const parentGroup = this.opts.registeredGroups()[realJid];
          const isUserPost =
            message.type === MessageType.Default ||
            message.type === MessageType.Reply;
          if (parentGroup?.containerConfig?.threadSessions && isUserPost) {
            try {
              sessionThread = await message.startThread({
                name: threadNameFor(message, senderName),
                autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
              });
              chatJid = `dc:${sessionThread.id}`;
              this.ensureThreadSessionGroup(
                chatJid,
                sessionThread.name,
                parentGroup,
              );
              logger.info(
                { parentJid: realJid, threadJid: chatJid },
                'Opened session thread for channel post',
              );
            } catch (err) {
              logger.warn(
                { chatJid: realJid, err },
                'Session thread creation failed — handling in channel',
              );
            }
          }
        }
      }

      // Determine chat name
      let chatName: string;
      if (sessionThread) {
        chatName = `${message.guild!.name} #${sessionThread.name}`;
      } else if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      let isBotMentioned = false;
      if (this.client?.user) {
        const botId = this.client.user.id;
        isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Handle attachments — store placeholders so the agent knows something was sent
      if (message.attachments.size > 0) {
        const attachmentDescriptions = [...message.attachments.values()].map(
          (att) => {
            const contentType = att.contentType || '';
            if (contentType.startsWith('image/')) {
              // Include URL so agent-runner can fetch and pass to vision model
              return `[Image: ${att.name || 'image'}](${att.url})`;
            } else if (contentType.startsWith('video/')) {
              return `[Video: ${att.name || 'video'}]`;
            } else if (contentType.startsWith('audio/')) {
              return `[Audio: ${att.name || 'audio'}]`;
            } else {
              return `[File: ${att.name || 'file'}]`;
            }
          },
        );
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata so it appears in the chats table.
      // Must happen before storeMessage (FK constraint: chat_jid in chats).
      // Tickets use chatJid (dc:tickets); all others use realJid.
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        isTicketChannel ? '마법사관학교 티켓 카테고리' : chatName,
        'discord',
        isGroup,
      );

      // Diary: idempotent. No-op if already registered.
      // Tickets use the pre-registered dc:tickets group — no per-channel registration.
      if (!isTicketChannel) {
        await this.ensureGroupRegistered(realJid);
      }

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      // 자기 봇이 API로 직접 보낸 메시지는 is_from_me + is_bot_message 둘 다
      // 표시. is_bot_message=1이면 getNewMessages/getMessagesSince에서 제외되어
      // 에이전트를 깨우지 않지만, 업무일지 크론의 raw SQL 쿼리에는 그대로 잡힘.
      const isSelfBot = message.author.id === this.client?.user?.id;

      // Backstop: a helpdesk group must only be woken by handleHelpdeskMessage
      // (e.g. if filter.json lost its channel IDs, chat must stay silent).
      if (group.folder === HELPDESK_FOLDER && !isSelfBot) return;

      // ── Ticket channel: host-level staff intervention guard ──────────────
      // If a staff member has already posted in this ticket channel, Claude
      // must stay silent — no LLM reasoning involved.
      // Exception: if the bot is directly @mentioned, always respond.
      if (isTicketChannel && !isSelfBot && !isBotMentioned) {
        const isFromStaff = TICKET_STAFF_IDS.has(message.author.id);
        let staffHasReplied = false;

        if (!isFromStaff) {
          // Regular user message — check if any staff has posted before
          try {
            const recent = await (
              message.channel as TextChannel
            ).messages.fetch({ limit: 50, before: message.id });
            staffHasReplied = recent.some((m) =>
              TICKET_STAFF_IDS.has(m.author.id),
            );
          } catch (err) {
            // Fail-open: if check fails, proceed normally
            logger.warn(
              { channelId, err },
              'Ticket staff-check failed, proceeding normally',
            );
          }
        }

        if (isFromStaff || staffHasReplied) {
          // Store the message for history but suppress agent wake-up
          this.opts.onMessage(chatJid, {
            id: msgId,
            chat_jid: chatJid,
            sender,
            sender_name: senderName,
            content,
            timestamp,
            is_from_me: false,
            is_bot_message: true,
          });
          logger.info(
            { channelId, senderName, isFromStaff, staffHasReplied },
            'Ticket: staff already intervened — agent suppressed',
          );
          return;
        }
      }
      // ────────────────────────────────────────────────────────────────────

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isSelfBot,
        is_bot_message: isSelfBot,
      });
      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Deregister per-channel groups when their Discord channel/thread is
    // deleted, so tombstoned tickets/diaries don't linger in the registry.
    this.client.on(Events.ChannelDelete, (channel) =>
      this.handleChannelDeleted(channel.id),
    );
    this.client.on(Events.ThreadDelete, (thread) =>
      this.handleChannelDeleted(thread.id),
    );

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // Optional leading `[[reply:<messageId>]]` (used by the helpdesk agent)
      // sends the first chunk as a Discord reply to that message.
      let replyTo: string | null = null;
      const directive = text.match(/^\s*\[\[reply:(\d+)\]\]\s*/);
      if (directive) {
        replyTo = directive[1];
        text = text.slice(directive[0].length);
        if (!text.trim()) return;
      }

      // Discord has a 2000 character limit per message — split if needed
      const MAX_LENGTH = 2000;
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        const chunk = text.slice(i, i + MAX_LENGTH);
        if (i === 0 && replyTo) {
          await textChannel.send({
            content: chunk,
            reply: { messageReference: replyTo, failIfNotExists: false },
          });
        } else {
          await textChannel.send(chunk);
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }

  async ensureGroupRegistered(chatJid: string): Promise<boolean> {
    if (!chatJid.startsWith('dc:')) return false;
    if (this.opts.registeredGroups()[chatJid]) return true;

    const channelId = chatJid.slice('dc:'.length);
    if (!/^\d+$/.test(channelId)) return false;
    if (!this.client) return false;

    let channel;
    try {
      channel = await this.client.channels.fetch(channelId, { force: true });
    } catch (err) {
      logger.debug(
        { chatJid, err: String(err) },
        'ensureGroupRegistered fetch failed',
      );
      return false;
    }
    if (!channel) return false;

    const isThread =
      channel.type === ChannelType.PublicThread ||
      channel.type === ChannelType.PrivateThread;

    let categoryId: string;
    let parentChannelId: string;
    let chanName: string;

    if (isThread) {
      const thread = channel as ThreadChannel;
      const parent = thread.parent as TextChannel | null;
      if (!parent) return false;
      categoryId = parent.parentId ?? '';
      parentChannelId = thread.parentId ?? channelId;
      chanName = thread.name;
    } else if (
      channel.type === ChannelType.GuildText &&
      'parentId' in channel
    ) {
      const textChannel = channel as TextChannel;
      categoryId = textChannel.parentId ?? '';
      parentChannelId = textChannel.id;
      chanName = textChannel.name;
    } else {
      return false;
    }

    if (!DIARY_CATEGORY_IDS.has(categoryId)) return false;

    this.opts.registerGroup(
      chatJid,
      {
        name: `기숙사 다이어리 #${chanName}`,
        folder: `diaries/discord_diary_ch${parentChannelId}`,
        trigger: this.opts.defaultTrigger(),
        added_at: new Date().toISOString(),
        requiresTrigger: true,
      },
      'discord_diary',
    );
    logger.info(
      { chatJid, parentChannelId, chanName, isThread },
      'Backfilled diary registration via ensureGroupRegistered',
    );
    return true;
  }

  /**
   * Register a thread of a threadSessions channel as its own group: same
   * folder and permissions as the parent (shared CLAUDE.md, memories, files),
   * but a Claude session of its own (sessionPerJid). No-op if registered.
   */
  private ensureThreadSessionGroup(
    jid: string,
    threadName: string,
    parent: RegisteredGroup,
  ): void {
    if (this.opts.registeredGroups()[jid]) return;
    const { threadSessions: _parentOnly, ...inherited } =
      parent.containerConfig ?? {};
    this.opts.registerGroup(jid, {
      name: `${parent.name} 🧵${threadName}`,
      folder: parent.folder,
      trigger: parent.trigger,
      added_at: new Date().toISOString(),
      requiresTrigger: false,
      isMain: parent.isMain,
      containerConfig: { ...inherited, sessionPerJid: true },
    });
  }

  /** Which helpdesk stream a message belongs to, or null if none. */
  private helpdeskKind(message: Message): HelpdeskKind | null {
    const config = loadHelpdeskConfig();
    if (config.chatChannelIds.includes(message.channelId)) return 'chat';
    const isThread =
      message.channel.type === ChannelType.PublicThread ||
      message.channel.type === ChannelType.PrivateThread;
    if (!isThread) return null;
    const parentId = (message.channel as ThreadChannel).parentId ?? '';
    if (!config.forumChannelIds.includes(parentId)) return null;
    // A forum post's starter message shares the thread's ID.
    return message.id === message.channelId ? 'forum-starter' : 'forum-followup';
  }

  /** Stages 1–2 (keyword/question, caps), then schedule the delayed check. */
  private async handleHelpdeskMessage(
    message: Message,
    kind: HelpdeskKind,
  ): Promise<void> {
    const config = loadHelpdeskConfig();
    if (!config.enabled) return;
    if (TICKET_STAFF_IDS.has(message.author.id)) return;

    const base = {
      kind,
      channelId: message.channelId,
      messageId: message.id,
      authorId: message.author.id,
    };
    const text =
      kind === 'forum-starter'
        ? `${(message.channel as ThreadChannel).name}\n${message.content}`
        : message.content;

    const cls = classifyHelpdeskText(text, kind, config);
    if (!cls.pass) {
      // Keyword hits are logged so the weekly review can spot misses.
      if (cls.keyword)
        logHelpdesk({
          ...base,
          stage: 'filter',
          reason: cls.reason,
          keyword: cls.keyword,
          text,
        });
      return;
    }

    const botId = this.client?.user?.id;
    let skip: string | null = null;
    if (kind !== 'forum-starter') {
      if (config.skipRepliesToOthers && message.reference?.messageId) {
        try {
          const ref = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          if (ref.author.id !== botId && ref.author.id !== message.author.id)
            skip = 'reply-to-other';
        } catch {
          // Referenced message gone — treat as a standalone question.
        }
      }
      if (
        !skip &&
        config.skipIfMentionsOthers &&
        message.mentions.users.some(
          (u) => u.id !== botId && u.id !== message.author.id,
        )
      )
        skip = 'mentions-other';
    }
    skip = skip ?? checkHelpdeskCaps(message.author.id, config);
    if (skip) {
      logHelpdesk({
        ...base,
        stage: 'filter',
        reason: skip,
        keyword: cls.keyword,
        text,
      });
      return;
    }

    logHelpdesk({
      ...base,
      stage: 'queued',
      reason: 'candidate',
      keyword: cls.keyword,
      text,
    });
    setTimeout(() => {
      this.helpdeskAfterDelay(message, kind, text, cls.keyword).catch((err) =>
        logger.warn({ err, messageId: message.id }, 'Helpdesk delayed check failed'),
      );
    }, config.delaySeconds * 1000);
  }

  /** Stage 3: skip if a human already handled it, else wake the agent. */
  private async helpdeskAfterDelay(
    message: Message,
    kind: HelpdeskKind,
    text: string,
    keyword: string | undefined,
  ): Promise<void> {
    const config = loadHelpdeskConfig();
    if (!config.enabled || !this.client) return;
    const base = {
      kind,
      channelId: message.channelId,
      messageId: message.id,
      authorId: message.author.id,
      keyword,
      text,
    };
    const asker = message.author.id;
    const botId = this.client.user?.id;
    const channel = message.channel;

    let after: Message[];
    try {
      await channel.messages.fetch(message.id); // throws if deleted
      const col = await channel.messages.fetch({
        after: message.id,
        limit: 50,
      });
      after = [...col.values()].sort(
        (a, b) => a.createdTimestamp - b.createdTimestamp,
      );
    } catch {
      logHelpdesk({ ...base, stage: 'delay-check', reason: 'deleted-or-fetch-failed' });
      return;
    }

    const humans = after.filter((m) => !m.author.bot);
    const others = humans.filter((m) => m.author.id !== asker);
    let answered: string | null = null;
    if (others.some((m) => TICKET_STAFF_IDS.has(m.author.id)))
      answered = 'staff-active';
    else if (kind !== 'chat' && others.length > 0) answered = 'human-replied';
    else if (
      others.some(
        (m) =>
          m.reference?.messageId === message.id || m.mentions.users.has(asker),
      )
    )
      answered = 'human-replied';
    else if (
      after.some(
        (m) => m.author.id === botId && m.reference?.messageId === message.id,
      )
    )
      answered = 'bot-replied';
    else if (
      humans.some(
        (m) => m.author.id === asker && looksResolved(m.content, config),
      )
    )
      answered = 'resolved';
    answered = answered ?? checkHelpdeskCaps(asker, config);
    if (answered) {
      logHelpdesk({ ...base, stage: 'delay-check', reason: answered });
      return;
    }

    let before: Message[] = [];
    if (kind !== 'forum-starter' && config.contextBefore > 0) {
      try {
        const col = await channel.messages.fetch({
          before: message.id,
          limit: config.contextBefore,
        });
        before = [...col.values()]
          .filter((m) => !m.author.bot || m.author.id === botId)
          .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      } catch {
        // Context is best-effort.
      }
    }

    const nameOf = (m: Message) =>
      m.author.id === botId
        ? '부엉이(나)'
        : m.member?.displayName || m.author.displayName || m.author.username;
    const line = (m: Message) =>
      `- ${nameOf(m)}: ${(m.content || '[첨부/빈 메시지]').replace(/\s+/g, ' ').slice(0, 300)}`;
    const afterCtx = after
      .filter((m) => !m.author.bot || m.author.id === botId)
      .slice(0, config.contextAfter);

    const isThread = kind !== 'chat';
    const thread = isThread ? (channel as ThreadChannel) : null;
    const askerName = nameOf(message);
    const parts = [
      `[helpdesk kind:${kind} channel:${message.channelId} message:${message.id} asker:<@${asker}> askerName:${askerName}]`,
    ];
    if (thread) parts.push(`포럼 글 제목: ${thread.name}`);
    if (before.length) parts.push('앞 대화:', ...before.map(line));
    parts.push(
      '질문:',
      `- ${askerName}: ${message.content.slice(0, 1500) || '[첨부/빈 메시지]'}`,
    );
    if (message.attachments.size > 0)
      parts.push(`(첨부 ${message.attachments.size}개 — 내용은 볼 수 없음)`);
    parts.push(
      afterCtx.length ? '질문 이후 대화:' : '질문 이후 대화: 없음',
      ...afterCtx.map(line),
    );
    const content = parts.join('\n');

    const jid = `dc:${message.channelId}`;
    const guildName = message.guild?.name ?? '';
    const chatName = thread
      ? `${guildName} #${thread.name}`
      : `${guildName} #${(channel as TextChannel).name}`;
    const nowIso = new Date().toISOString();
    this.opts.onChatMetadata(jid, nowIso, chatName, 'discord', true);
    if (!this.opts.registeredGroups()[jid]) {
      this.opts.registerGroup(jid, {
        name: `헬프데스크 ${thread ? '🧵' + thread.name : '#' + (channel as TextChannel).name}`,
        folder: HELPDESK_FOLDER,
        trigger: this.opts.defaultTrigger(),
        added_at: nowIso,
        requiresTrigger: false,
        containerConfig: {
          model: 'claude-sonnet-5-5',
          effort: 'medium',
          freshSession: true,
        },
      });
    }
    if (!this.opts.registeredGroups()[jid]) {
      logHelpdesk({ ...base, stage: 'delay-check', reason: 'register-failed' });
      return;
    }

    recordHelpdeskWake(asker);
    // Delivery time, not the original timestamp: keeps the cursor monotonic
    // even though delivery is delayed.
    this.opts.onMessage(jid, {
      id: message.id,
      chat_jid: jid,
      sender: asker,
      sender_name: askerName,
      content,
      timestamp: nowIso,
      is_from_me: false,
      is_bot_message: false,
    });
    logHelpdesk({ ...base, stage: 'woke', reason: 'delivered' });
  }

  private handleChannelDeleted(channelId: string): void {
    const jid = `dc:${channelId}`;
    const group = this.opts.registeredGroups()[jid];
    if (!group) return;
    const isLifecycleGroup =
      group.folder.startsWith('discord_tickets_ch') ||
      group.folder.startsWith('diaries/') ||
      group.containerConfig?.sessionPerJid === true ||
      (group.folder === HELPDESK_FOLDER &&
        !loadHelpdeskConfig().chatChannelIds.includes(channelId));
    if (!isLifecycleGroup) return;

    this.opts.deregisterGroup(jid);
    logger.info(
      { jid, folder: group.folder },
      'Deregistered Discord group after channel deletion',
    );
  }

  async probeChannelGone(jid: string): Promise<boolean> {
    if (!this.client) return false;
    const channelId = jid.replace(/^dc:/, '');
    try {
      await this.client.channels.fetch(channelId, { force: true });
      return false;
    } catch (err) {
      return err instanceof DiscordAPIError && err.code === 10003;
    }
  }

  async backfillRegistrations(): Promise<void> {
    if (!this.client) return;
    let walked = 0;
    let registered = 0;
    let guildsScanned = 0;

    // Iterate every guild the bot is in and force-fetch its full channel
    // listing. Use the fetch return value (Collection) directly instead of
    // guild.channels.cache so we don't depend on cache being fully populated.
    for (const [, guild] of this.client.guilds.cache) {
      let allChannels;
      try {
        allChannels = await guild.channels.fetch();
      } catch (err) {
        logger.warn(
          { guildId: guild.id, err: String(err) },
          'guild.channels.fetch failed',
        );
        continue;
      }
      guildsScanned++;

      const diaryTextChannels: TextChannel[] = [];
      for (const [, ch] of allChannels) {
        if (!ch) continue;
        if (ch.type !== ChannelType.GuildText) continue;
        if (!DIARY_CATEGORY_IDS.has(ch.parentId ?? '')) continue;
        diaryTextChannels.push(ch as TextChannel);
      }

      for (const channel of diaryTextChannels) {
        walked++;
        if (await this.ensureGroupRegistered(`dc:${channel.id}`)) registered++;

        try {
          const active = await channel.threads.fetchActive();
          for (const [, thread] of active.threads) {
            walked++;
            if (await this.ensureGroupRegistered(`dc:${thread.id}`))
              registered++;
          }
        } catch (err) {
          logger.debug(
            { channelId: channel.id, err: String(err) },
            'Active thread fetch failed',
          );
        }

        try {
          const archived = await channel.threads.fetchArchived({ limit: 100 });
          for (const [, thread] of archived.threads) {
            walked++;
            if (await this.ensureGroupRegistered(`dc:${thread.id}`))
              registered++;
          }
        } catch (err) {
          logger.debug(
            { channelId: channel.id, err: String(err) },
            'Archived thread fetch failed',
          );
        }
      }
    }

    logger.info(
      { guildsScanned, walked, registered },
      'Diary category walk complete',
    );
  }
}

/** Thread title from the post's first line (Discord caps names at 100). */
function threadNameFor(message: Message, senderName: string): string {
  const firstLine = message.cleanContent.split('\n')[0].trim();
  const name = firstLine || `${senderName}님 요청`;
  return name.length > 90 ? `${name.slice(0, 90)}…` : name;
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, opts);
});
