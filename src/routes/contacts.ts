import { Router } from 'express';
import { param } from 'express-validator';
import { handleValidationErrors, asyncHandler } from '../middleware/errorHandler.js';
import { sessionMiddleware } from '../middleware/auth.js';
import { whatsAppService } from '../app.js';
import { DatabaseService } from '../services/DatabaseService.js';
import { ApiResponse } from '../Types/api.js';

const router = Router();
const dbService = new DatabaseService();

/**
 * @swagger
 * /api/contacts/{sessionId}:
 *   get:
 *     summary: Get all contacts for a session
 *     tags: [Contacts]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Contacts retrieved successfully
 */
router.get('/:sessionId', [
  param('sessionId').notEmpty()
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId } = req.params;

  const contacts = await dbService.getContacts(sessionId);

  res.json({
    success: true,
    data: contacts,
    timestamp: new Date().toISOString()
  } as ApiResponse);
}));

/**
 * @swagger
 * /api/contacts/{sessionId}/{contactId}/profile-picture:
 *   get:
 *     summary: Get contact profile picture
 *     tags: [Contacts]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: contactId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Profile picture URL retrieved successfully
 */
router.get('/:sessionId/:contactId/profile-picture', [
  param('sessionId').notEmpty(),
  param('contactId').notEmpty()
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId, contactId } = req.params;

  const session = await whatsAppService.getSession(sessionId);
  if (!session?.socket) {
    return res.status(400).json({
      success: false,
      error: 'Session not connected',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }

  try {
    const profilePicUrl = await session.socket.profilePictureUrl(contactId, 'image');

    res.json({
      success: true,
      data: { profilePicUrl },
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
 * /api/contacts/{sessionId}/{contactId}/presence:
 *   get:
 *     summary: Get contact presence status
 *     tags: [Contacts]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: contactId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Presence status retrieved successfully
 */
router.get('/:sessionId/:contactId/presence', [
  param('sessionId').notEmpty(),
  param('contactId').notEmpty()
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId, contactId } = req.params;

  const session = await whatsAppService.getSession(sessionId);
  if (!session?.socket) {
    return res.status(400).json({
      success: false,
      error: 'Session not connected',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }

  try {
    await session.socket.presenceSubscribe(contactId);

    res.json({
      success: true,
      message: 'Presence subscription initiated',
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
 * /api/contacts/{sessionId}/{contactId}/block:
 *   post:
 *     summary: Block a contact
 *     tags: [Contacts]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: contactId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Contact blocked successfully
 */
router.post('/:sessionId/:contactId/block', [
  param('sessionId').notEmpty(),
  param('contactId').notEmpty()
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId, contactId } = req.params;

  const session = await whatsAppService.getSession(sessionId);
  if (!session?.socket) {
    return res.status(400).json({
      success: false,
      error: 'Session not connected',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }

  try {
    await session.socket.updateBlockStatus(contactId, 'block');

    res.json({
      success: true,
      message: 'Contact blocked successfully',
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
 * /api/contacts/{sessionId}/{contactId}/unblock:
 *   post:
 *     summary: Unblock a contact
 *     tags: [Contacts]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: contactId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Contact unblocked successfully
 */
router.post('/:sessionId/:contactId/unblock', [
  param('sessionId').notEmpty(),
  param('contactId').notEmpty()
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId, contactId } = req.params;

  const session = await whatsAppService.getSession(sessionId);
  if (!session?.socket) {
    return res.status(400).json({
      success: false,
      error: 'Session not connected',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }

  try {
    await session.socket.updateBlockStatus(contactId, 'unblock');

    res.json({
      success: true,
      message: 'Contact unblocked successfully',
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
 * /api/contacts/{sessionId}/list-from-messages:
 *   get:
 *     summary: Get contacts discovered from messages
 *     tags: [Contacts]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Contacts list retrieved successfully
 */
router.get('/:sessionId/list-from-messages', [
  param('sessionId').notEmpty()
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId } = req.params;

  // Get unique contact JIDs from messages (excluding groups and status)
  const messages = await dbService.getMessages(sessionId);
  const contactJids = [...new Set(
    messages
      .filter(m => m.chatId.endsWith('@s.whatsapp.net'))
      .map(m => m.chatId)
  )];

  if (contactJids.length === 0) {
    return res.json({
      success: true,
      data: [],
      message: 'No contacts found in messages',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }

  const session = await whatsAppService.getSession(sessionId);
  if (!session?.socket) {
    return res.status(400).json({
      success: false,
      error: 'Session not connected',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }

  try {
    // Fetch profile info for each contact
    const contacts = await Promise.all(
      contactJids.map(async (jid) => {
        try {
          // Extract phone number from JID
          const phoneNumber = jid.split('@')[0];

          // Try to get profile picture
          let profilePicUrl: string | null = null;
          try {
            const picUrl = await session.socket!.profilePictureUrl(jid, 'image');
            profilePicUrl = picUrl || null;
          } catch (err) {
            // Profile picture not available
          }

          return {
            jid: jid,
            phoneNumber: phoneNumber,
            name: phoneNumber,
            profilePicUrl: profilePicUrl
          };
        } catch (error) {
          // If we can't get info, return basic info
          const phoneNumber = jid.split('@')[0];
          return {
            jid: jid,
            phoneNumber: phoneNumber,
            name: phoneNumber,
            profilePicUrl: null
          };
        }
      })
    );

    res.json({
      success: true,
      data: contacts,
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
