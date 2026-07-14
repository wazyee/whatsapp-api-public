import { Router } from 'express';
import { body, param, query } from 'express-validator';
import multer from 'multer';
import { handleValidationErrors, asyncHandler } from '../middleware/errorHandler.js';
import { sessionMiddleware } from '../middleware/auth.js';
import { whatsAppService } from '../app.js';
import { DatabaseService } from '../services/DatabaseService.js';
import { ApiResponse, SendMessageRequest, MessageType } from '../Types/api.js';

const router = Router();
const dbService = new DatabaseService();

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE || '50') * 1024 * 1024, // 50MB default
    files: 1
  },
  fileFilter: (req, file, cb) => {
    // Allow common media types
    const allowedTypes = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'video/mp4', 'video/mpeg', 'video/quicktime',
      'audio/mpeg', 'audio/wav', 'audio/ogg',
      'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ];
    
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('File type not supported'));
    }
  }
});

/**
 * @swagger
 * /api/messages/{sessionId}:
 *   get:
 *     summary: Get messages for a session
 *     tags: [Messages]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: chatId
 *         schema:
 *           type: string
 *         description: Filter by specific chat
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *     responses:
 *       200:
 *         description: Messages retrieved successfully
 */
router.get('/:sessionId', [
  param('sessionId').notEmpty(),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('offset').optional().isInt({ min: 0 }),
  query('since').optional().isString(),
  query('cursor').optional().isString()
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const { chatId, limit = 50, offset = 0, since, cursor } = req.query;

  // since-mode: incremental sync cursor (new messages + status updates),
  // oldest-first with stable id tiebreak. Mutually exclusive with offset.
  if (since || cursor) {
    const sinceDate = parseSince(since as string | undefined);
    if (!sinceDate) {
      return res.status(400).json({
        success: false,
        error: 'Invalid since — use ISO 8601 or unix epoch (seconds or ms)',
        timestamp: new Date().toISOString()
      } as ApiResponse);
    }

    const take = parseInt(limit as string) || 100;
    const messages = await dbService.getMessagesSince(
      sessionId,
      sinceDate,
      chatId as string,
      take,
      cursor as string | undefined
    );

    return res.json({
      success: true,
      data: messages,
      nextCursor: messages.length === take ? messages[messages.length - 1].id : null,
      timestamp: new Date().toISOString()
    } as ApiResponse & { nextCursor: string | null });
  }

  const messages = await dbService.getMessages(
    sessionId,
    chatId as string,
    parseInt(limit as string),
    parseInt(offset as string)
  );

  res.json({
    success: true,
    data: messages,
    timestamp: new Date().toISOString()
  } as ApiResponse);
}));

// Accepts ISO 8601, unix seconds, or unix milliseconds. Cursor pages keep
// filtering on the original since value, so pass it on every page.
function parseSince(raw: string | undefined): Date | null {
  if (!raw) return new Date(0); // cursor without since: no lower bound
  if (/^\d+$/.test(raw)) {
    const n = parseInt(raw, 10);
    return new Date(n < 1e12 ? n * 1000 : n);
  }
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

// ---------- Message delivery status (polling endpoints) ----------

/**
 * @swagger
 * /api/messages/{sessionId}/by-id/{messageId}/status:
 *   get:
 *     summary: Get delivery status + transition timestamps for one message
 *     tags: [Messages]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: messageId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Status snapshot
 *       404:
 *         description: Message not found
 */
router.get('/:sessionId/by-id/:messageId/status', [
  param('sessionId').notEmpty(),
  param('messageId').notEmpty()
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId, messageId } = req.params;
  const msg = await dbService.getMessageByMessageId(sessionId, messageId);
  if (!msg) {
    res.status(404).json({
      success: false,
      error: 'Message not found',
      timestamp: new Date().toISOString()
    } as ApiResponse);
    return;
  }
  res.json({
    success: true,
    data: {
      messageId: msg.messageId,
      toJid: msg.toJid,
      fromMe: msg.fromMe,
      status: msg.status,
      timestamp: msg.timestamp,
      sentAt: msg.sentAt,
      deliveredAt: msg.deliveredAt,
      readAt: msg.readAt,
      failedAt: msg.failedAt,
      updatedAt: msg.updatedAt
    },
    timestamp: new Date().toISOString()
  } as ApiResponse);
}));

/**
 * @swagger
 * /api/messages/{sessionId}/status/bulk:
 *   post:
 *     summary: Bulk fetch delivery status for up to 200 message IDs
 *     tags: [Messages]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ids]
 *             properties:
 *               ids:
 *                 type: array
 *                 items: { type: string }
 *                 maxItems: 200
 *     responses:
 *       200:
 *         description: Map of messageId to status snapshot
 */
router.post('/:sessionId/status/bulk', [
  param('sessionId').notEmpty(),
  body('ids').isArray({ min: 1, max: 200 })
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const ids = (req.body?.ids ?? []).filter((x: unknown): x is string => typeof x === 'string' && x.length > 0);
  if (ids.length === 0) {
    res.status(400).json({ success: false, error: 'ids must contain at least one non-empty string', timestamp: new Date().toISOString() } as ApiResponse);
    return;
  }
  const rows = await dbService.getMessageStatusesBulk(sessionId, ids);
  const byId: Record<string, any> = {};
  for (const r of rows) byId[r.messageId] = r;
  const result = ids.map(id => byId[id] ?? { messageId: id, status: null, notFound: true });
  res.json({
    success: true,
    data: result,
    timestamp: new Date().toISOString()
  } as ApiResponse);
}));

/**
 * @swagger
 * /api/messages/{sessionId}/stuck:
 *   get:
 *     summary: List outbound messages that have not transitioned past a given status
 *     description: Defaults to SENT older than 10 minutes. Use to find "Waiting for this message" candidates and route them to an alternative channel.
 *     tags: [Messages]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [PENDING, SENT, DELIVERED]
 *       - in: query
 *         name: olderThanMinutes
 *         schema: { type: integer, minimum: 1, maximum: 10080 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 500 }
 *     responses:
 *       200:
 *         description: List of stuck messages
 */
router.get('/:sessionId/stuck', [
  param('sessionId').notEmpty(),
  query('status').optional().isIn(['PENDING', 'SENT', 'DELIVERED']),
  query('olderThanMinutes').optional().isInt({ min: 1, max: 10080 }),
  query('limit').optional().isInt({ min: 1, max: 500 })
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const status = (req.query.status as string) || 'SENT';
  const olderThanMinutes = req.query.olderThanMinutes ? parseInt(req.query.olderThanMinutes as string) : 10;
  const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;
  const rows = await dbService.getStuckMessages(sessionId, { status, olderThanMinutes, limit });
  res.json({
    success: true,
    data: rows,
    meta: { status, olderThanMinutes, count: rows.length },
    timestamp: new Date().toISOString()
  } as ApiResponse);
}));

/**
 * @swagger
 * /api/messages/{sessionId}/send:
 *   post:
 *     summary: Send a text message
 *     tags: [Messages]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - to
 *               - content
 *             properties:
 *               to:
 *                 type: string
 *                 description: Recipient JID
 *               content:
 *                 type: object
 *                 properties:
 *                   text:
 *                     type: string
 *               options:
 *                 type: object
 *                 properties:
 *                   quoted:
 *                     type: string
 *                   mentions:
 *                     type: array
 *                     items:
 *                       type: string
 *     responses:
 *       200:
 *         description: Message sent successfully
 */
router.post('/:sessionId/send', [
  param('sessionId').notEmpty(),
  body('to').notEmpty().trim(),
  // deletes carry no text; edits and plain sends must
  body('content.text').if(body('options.delete').not().exists()).notEmpty().trim(),
  body('options.quoted').optional().isString(),
  body('options.mentions').optional().isArray(),
  body('options.edit').optional().isString(),
  body('options.delete').optional().isString()
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const { to, content, options = {} } = req.body;

  try {
    const messageContent: any = { text: content.text };
    
    if (options.quoted) {
      messageContent.quoted = options.quoted;
    }
    
    if (options.mentions && options.mentions.length > 0) {
      messageContent.mentions = options.mentions;
    }

    if (options.edit) {
      messageContent.edit = options.edit;
    }

    if (options.delete) {
      messageContent.delete = options.delete;
    }

    const result = await whatsAppService.sendMessage(sessionId, to, messageContent);

    res.json({
      success: true,
      data: result,
      message: 'Message sent successfully',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }
}));

/**
 * @swagger
 * /api/messages/{sessionId}/send-media:
 *   post:
 *     summary: Send a media message
 *     tags: [Messages]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - to
 *               - file
 *             properties:
 *               to:
 *                 type: string
 *               file:
 *                 type: string
 *                 format: binary
 *               caption:
 *                 type: string
 *               fileName:
 *                 type: string
 *     responses:
 *       200:
 *         description: Media message sent successfully
 */
router.post('/:sessionId/send-media', upload.single('file') as any, [
  param('sessionId').notEmpty(),
  body('to').notEmpty().trim(),
  body('caption').optional().trim(),
  body('fileName').optional().trim()
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const { to, caption, fileName } = req.body;
  const file = req.file;

  if (!file) {
    return res.status(400).json({
      success: false,
      error: 'No file uploaded',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }

  try {
    let messageContent: any;
    const mediaBuffer = file.buffer;
    const mimetype = file.mimetype;

    if (mimetype.startsWith('image/')) {
      messageContent = {
        image: mediaBuffer,
        caption,
        fileName: fileName || file.originalname
      };
    } else if (mimetype.startsWith('video/')) {
      messageContent = {
        video: mediaBuffer,
        caption,
        fileName: fileName || file.originalname
      };
    } else if (mimetype.startsWith('audio/')) {
      messageContent = {
        audio: mediaBuffer,
        fileName: fileName || file.originalname,
        mimetype
      };
    } else {
      messageContent = {
        document: mediaBuffer,
        fileName: fileName || file.originalname,
        mimetype
      };
    }

    const result = await whatsAppService.sendMessage(sessionId, to, messageContent);

    res.json({
      success: true,
      data: result,
      message: 'Media message sent successfully',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }
}));

/**
 * @swagger
 * /api/messages/{sessionId}/send-location:
 *   post:
 *     summary: Send a location message
 *     tags: [Messages]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - to
 *               - latitude
 *               - longitude
 *             properties:
 *               to:
 *                 type: string
 *               latitude:
 *                 type: number
 *               longitude:
 *                 type: number
 *               name:
 *                 type: string
 *               address:
 *                 type: string
 *     responses:
 *       200:
 *         description: Location message sent successfully
 */
router.post('/:sessionId/send-location', [
  param('sessionId').notEmpty(),
  body('to').notEmpty().trim(),
  body('latitude').isFloat({ min: -90, max: 90 }),
  body('longitude').isFloat({ min: -180, max: 180 }),
  body('name').optional().trim(),
  body('address').optional().trim()
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const { to, latitude, longitude, name, address } = req.body;

  try {
    const messageContent = {
      location: {
        degreesLatitude: latitude,
        degreesLongitude: longitude,
        name,
        address
      }
    };

    const result = await whatsAppService.sendMessage(sessionId, to, messageContent);

    res.json({
      success: true,
      data: result,
      message: 'Location message sent successfully',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }
}));

/**
 * @swagger
 * /api/messages/{sessionId}/send-reaction:
 *   post:
 *     summary: Send a reaction to a message
 *     tags: [Messages]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - to
 *               - messageId
 *               - emoji
 *             properties:
 *               to:
 *                 type: string
 *               messageId:
 *                 type: string
 *               emoji:
 *                 type: string
 *     responses:
 *       200:
 *         description: Reaction sent successfully
 */
router.post('/:sessionId/send-reaction', [
  param('sessionId').notEmpty(),
  body('to').notEmpty().trim(),
  body('messageId').notEmpty().trim(),
  body('emoji').notEmpty().trim()
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const { to, messageId, emoji } = req.body;

  try {
    const messageContent = {
      react: {
        text: emoji,
        key: {
          remoteJid: to,
          id: messageId
        }
      }
    };

    const result = await whatsAppService.sendMessage(sessionId, to, messageContent);

    res.json({
      success: true,
      data: result,
      message: 'Reaction sent successfully',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }
}));

export default router;
