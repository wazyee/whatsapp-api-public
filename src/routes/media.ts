import { Router } from 'express';
import { param } from 'express-validator';
import { handleValidationErrors, asyncHandler } from '../middleware/errorHandler.js';
import { sessionMiddleware } from '../middleware/auth.js';
import { whatsAppService } from '../app.js';
import { DatabaseService } from '../services/DatabaseService.js';
import { ApiResponse } from '../Types/api.js';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { whatsappLogger } from '../Utils/apiLogger.js';

const router = Router();
const dbService = new DatabaseService();

const MEDIA_KEYS = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'];
const BINARY_FIELDS = ['mediaKey', 'fileEncSha256', 'fileSha256'];

function b64ToBuffer(v: any): any {
  if (typeof v === 'string') { try { return Buffer.from(v, 'base64'); } catch { return v; } }
  if (v && typeof v === 'object' && !Buffer.isBuffer(v) && typeof v.length === 'number') {
    try { return Buffer.from(Object.values(v) as number[]); } catch { return v; }
  }
  return v;
}

function unwrap(content: any): any {
  return content?.ephemeralMessage?.message
    || content?.viewOnceMessage?.message
    || content?.viewOnceMessageV2?.message
    || content?.viewOnceMessageV2Extension?.message
    || content;
}

function pickMedia(content: any): { key: string; node: any } | null {
  const c = unwrap(content);
  if (!c || typeof c !== 'object') return null;
  for (const mk of MEDIA_KEYS) if (c[mk]) return { key: mk, node: c[mk] };
  return null;
}

function normalizeContent(content: any): any {
  const c = { ...(unwrap(content) || {}) };
  for (const mk of MEDIA_KEYS) {
    if (c[mk] && typeof c[mk] === 'object') {
      const node: any = { ...c[mk] };
      for (const bf of BINARY_FIELDS) if (node[bf] != null) node[bf] = b64ToBuffer(node[bf]);
      c[mk] = node;
    }
  }
  return c;
}

/**
 * @swagger
 * /api/media/{sessionId}/download/{messageId}:
 *   get:
 *     summary: Download + decrypt the media of a stored message (streams raw bytes)
 *     tags: [Media]
 *     security:
 *       - ApiKeyAuth: []
 */
router.get('/:sessionId/download/:messageId', [
  param('sessionId').notEmpty(),
  param('messageId').notEmpty()
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId, messageId } = req.params;

  const session = await whatsAppService.getSession(sessionId);
  if (!session?.socket) {
    return res.status(400).json({ success: false, error: 'Session not connected', timestamp: new Date().toISOString() } as ApiResponse);
  }

  const msg = await dbService.getMessageByMessageId(sessionId, messageId);
  if (!msg) {
    return res.status(404).json({ success: false, error: 'Message not found', timestamp: new Date().toISOString() } as ApiResponse);
  }

  const media = pickMedia((msg as any).content);
  if (!media) {
    return res.status(415).json({ success: false, error: 'Message has no downloadable media', timestamp: new Date().toISOString() } as ApiResponse);
  }

  const waMessage: any = {
    key: { remoteJid: (msg as any).chatId, fromMe: (msg as any).fromMe, id: (msg as any).messageId, participant: (msg as any).fromJid || undefined },
    message: normalizeContent((msg as any).content),
  };

  try {
    const buffer: Buffer = await downloadMediaMessage(
      waMessage,
      'buffer',
      {},
      { logger: whatsappLogger as any, reuploadRequest: (session.socket as any).updateMediaMessage }
    ) as Buffer;

    const node = media.node || {};
    const mimetype = (typeof node.mimetype === 'string' && node.mimetype) ? node.mimetype.split(';')[0].trim() : 'application/octet-stream';
    const isDoc = media.key === 'documentMessage';
    const fileName = node.fileName || node.title || `${messageId}`;

    res.setHeader('Content-Type', mimetype || 'application/octet-stream');
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('Content-Disposition', `${isDoc ? 'attachment' : 'inline'}; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader('X-Media-Type', media.key);
    return res.end(buffer);
  } catch (error: any) {
    return res.status(410).json({ success: false, error: 'Media unavailable: ' + (error?.message || 'download failed'), timestamp: new Date().toISOString() } as ApiResponse);
  }
}));

export default router;
