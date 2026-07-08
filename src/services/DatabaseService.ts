import { PrismaClient } from '@prisma/client';
import { logger } from '../Utils/apiLogger.js';

export class DatabaseService {
  private prisma: PrismaClient<{
    log: [
      { emit: 'event'; level: 'query' },
      { emit: 'event'; level: 'error' },
      { emit: 'event'; level: 'info' },
      { emit: 'event'; level: 'warn' }
    ]
  }>;

  constructor() {
    this.prisma = new PrismaClient({
      log: [
        {
          emit: 'event',
          level: 'query',
        },
        {
          emit: 'event',
          level: 'error',
        },
        {
          emit: 'event',
          level: 'info',
        },
        {
          emit: 'event',
          level: 'warn',
        },
      ],
    });

    // Log database queries in development
    if (process.env.NODE_ENV === 'development') {
      this.prisma.$on('query', (e: { query: string; params: string; duration: number }) => {
        logger.debug({
          query: e.query,
          params: e.params,
          duration: e.duration
        }, 'Database Query');
      });
    }

    this.prisma.$on('error', (e: { message: string; target: string }) => {
      logger.error({
        target: e.target,
        message: e.message
      }, 'Database Error');
    });

    this.prisma.$on('info', (e: { message: string; target: string }) => {
      logger.info({
        target: e.target,
        message: e.message
      }, 'Database Info');
    });

    this.prisma.$on('warn', (e: { message: string; target: string }) => {
      logger.warn({
        target: e.target,
        message: e.message
      }, 'Database Warning');
    });
  }

  async connect() {
    try {
      await this.prisma.$connect();
      logger.info('Database connected successfully');
    } catch (error) {
      logger.error('Failed to connect to database:', error);
      throw error;
    }
  }

  async disconnect() {
    try {
      await this.prisma.$disconnect();
      logger.info('Database disconnected successfully');
    } catch (error) {
      logger.error('Failed to disconnect from database:', error);
      throw error;
    }
  }

  // User operations
  async createUser(data: {
    email: string;
    name?: string;
    password: string;
    role?: 'USER' | 'ADMIN';
  }) {
    return this.prisma.user.create({
      data,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        apiKey: true,
        isActive: true,
        createdAt: true
      }
    });
  }

  async getUserByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email },
      include: {
        sessions: {
          where: { isActive: true },
          select: {
            id: true,
            sessionId: true,
            status: true,
            phoneNumber: true,
            name: true,
            lastSeen: true
          }
        }
      }
    });
  }

  async getUserByApiKey(apiKey: string) {
    return this.prisma.user.findUnique({
      where: { apiKey },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        apiKey: true,
        isActive: true
      }
    });
  }

  // Session operations
  async createSession(data: {
    sessionId: string;
    userId: string;
    phoneNumber?: string;
    name?: string;
  }) {
    // ponytail: upsert, not create — deleteSession soft-deletes (isActive:false)
    // so the row persists; a plain create() then throws P2002 on restart/re-pair.
    return this.prisma.session.upsert({
      where: { sessionId: data.sessionId },
      create: data,
      update: {},
    });
  }

  async updateSession(sessionId: string, data: any) {
    return this.prisma.session.update({
      where: { sessionId },
      data
    });
  }

  async getSession(sessionId: string) {
    return this.prisma.session.findUnique({
      where: { sessionId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true
          }
        }
      }
    });
  }

  async getUserSessions(userId: string) {
    return this.prisma.session.findMany({
      where: { userId, isActive: true },
      orderBy: { lastSeen: 'desc' }
    });
  }

  async getAllActiveSessions() {
    return this.prisma.session.findMany({ where: { isActive: true } });
  }

  async deleteSession(sessionId: string) {
    return this.prisma.session.update({
      where: { sessionId },
      data: { isActive: false }
    });
  }

  // Message operations
  async saveMessage(data: {
    messageId: string;
    sessionId: string;
    chatId: string;
    fromMe: boolean;
    fromJid?: string;
    toJid: string;
    messageType: string;
    content: any;
    timestamp: Date;
    quotedMessage?: string;
    metadata?: any;
  }) {
    return this.prisma.message.create({
      data: {
        ...data,
        messageType: data.messageType as any
      }
    });
  }

  async updateMessageStatus(messageId: string, sessionId: string, status: string) {
    const now = new Date();
    const data: Record<string, unknown> = { status: status as any };
    if (status === 'SENT') data.sentAt = now;
    else if (status === 'DELIVERED') data.deliveredAt = now;
    else if (status === 'READ') data.readAt = now;
    else if (status === 'FAILED') data.failedAt = now;

    // Preserve first-occurrence semantics: don't overwrite an already-set transition timestamp.
    const existing = await this.prisma.message.findFirst({
      where: { messageId, sessionId },
      select: { sentAt: true, deliveredAt: true, readAt: true, failedAt: true },
    });
    if (existing) {
      if (existing.sentAt && data.sentAt !== undefined) delete data.sentAt;
      if (existing.deliveredAt && data.deliveredAt !== undefined) delete data.deliveredAt;
      if (existing.readAt && data.readAt !== undefined) delete data.readAt;
      if (existing.failedAt && data.failedAt !== undefined) delete data.failedAt;
      // Backfill sentAt when DELIVERED arrives without a prior SENT signal.
      if (status === 'DELIVERED' && !existing.sentAt && data.sentAt === undefined) {
        data.sentAt = now;
      }
    }

    return this.prisma.message.updateMany({
      where: { messageId, sessionId },
      data: data as any,
    });
  }

  async getMessageByMessageId(sessionId: string, messageId: string) {
    return this.prisma.message.findUnique({
      where: { sessionId_messageId: { sessionId, messageId } },
    });
  }

  async getMessageStatusesBulk(sessionId: string, messageIds: string[]) {
    if (messageIds.length === 0) return [];
    return this.prisma.message.findMany({
      where: { sessionId, messageId: { in: messageIds } },
      select: {
        messageId: true,
        status: true,
        toJid: true,
        fromMe: true,
        timestamp: true,
        sentAt: true,
        deliveredAt: true,
        readAt: true,
        failedAt: true,
        updatedAt: true,
      },
    });
  }

  async getStuckMessages(sessionId: string, options: {
    status?: string;
    olderThanMinutes?: number;
    limit?: number;
  } = {}) {
    const olderThan = options.olderThanMinutes ?? 10;
    const cutoff = new Date(Date.now() - olderThan * 60_000);
    return this.prisma.message.findMany({
      where: {
        sessionId,
        fromMe: true,
        status: (options.status ?? 'SENT') as any,
        timestamp: { lt: cutoff },
      },
      select: {
        messageId: true,
        toJid: true,
        status: true,
        timestamp: true,
        sentAt: true,
        deliveredAt: true,
        readAt: true,
        failedAt: true,
        updatedAt: true,
      },
      orderBy: { timestamp: 'desc' },
      take: options.limit ?? 100,
    });
  }

  async getMessages(sessionId: string, chatId?: string, limit = 50, offset = 0) {
    return this.prisma.message.findMany({
      where: {
        sessionId,
        ...(chatId && { chatId })
      },
      orderBy: { timestamp: 'desc' },
      take: limit,
      skip: offset
    });
  }

  // Chat operations
  async upsertChat(data: {
    sessionId: string;
    jid: string;
    name?: string;
    isGroup: boolean;
    isArchived?: boolean;
    isPinned?: boolean;
    isMuted?: boolean;
    unreadCount?: number;
    lastMessage?: any;
    metadata?: any;
  }) {
    return this.prisma.chat.upsert({
      where: {
        sessionId_jid: {
          sessionId: data.sessionId,
          jid: data.jid
        }
      },
      update: {
        name: data.name,
        isArchived: data.isArchived,
        isPinned: data.isPinned,
        isMuted: data.isMuted,
        unreadCount: data.unreadCount,
        lastMessage: data.lastMessage,
        metadata: data.metadata,
        updatedAt: new Date()
      },
      create: data
    });
  }

  async getChats(sessionId: string) {
    return this.prisma.chat.findMany({
      where: { sessionId },
      orderBy: { updatedAt: 'desc' }
    });
  }

  // Contact operations
  async upsertContact(data: {
    sessionId: string;
    jid: string;
    name?: string;
    pushName?: string;
    profilePicUrl?: string;
    isBlocked?: boolean;
    metadata?: any;
  }) {
    return this.prisma.contact.upsert({
      where: {
        sessionId_jid: {
          sessionId: data.sessionId,
          jid: data.jid
        }
      },
      update: {
        name: data.name,
        pushName: data.pushName,
        profilePicUrl: data.profilePicUrl,
        isBlocked: data.isBlocked,
        metadata: data.metadata,
        updatedAt: new Date()
      },
      create: data
    });
  }

  async getContacts(sessionId: string) {
    return this.prisma.contact.findMany({
      where: { sessionId },
      orderBy: { name: 'asc' }
    });
  }

  // Webhook operations
  async createWebhook(data: {
    userId: string;
    url: string;
    events: string[];
    secret?: string;
    maxRetries?: number;
  }) {
    return this.prisma.webhook.create({
      data
    });
  }

  async getUserWebhooks(userId: string) {
    return this.prisma.webhook.findMany({
      where: { userId, isActive: true }
    });
  }

  async updateWebhook(id: string, data: any) {
    return this.prisma.webhook.update({
      where: { id },
      data
    });
  }

  async deleteWebhook(id: string) {
    return this.prisma.webhook.update({
      where: { id },
      data: { isActive: false }
    });
  }

  // API Usage operations
  async getApiUsageStats(userId: string, startDate: Date, endDate: Date) {
    return this.prisma.apiUsage.groupBy({
      by: ['endpoint', 'method'],
      where: {
        userId,
        timestamp: {
          gte: startDate,
          lte: endDate
        }
      },
      _count: {
        id: true
      },
      _avg: {
        duration: true
      }
    });
  }

  async getDashboardStats(userId?: string) {
    const where = userId ? { userId } : {};

    const [
      totalSessions,
      activeSessions,
      totalMessages,
      messagesLast24h,
      totalUsers,
      apiCallsLast24h
    ] = await Promise.all([
      this.prisma.session.count({ where: { ...where, isActive: true } }),
      this.prisma.session.count({
        where: {
          ...where,
          isActive: true,
          status: 'CONNECTED'
        }
      }),
      this.prisma.message.count({
        where: userId ? { session: { userId } } : {}
      }),
      this.prisma.message.count({
        where: {
          ...(userId && { session: { userId } }),
          timestamp: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000)
          }
        }
      }),
      userId ? 1 : this.prisma.user.count({ where: { isActive: true } }),
      this.prisma.apiUsage.count({
        where: {
          ...where,
          timestamp: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000)
          }
        }
      })
    ]);

    return {
      totalSessions,
      activeSessions,
      totalMessages,
      messagesLast24h,
      totalUsers,
      apiCallsLast24h
    };
  }

  get client() {
    return this.prisma;
  }
}
