import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
  ThreadChannel,
} from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
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
  defaultTrigger: () => string;
}

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
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // 다른 봇(music-bot, lavalink 등) 메시지는 무시하되, 자기 자신이 API로
      // 직접 보낸 메시지는 저장해야 한다. container skill(create-diary.sh,
      // post-discord.sh)들이 Discord API를 직접 호출해서 ticket 채널에 완료
      // 메시지를 보내는데, 이걸 DB에 남겨야 업무일지 크론이 집계 가능.
      const myBotId = this.client?.user?.id;
      if (message.author.bot && message.author.id !== myBotId) return;

      const channelId = message.channelId;
      const realJid = `dc:${channelId}`;
      let chatJid = realJid;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();

      // Ticket channel detection: ticket-* channels under the configured
      // ticket category are auto-registered as per-channel groups.
      const ticketChannel =
        this.ticketCategoryId && message.guild
          ? (message.channel as TextChannel)
          : null;
      const isTicketChannel =
        ticketChannel !== null &&
        ticketChannel.parentId === this.ticketCategoryId &&
        (ticketChannel.name?.startsWith('ticket-') ?? false);

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

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
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
              return `[Image: ${att.name || 'image'}]`;
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

      // Store chat metadata for this channel so it appears in the chats table.
      // Must happen before storeMessage (FK constraint: chat_jid in chats).
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        realJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

      // Auto-register per-channel groups. Tickets stay inline (single category,
      // simple shape). Diary registration goes through ensureGroupRegistered
      // so the same idempotent path covers onMessageCreate, host backfill on
      // startup, and the message-loop backstop — no path can silently skip it.
      const allGroups = this.opts.registeredGroups();
      if (!allGroups[realJid] && isTicketChannel) {
        this.opts.registerGroup(
          realJid,
          {
            name: `티켓 #${ticketChannel!.name}`,
            folder: `discord_tickets_ch${channelId}`,
            trigger: this.opts.defaultTrigger(),
            added_at: new Date().toISOString(),
            requiresTrigger: false,
          },
          'discord_tickets',
        );
        logger.info(
          { channelId, channelName: ticketChannel!.name },
          'Auto-registered ticket channel group',
        );
      }
      // Diary: idempotent. No-op if already registered.
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

      // Discord has a 2000 character limit per message — split if needed
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await textChannel.send(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await textChannel.send(text.slice(i, i + MAX_LENGTH));
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
      logger.debug({ chatJid, err: String(err) }, 'ensureGroupRegistered fetch failed');
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
