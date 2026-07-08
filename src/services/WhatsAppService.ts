import { Server as SocketIOServer } from 'socket.io';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  proto,
  type AnyMessageContent,
  type WASocket,
  type ConnectionState,
} from '@whiskeysockets/baileys';
import createHttpsProxyAgent from 'https-proxy-agent';
import { createHash } from 'node:crypto';
import NodeCache from '@cacheable/node-cache';
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import { join } from 'path';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { logger, whatsappLogger } from '../Utils/apiLogger.js';
import { DatabaseService } from './DatabaseService.js';
import { WebhookService } from './WebhookService.js';
import { WhatsAppSession, SessionStatus } from '../Types/api.js';

// Baileys WAMessageStatus → Prisma MessageStatus enum
// Prisma enum: PENDING, SENT, DELIVERED, READ, FAILED
const BAILEYS_STATUS_TO_PRISMA: Record<number, string> = {
  0: 'FAILED',     // ERROR
  1: 'PENDING',    // PENDING (sending)
  2: 'SENT',       // SERVER_ACK (sent to WA server)
  3: 'DELIVERED',  // DELIVERY_ACK (delivered to recipient)
  4: 'READ',       // READ
  5: 'READ',       // PLAYED (audio played — collapse to READ for now)
};

export class WhatsAppService {
  private sessions: Map<string, WhatsAppSession> = new Map();
  private io: SocketIOServer;
  private dbService: DatabaseService;
  private webhookService: WebhookService;

  constructor(io: SocketIOServer) {
    this.io = io;
    this.dbService = new DatabaseService();
    this.webhookService = new WebhookService();

    const authDir = join(process.cwd(), 'auth_sessions');
    if (!existsSync(authDir)) {
      mkdirSync(authDir, { recursive: true });
    }
  }

  async createSession(sessionId: string, userId: string, usePairingCode = false): Promise<WhatsAppSession> {
    try {
      if (this.sessions.has(sessionId)) {
        throw new Error('Session already exists');
      }

      await this.dbService.createSession({ sessionId, userId });

      const session: WhatsAppSession = {
        id: sessionId,
        socket: null,
        status: SessionStatus.CONNECTING,
        lastSeen: new Date(),
      };

      this.sessions.set(sessionId, session);
      await this.initializeWhatsAppConnection(sessionId, usePairingCode);
      return session;
    } catch (error) {
      whatsappLogger.error(`Failed to create session ${sessionId}:`, error);
      throw error;
    }
  }

  // ponytail: re-establish previously-paired sessions on boot. Without this, any
  // process restart leaves sockets dead (DB shows stale CONNECTED) until something
  // manually hits /reconnect — that's what left both sessions ~20h offline.
  async restoreSessions(): Promise<void> {
    const rows = await this.dbService.getAllActiveSessions();
    for (const row of rows) {
      const authDir = join(process.cwd(), 'auth_sessions', row.sessionId);
      if (!existsSync(join(authDir, 'creds.json'))) continue; // skip never-paired
      try {
        this.sessions.set(row.sessionId, {
          id: row.sessionId,
          socket: null,
          status: SessionStatus.CONNECTING,
          lastSeen: new Date(),
        });
        await this.initializeWhatsAppConnection(row.sessionId, false);
        whatsappLogger.info({ sessionId: row.sessionId }, 'restoreSessions: re-initialized on boot');
        await new Promise((r) => setTimeout(r, 2000)); // stagger to avoid a connect burst
      } catch (err) {
        whatsappLogger.error({ err, sessionId: row.sessionId }, 'restoreSessions: failed');
      }
    }
  }

  async reconnectSession(sessionId: string): Promise<WhatsAppSession> {
    try {
      const dbSession = await this.dbService.getSession(sessionId);
      if (!dbSession) {
        throw new Error('Session not found in database');
      }

      if (this.sessions.has(sessionId)) {
        const existing = this.sessions.get(sessionId)!;
        if (existing.socket) {
          existing.socket.end(undefined);
        }
        this.sessions.delete(sessionId);
      }

      const session: WhatsAppSession = {
        id: sessionId,
        socket: null,
        status: SessionStatus.CONNECTING,
        lastSeen: new Date(),
      };

      this.sessions.set(sessionId, session);
      await this.initializeWhatsAppConnection(sessionId, false);

      whatsappLogger.info(`Session ${sessionId} reconnection initiated`);
      return session;
    } catch (error) {
      whatsappLogger.error(`Failed to reconnect session ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Build a per-session proxy agent. Each WhatsApp session gets its own stable,
   * country-matched residential exit IP via an Evomi sticky session keyed off the
   * sessionId — distinct IP per number, consistent across reconnects. Anti-ban.
   * Sticky params live in the password: _country-XX _session-<id> _lifetime-<min,max 1440>.
   */
  // Cache of LID -> phone-number per session, sourced from Baileys' auth store.
  private lidPnCache = new Map<string, Map<string, string>>();

  /** Resolve a bare LID to its phone number via auth_sessions/<id>/lid-mapping-<lid>_reverse.json (cached). */
  private pnForLid(sessionId: string, lid: string): string | null {
    let m = this.lidPnCache.get(sessionId);
    if (!m) { m = new Map(); this.lidPnCache.set(sessionId, m); }
    const hit = m.get(lid);
    if (hit !== undefined) return hit || null;
    let pn: string | null = null;
    try {
      const file = join(process.cwd(), 'auth_sessions', sessionId, `lid-mapping-${lid}_reverse.json`);
      if (existsSync(file)) {
        const v = JSON.parse(readFileSync(file, 'utf8'));
        if (typeof v === 'string' && /^\d+$/.test(v)) pn = v;
      }
    } catch { /* mapping not available yet */ }
    m.set(lid, pn || '');
    return pn;
  }

  /**
   * Normalize a @lid JID to the canonical phone JID when the mapping is known.
   * WhatsApp migrates contacts from <phone>@s.whatsapp.net to <lid>@lid; we key
   * everything on the phone JID so one contact stays one thread. Prefers the
   * alt JID carried on the message key, falls back to the auth-store mapping.
   */
  private canonicalJid(sessionId: string, jid?: string | null, altJid?: string | null): string | undefined {
    if (!jid) return undefined;
    if (!jid.endsWith('@lid')) return jid;
    const lid = jid.slice(0, -'@lid'.length);
    if (altJid && altJid.endsWith('@s.whatsapp.net')) {
      let m = this.lidPnCache.get(sessionId);
      if (!m) { m = new Map(); this.lidPnCache.set(sessionId, m); }
      m.set(lid, altJid.split('@')[0]); // learn the mapping for no-alt messages
      return altJid;
    }
    const pn = this.pnForLid(sessionId, lid);
    return pn ? `${pn}@s.whatsapp.net` : jid; // unknown LID-only contact: leave as-is
  }

  private buildProxyAgent(sessionId: string) {
    const base = process.env.WA_PROXY_URL;
    if (!base) return undefined; // ponytail: no proxy configured => direct connection
    const sid = createHash('sha256').update(sessionId).digest('hex').slice(0, 8); // 8 alnum, Evomi wants 6-10
    const country = process.env.WA_PROXY_COUNTRY?.trim();
    const url = new URL(base);
    url.password =
      url.password +
      (country ? `_country-${country}` : '') +
      `_session-${sid}_lifetime-1440`;
    whatsappLogger.info(
      { sessionId, proxySession: sid, country: country || 'any' },
      'WA egress via per-session proxy',
    );
    // ponytail: cast at call site — hpa v5 Agent vs Baileys https.Agent differ structurally but work at runtime
    return createHttpsProxyAgent(url.toString());
  }

  private async initializeWhatsAppConnection(sessionId: string, usePairingCode = false) {
    try {
      const authDir = join(process.cwd(), 'auth_sessions', sessionId);
      const { state, saveCreds } = await useMultiFileAuthState(authDir);
      const { version } = await fetchLatestBaileysVersion();

      const msgRetryCounterCache = new NodeCache();
      const userDevicesCache = new NodeCache();
      const callOfferCache = new NodeCache();
      const groupCache = new NodeCache();

      // Per-session proxy: each WA number egresses from its own stable, geo-matched residential IP (anti-ban)
      const proxyAgent = this.buildProxyAgent(sessionId);

      const socket: WASocket = makeWASocket({
        version,
        agent: proxyAgent as any,
        fetchAgent: proxyAgent as any,
        logger: whatsappLogger as any,
        browser: ['Mac OS', 'Chrome', '14.4.1'], // ponytail: exact string Baileys v7-rc needs for pairing to succeed
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, whatsappLogger as any),
        },
        generateHighQualityLinkPreview: true,
        markOnlineOnConnect: false,
        syncFullHistory: true,
        msgRetryCounterCache: msgRetryCounterCache as any,
        userDevicesCache: userDevicesCache as any,
        callOfferCache: callOfferCache as any,
        cachedGroupMetadata: async (jid: string) => groupCache.get(jid) as any,
        getMessage: async (key) => {
          if (!key.id) return undefined;
          try {
            const stored = await this.dbService.client.message.findUnique({
              where: { sessionId_messageId: { sessionId, messageId: key.id } },
            });
            if (stored?.content) {
              return stored.content as proto.IMessage;
            }
          } catch (err) {
            whatsappLogger.error({ err, key }, 'getMessage lookup failed');
          }
          return undefined;
        },
        patchMessageBeforeSending: async (msg) => {
          try {
            await (socket as any)?.uploadPreKeysToServerIfRequired?.();
          } catch (err) {
            whatsappLogger.warn({ err }, 'uploadPreKeysToServerIfRequired failed');
          }
          return msg;
        },
      });

      const session = this.sessions.get(sessionId)!;
      session.socket = socket;

      socket.ev.on('connection.update', async (update) => {
        await this.handleConnectionUpdate(sessionId, update);
      });

      socket.ev.on('creds.update', saveCreds);

      socket.ev.on('messages.upsert', async (messageUpdate) => {
        await this.handleMessagesUpsert(sessionId, messageUpdate);
      });

      socket.ev.on('messages.update', async (messageUpdates) => {
        await this.handleMessagesUpdate(sessionId, messageUpdates);
      });

      socket.ev.on('chats.upsert', async (chats) => {
        await this.handleChatsUpsert(sessionId, chats);
      });

      // Bulk history sync from the phone — fires after pairing (and on
      // subsequent sync chunks). Persisting this is the ONLY way the chat
      // index ever gets populated on Baileys' multi-device protocol.
      socket.ev.on('messaging-history.set', async (payload: any) => {
        await this.handleMessagingHistorySet(sessionId, payload);
      });

      socket.ev.on('contacts.upsert', async (contacts) => {
        await this.handleContactsUpsert(sessionId, contacts);
      });

      socket.ev.on('groups.upsert', async (groups) => {
        await this.handleGroupsUpsert(sessionId, groups);
        for (const group of groups) {
          groupCache.set(group.id, group);
        }
      });

      socket.ev.on('groups.update', async (updates) => {
        for (const update of updates) {
          if (update.id) {
            try {
              const metadata = await socket.groupMetadata(update.id);
              groupCache.set(update.id, metadata);
            } catch (err) {
              whatsappLogger.debug({ err, groupId: update.id }, 'failed to refresh group metadata');
            }
          }
        }
      });

      // LID-mapping events (Baileys v7) — log so we can confirm protocol upgrades work.
      // Baileys handles LID routing internally; we just want visibility for now.
      (socket.ev as any).on?.('lid-mapping.update', (mapping: any) => {
        whatsappLogger.info({ mapping }, 'lid-mapping.update');
      });

      if (usePairingCode && !socket.authState.creds.registered) {
        session.status = SessionStatus.PAIRING_REQUIRED;
        await this.updateSessionInDatabase(sessionId, { status: 'PAIRING_REQUIRED' });
        this.emitSessionUpdate(sessionId);
      }
    } catch (error) {
      whatsappLogger.error(`Failed to initialize WhatsApp connection for ${sessionId}:`, error);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.status = SessionStatus.ERROR;
        await this.updateSessionInDatabase(sessionId, { status: 'ERROR' });
        this.emitSessionUpdate(sessionId);
      }
      throw error;
    }
  }

  private async handleConnectionUpdate(sessionId: string, update: Partial<ConnectionState>) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const { connection, lastDisconnect, qr } = update;
    whatsappLogger.info({ connection, reason: lastDisconnect?.error?.message, statusCode: (lastDisconnect?.error as Boom)?.output?.statusCode }, `Connection update for ${sessionId}`);

    if (qr) {
      try {
        const qrCodeDataURL = await QRCode.toDataURL(qr);
        session.qrCode = qrCodeDataURL;
        session.status = SessionStatus.QR_REQUIRED;
        await this.updateSessionInDatabase(sessionId, { status: 'QR_REQUIRED', qrCode: qrCodeDataURL });
        this.emitSessionUpdate(sessionId);
      } catch (error) {
        whatsappLogger.error(`Failed to generate QR code for ${sessionId}:`, error);
      }
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      // ponytail: reconnect on everything except a real logout (401). The earlier
      // device_removed storm was the rc13 browser-string bug (now fixed); gating on
      // creds.registered wrongly stranded live registered sessions (~20h offline).
      // 515 restartRequired (post-pairing handshake) is covered: 515 !== 401.
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        whatsappLogger.info(`Reconnecting session ${sessionId}`);
        session.status = SessionStatus.CONNECTING;
        await this.updateSessionInDatabase(sessionId, { status: 'CONNECTING' });
        this.emitSessionUpdate(sessionId);
        setTimeout(() => {
          this.initializeWhatsAppConnection(sessionId);
        }, 5000);
      } else {
        whatsappLogger.info(`Session ${sessionId} logged out`);
        session.status = SessionStatus.DISCONNECTED;
        await this.updateSessionInDatabase(sessionId, { status: 'DISCONNECTED' });
        this.emitSessionUpdate(sessionId);
      }
    } else if (connection === 'open') {
      whatsappLogger.info(`Session ${sessionId} connected`);
      session.status = SessionStatus.CONNECTED;
      session.lastSeen = new Date();
      session.qrCode = undefined;
      session.pairingCode = undefined;

      const user = session.socket?.user;
      if (user) {
        session.phoneNumber = user.id.split(':')[0];
        session.name = user.name;
      }

      await this.updateSessionInDatabase(sessionId, {
        status: 'CONNECTED',
        phoneNumber: session.phoneNumber,
        name: session.name,
        lastSeen: session.lastSeen,
        qrCode: null,
      });
      this.emitSessionUpdate(sessionId);
    }
  }

  private async handleMessagesUpsert(sessionId: string, messageUpdate: any) {
    const { messages, type } = messageUpdate;

    for (const message of messages) {
      try {
        if (!message.message) continue; // skip protocol/control messages with no content

        const chatId = this.canonicalJid(sessionId, message.key.remoteJid, message.key.remoteJidAlt) || message.key.remoteJid!;
        const fromJid = this.canonicalJid(sessionId, message.key.participant || message.key.remoteJid, message.key.participantAlt || message.key.remoteJidAlt) || message.key.participant || message.key.remoteJid;

        await this.dbService.saveMessage({
          messageId: message.key.id!,
          sessionId,
          chatId,
          fromMe: message.key.fromMe || false,
          fromJid,
          toJid: chatId,
          messageType: this.getMessageType(message.message),
          content: message.message,
          timestamp: new Date(Number(message.messageTimestamp ?? Date.now() / 1000) * 1000),
          quotedMessage: message.message?.extendedTextMessage?.contextInfo?.quotedMessage
            ? message.message.extendedTextMessage.contextInfo.stanzaId
            : undefined,
          metadata: { type, pushName: message.pushName, lid: message.key.remoteJid?.endsWith('@lid') ? message.key.remoteJid : undefined },
        });

        // Keep the chats table in sync with messages. Best-effort: a failure
        // here must never block the message save. Mirrors what production
        // Baileys-REST wrappers (ookamiiixd, nizarfadlan, EvolutionAPI) do.
        await this.upsertChatFromMessage(sessionId, message, chatId).catch((err) => {
          whatsappLogger.debug({ err, sessionId, jid: message?.key?.remoteJid }, 'inline chat upsert skipped');
        });

        this.io.emit('message', { sessionId, message, type });
        await this.webhookService.sendWebhook(sessionId, 'message.received', { sessionId, message, type });
      } catch (error) {
        whatsappLogger.error(`Failed to handle message for ${sessionId}:`, error);
      }
    }
  }

  // Resolve a display name from already-populated group/contact rows, then
  // upsert a minimal chat row. Idempotent; returns silently on any failure.
  private async upsertChatFromMessage(sessionId: string, message: any, jid: string): Promise<void> {
    if (!jid) return;
    const isGroup = jid.endsWith('@g.us');
    let name: string | undefined;

    if (isGroup) {
      const grp = await this.dbService.client.group.findUnique({
        where: { sessionId_jid: { sessionId, jid } },
        select: { subject: true },
      }).catch(() => null);
      name = grp?.subject ?? undefined;
    } else {
      const contact = await this.dbService.client.contact.findUnique({
        where: { sessionId_jid: { sessionId, jid } },
        select: { name: true, pushName: true },
      }).catch(() => null);
      name = contact?.name ?? contact?.pushName ?? message?.pushName ?? undefined;
      // Fallback for @lid JIDs: many contacts only join via metadata.lid.
      if (!name && jid.endsWith('@lid')) {
        const lidContact = await this.dbService.client.contact.findFirst({
          where: {
            sessionId,
            metadata: { path: ['lid'], equals: jid },
          },
          select: { name: true, pushName: true },
        }).catch(() => null);
        name = lidContact?.name ?? lidContact?.pushName ?? undefined;
      }
    }

    await this.dbService.upsertChat({
      sessionId,
      jid,
      name,
      isGroup,
      lastMessage: message,
    });
  }

  private async handleMessagesUpdate(sessionId: string, messageUpdates: any[]) {
    for (const update of messageUpdates) {
      try {
        const { key, update: messageUpdate } = update;

        if (messageUpdate.status !== undefined && messageUpdate.status !== null) {
          const statusStr =
            typeof messageUpdate.status === 'number'
              ? BAILEYS_STATUS_TO_PRISMA[messageUpdate.status]
              : String(messageUpdate.status);
          if (statusStr) {
            await this.dbService.updateMessageStatus(key.id!, sessionId, statusStr);
          }
        }

        this.io.emit('messageUpdate', { sessionId, key, update: messageUpdate });
        await this.webhookService.sendWebhook(sessionId, 'message.updated', { sessionId, key, update: messageUpdate });
      } catch (error) {
        whatsappLogger.error(`Failed to handle message update for ${sessionId}:`, error);
      }
    }
  }

  private async handleMessagingHistorySet(
    sessionId: string,
    payload: { chats?: any[]; contacts?: any[]; messages?: any[]; isLatest?: boolean; progress?: number | null; syncType?: number }
  ) {
    const chats = payload.chats ?? [];
    const contacts = payload.contacts ?? [];
    const messages = payload.messages ?? [];
    whatsappLogger.info(
      { sessionId, chats: chats.length, contacts: contacts.length, messages: messages.length, syncType: payload.syncType, isLatest: payload.isLatest, progress: payload.progress },
      'messaging-history.set'
    );

    for (const chat of chats) {
      try {
        if (!chat?.id) continue;
        await this.dbService.upsertChat({
          sessionId,
          jid: this.canonicalJid(sessionId, chat.id) ?? chat.id,
          name: chat.name ?? chat.subject ?? undefined,
          isGroup: String(chat.id).endsWith('@g.us'),
          isArchived: chat.archived || false,
          isPinned: !!chat.pinned,
          isMuted: !!chat.mute,
          unreadCount: chat.unreadCount || 0,
          lastMessage: chat.lastMessage,
          metadata: chat,
        });
      } catch (err) {
        whatsappLogger.warn({ err, sessionId, jid: chat?.id }, 'history-set chat upsert failed');
      }
    }

    for (const contact of contacts) {
      try {
        if (!contact?.id) continue;
        await this.dbService.upsertContact({
          sessionId,
          jid: this.canonicalJid(sessionId, contact.id) ?? contact.id,
          name: contact.name,
          pushName: contact.notify,
          profilePicUrl: contact.imgUrl,
          isBlocked: contact.blocked || false,
          metadata: contact,
        });
      } catch (err) {
        whatsappLogger.warn({ err, sessionId, jid: contact?.id }, 'history-set contact upsert failed');
      }
    }

    for (const message of messages) {
      try {
        if (!message?.key?.id || !message?.message) continue; // skip protocol/control envelopes
        const chatId = this.canonicalJid(sessionId, message.key.remoteJid, message.key.remoteJidAlt) || message.key.remoteJid!;
        const fromJid = this.canonicalJid(sessionId, message.key.participant || message.key.remoteJid, message.key.participantAlt || message.key.remoteJidAlt) || message.key.participant || message.key.remoteJid;

        await this.dbService.saveMessage({
          messageId: message.key.id,
          sessionId,
          chatId,
          fromMe: message.key.fromMe || false,
          fromJid,
          toJid: chatId,
          messageType: this.getMessageType(message.message),
          content: message.message,
          timestamp: new Date(Number(message.messageTimestamp ?? Date.now() / 1000) * 1000),
          quotedMessage: message.message?.extendedTextMessage?.contextInfo?.quotedMessage
            ? message.message.extendedTextMessage.contextInfo.stanzaId
            : undefined,
          metadata: { source: 'history-set', syncType: payload.syncType, pushName: message.pushName },
        });
      } catch (err: any) {
        // Duplicate from prior sync is normal — skip silently. P2002 = Prisma unique violation.
        if (err?.code !== 'P2002') {
          whatsappLogger.warn({ err, sessionId, messageId: message?.key?.id }, 'history-set message save failed');
        }
      }
    }

    whatsappLogger.info({ sessionId }, 'messaging-history.set processing complete');
  }

  private async handleChatsUpsert(sessionId: string, chats: any[]) {
    whatsappLogger.info(`Received ${chats.length} chat(s) for session ${sessionId}`);
    for (const chat of chats) {
      try {
        await this.dbService.upsertChat({
          sessionId,
          jid: chat.id,
          name: chat.name,
          isGroup: chat.id.endsWith('@g.us'),
          isArchived: chat.archived || false,
          isPinned: chat.pinned || false,
          isMuted: chat.mute || false,
          unreadCount: chat.unreadCount || 0,
          lastMessage: chat.lastMessage,
          metadata: chat,
        });
        this.io.emit('chatUpdate', { sessionId, chat });
      } catch (error) {
        whatsappLogger.error(`Failed to handle chat upsert for ${sessionId}:`, error);
      }
    }
  }

  private async handleContactsUpsert(sessionId: string, contacts: any[]) {
    for (const contact of contacts) {
      try {
        await this.dbService.upsertContact({
          sessionId,
          jid: this.canonicalJid(sessionId, contact.id) ?? contact.id,
          name: contact.name,
          pushName: contact.notify,
          profilePicUrl: contact.imgUrl,
          isBlocked: contact.blocked || false,
          metadata: contact,
        });
        this.io.emit('contactUpdate', { sessionId, contact });
      } catch (error) {
        whatsappLogger.error(`Failed to handle contact upsert for ${sessionId}:`, error);
      }
    }
  }

  private async handleGroupsUpsert(sessionId: string, groups: any[]) {
    for (const group of groups) {
      try {
        await this.dbService.client.group.upsert({
          where: { sessionId_jid: { sessionId, jid: group.id } },
          update: {
            subject: group.subject,
            description: group.desc,
            owner: group.owner,
            participants: group.participants,
            settings: group,
            metadata: group,
            updatedAt: new Date(),
          },
          create: {
            sessionId,
            jid: group.id,
            subject: group.subject,
            description: group.desc,
            owner: group.owner,
            participants: group.participants,
            settings: group,
            metadata: group,
          },
        });
        this.io.emit('groupUpdate', { sessionId, group });
      } catch (error) {
        whatsappLogger.error(`Failed to handle group upsert for ${sessionId}:`, error);
      }
    }
  }

  private getMessageType(message: any): string {
    if (message?.conversation) return 'TEXT';
    if (message?.extendedTextMessage) return 'TEXT';
    if (message?.imageMessage) return 'IMAGE';
    if (message?.videoMessage) return 'VIDEO';
    if (message?.audioMessage) return 'AUDIO';
    if (message?.documentMessage) return 'DOCUMENT';
    if (message?.stickerMessage) return 'STICKER';
    if (message?.locationMessage) return 'LOCATION';
    if (message?.contactMessage) return 'CONTACT';
    if (message?.pollCreationMessage) return 'POLL';
    if (message?.reactionMessage) return 'REACTION';
    return 'TEXT';
  }

  private async updateSessionInDatabase(sessionId: string, data: any) {
    try {
      await this.dbService.updateSession(sessionId, data);
    } catch (error) {
      whatsappLogger.error(`Failed to update session ${sessionId} in database:`, error);
    }
  }

  private emitSessionUpdate(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.io.emit('sessionUpdate', {
        sessionId,
        status: session.status,
        qrCode: session.qrCode,
        pairingCode: session.pairingCode,
        phoneNumber: session.phoneNumber,
        name: session.name,
        lastSeen: session.lastSeen,
      });
    }
  }

  async getSession(sessionId: string): Promise<WhatsAppSession | undefined> {
    return this.sessions.get(sessionId);
  }

  async getAllSessions(): Promise<WhatsAppSession[]> {
    return Array.from(this.sessions.values());
  }

  async deleteSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session?.socket) {
      session.socket.end(undefined);
    }
    this.sessions.delete(sessionId);
    await this.dbService.deleteSession(sessionId);
  }

  /**
   * Wipe auth state and force a fresh pairing/history-sync cycle WITHOUT
   * touching userId, phoneNumber, messages, contacts, chats or the session row.
   *
   * Sequence matters:
   *   1. socket.logout() — sends `remove-companion-device` IQ so WhatsApp
   *      releases this device slot (otherwise ghost slots accumulate toward
   *      the 4-device limit).
   *   2. Wait ~1.5s so the IQ flushes on the wire.
   *   3. rm -rf auth_sessions/<sid>/ — clears local auth, which also resets
   *      accountSyncCounter to 0. This is what makes WhatsApp re-push history.
   *   4. Update session row to PAIRING_REQUIRED (NOT delete — preserves all
   *      cascaded rows: messages, contacts, chats).
   *   5. Re-init the socket; with empty auth it'll need QR/pair-code.
   *
   * Idempotent: safe to call on a DISCONNECTED session or one not in the
   * in-memory map.
   */
  async resetSession(sessionId: string): Promise<void> {
    const dbSession = await this.dbService.getSession(sessionId);
    if (!dbSession) throw new Error('Session not found');

    const session = this.sessions.get(sessionId);
    if (session?.socket) {
      try {
        await (session.socket as any).logout?.('force-resync');
      } catch (err) {
        whatsappLogger.warn({ err, sessionId }, 'resetSession: logout failed, falling back to end()');
        try { session.socket.end(undefined); } catch { /* swallow */ }
      }
      // Let the remove-companion-device IQ flush.
      await new Promise((r) => setTimeout(r, 1500));
    }
    this.sessions.delete(sessionId);

    const authDir = join(process.cwd(), 'auth_sessions', sessionId);
    try {
      rmSync(authDir, { recursive: true, force: true });
    } catch (err) {
      whatsappLogger.warn({ err, sessionId, authDir }, 'resetSession: auth dir removal failed');
    }

    await this.updateSessionInDatabase(sessionId, { status: 'PAIRING_REQUIRED' });

    // Re-create the in-memory session and start a fresh socket. The empty
    // auth_sessions dir guarantees the QR/pair-code path is taken again.
    const fresh: WhatsAppSession = {
      id: sessionId,
      status: SessionStatus.PAIRING_REQUIRED,
      lastSeen: new Date(),
    } as any;
    this.sessions.set(sessionId, fresh);
    await this.initializeWhatsAppConnection(sessionId, /* usePairingCode */ true);
    whatsappLogger.info({ sessionId }, 'resetSession: complete, ready for fresh pair');
  }

  async requestPairingCode(sessionId: string, phoneNumber: string): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session?.socket) {
      throw new Error('Session not found or not initialized');
    }

    const code = await session.socket.requestPairingCode(phoneNumber);
    session.pairingCode = code;
    session.phoneNumber = phoneNumber;

    await this.updateSessionInDatabase(sessionId, { pairingCode: code, phoneNumber });
    this.emitSessionUpdate(sessionId);
    return code;
  }

  async sendMessage(sessionId: string, to: string, content: AnyMessageContent): Promise<any> {
    const session = this.sessions.get(sessionId);
    if (!session?.socket) {
      throw new Error('Session not found or not connected');
    }

    if (session.status !== SessionStatus.CONNECTED) {
      throw new Error('Session not connected');
    }

    const normalizedJid = this.normalizeJid(to);
    return await session.socket.sendMessage(normalizedJid, content);
  }

  private normalizeJid(input: string): string {
    const trimmed = input.trim();
    if (trimmed.includes('@')) return trimmed;
    if (/^\d+-\d+$/.test(trimmed)) return `${trimmed}@g.us`;
    return `${trimmed.replace(/[^\d]/g, '')}@s.whatsapp.net`;
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down WhatsApp service...');

    for (const [sessionId, session] of this.sessions) {
      if (session.socket) {
        try {
          session.socket.end(undefined);
        } catch (error) {
          whatsappLogger.error(`Error closing session ${sessionId}:`, error);
        }
      }
    }

    this.sessions.clear();
    await this.dbService.disconnect();
    logger.info('WhatsApp service shutdown complete');
  }
}
