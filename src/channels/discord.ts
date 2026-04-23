import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
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
}

// Virtual JID for ticket category catchall — all messages from ticket-*
// channels under DISCORD_TICKET_CATEGORY_ID route here.
const TICKET_VIRTUAL_JID = 'dc:tickets';

// Virtual JID for diary category catchall — all messages from dormitory
// diary channels route here when the bot is @mentioned.
const DIARY_VIRTUAL_JID = 'dc:diary';
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

      // Ticket category catchall: rewrite JID to virtual group and tag
      // content with the original channel so the agent can reply correctly.
      // The agent is expected to prefix its response with
      // `[reply-channel:<id>]` — sendMessage() parses and strips that tag.
      const ticketChannel =
        this.ticketCategoryId && message.guild
          ? (message.channel as TextChannel)
          : null;
      const isTicketCatchall =
        ticketChannel !== null &&
        ticketChannel.parentId === this.ticketCategoryId &&
        (ticketChannel.name?.startsWith('ticket-') ?? false);
      if (isTicketCatchall) {
        chatJid = TICKET_VIRTUAL_JID;
      }

      // Diary category catchall: route messages from dormitory diary channels
      // to the virtual diary group so a single agent handles all diary chats.
      const diaryParentId = message.guild
        ? (message.channel as TextChannel).parentId ?? ''
        : '';
      const isDiaryCatchall =
        !isTicketCatchall &&
        message.guild !== null &&
        DIARY_CATEGORY_IDS.has(diaryParentId);
      if (isDiaryCatchall) {
        chatJid = DIARY_VIRTUAL_JID;
      }
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

      // Tag ticket catchall messages with their origin channel so the agent
      // can route its reply back. This runs after all other content munging
      // so the tag is always the leading prefix the agent sees.
      if (isTicketCatchall) {
        content = `[ticket-channel:${channelId} #${ticketChannel!.name}] ${content}`;
      }

      // Tag diary catchall messages with their origin channel.
      if (isDiaryCatchall) {
        const diaryChannelName = (message.channel as TextChannel).name ?? channelId;
        content = `[diary-channel:${channelId} #${diaryChannelName}] ${content}`;
      }

      // Store chat metadata for discovery — always use the real channel JID
      // even when routing through a virtual group (ticket catchall). This keeps
      // each individual ticket channel visible in the chats table / dashboard
      // while the virtual group still owns message processing.
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        realJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

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

    // Ticket catchall: the agent must tag its reply with
    // [reply-channel:<id>] so we know which ticket to respond in.
    // Falling through without a tag would send to a non-existent channel.
    if (jid === TICKET_VIRTUAL_JID) {
      const match = text.match(/^\[reply-channel:(\d+)\]\s*/);
      if (!match) {
        logger.warn(
          { jid, textPreview: text.slice(0, 120) },
          'Ticket reply missing [reply-channel:<id>] prefix — dropping',
        );
        return;
      }
      jid = `dc:${match[1]}`;
      text = text.slice(match[0].length);
    }

    // Diary catchall: same pattern — agent must prefix reply with [reply-channel:<id>].
    if (jid === DIARY_VIRTUAL_JID) {
      const match = text.match(/^\[reply-channel:(\d+)\]\s*/);
      if (!match) {
        logger.warn(
          { jid, textPreview: text.slice(0, 120) },
          'Diary reply missing [reply-channel:<id>] prefix — dropping',
        );
        return;
      }
      jid = `dc:${match[1]}`;
      text = text.slice(match[0].length);
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
    // Can't target typing indicator at the virtual ticket group since
    // we don't know the real channel until the agent's reply is parsed.
    if (jid === TICKET_VIRTUAL_JID) return;
    if (jid === DIARY_VIRTUAL_JID) return;
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
