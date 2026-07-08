import { Router } from 'express';
import { param, body } from 'express-validator';
import { handleValidationErrors, asyncHandler } from '../middleware/errorHandler.js';
import { sessionMiddleware } from '../middleware/auth.js';
import { whatsAppService } from '../app.js';
import { DatabaseService } from '../services/DatabaseService.js';
import { ApiResponse } from '../Types/api.js';

const router = Router();
const dbService = new DatabaseService();

/**
 * @swagger
 * /api/groups/{sessionId}/create:
 *   post:
 *     summary: Create a new group
 *     tags: [Groups]
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
 *               - subject
 *               - participants
 *             properties:
 *               subject:
 *                 type: string
 *               participants:
 *                 type: array
 *                 items:
 *                   type: string
 *               description:
 *                 type: string
 *     responses:
 *       200:
 *         description: Group created successfully
 */
router.post('/:sessionId/create', [
  param('sessionId').notEmpty(),
  body('subject').notEmpty().trim().isLength({ min: 1, max: 100 }),
  body('participants').isArray({ min: 1 }),
  body('participants.*').isString().notEmpty(),
  body('description').optional().trim().isLength({ max: 500 })
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const { subject, participants, description } = req.body;

  const session = await whatsAppService.getSession(sessionId);
  if (!session?.socket) {
    return res.status(400).json({
      success: false,
      error: 'Session not connected',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }

  try {
    const group = await session.socket.groupCreate(subject, participants);
    
    // Set description if provided
    if (description) {
      await session.socket.groupUpdateDescription(group.id, description);
    }

    res.json({
      success: true,
      data: group,
      message: 'Group created successfully',
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
 * /api/groups/{sessionId}/{groupId}/metadata:
 *   get:
 *     summary: Get group metadata
 *     tags: [Groups]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: groupId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Group metadata retrieved successfully
 */
router.get('/:sessionId/:groupId/metadata', [
  param('sessionId').notEmpty(),
  param('groupId').notEmpty()
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId, groupId } = req.params;

  const session = await whatsAppService.getSession(sessionId);
  if (!session?.socket) {
    return res.status(400).json({
      success: false,
      error: 'Session not connected',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }

  try {
    const metadata = await session.socket.groupMetadata(groupId);

    res.json({
      success: true,
      data: metadata,
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
 * /api/groups/{sessionId}/{groupId}/participants/add:
 *   post:
 *     summary: Add participants to group
 *     tags: [Groups]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: groupId
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
 *               - participants
 *             properties:
 *               participants:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Participants added successfully
 */
router.post('/:sessionId/:groupId/participants/add', [
  param('sessionId').notEmpty(),
  param('groupId').notEmpty(),
  body('participants').isArray({ min: 1 }),
  body('participants.*').isString().notEmpty()
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId, groupId } = req.params;
  const { participants } = req.body;

  const session = await whatsAppService.getSession(sessionId);
  if (!session?.socket) {
    return res.status(400).json({
      success: false,
      error: 'Session not connected',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }

  try {
    const result = await session.socket.groupParticipantsUpdate(groupId, participants, 'add');

    res.json({
      success: true,
      data: result,
      message: 'Participants added successfully',
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
 * /api/groups/{sessionId}/{groupId}/participants/remove:
 *   post:
 *     summary: Remove participants from group
 *     tags: [Groups]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: groupId
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
 *               - participants
 *             properties:
 *               participants:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Participants removed successfully
 */
router.post('/:sessionId/:groupId/participants/remove', [
  param('sessionId').notEmpty(),
  param('groupId').notEmpty(),
  body('participants').isArray({ min: 1 }),
  body('participants.*').isString().notEmpty()
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId, groupId } = req.params;
  const { participants } = req.body;

  const session = await whatsAppService.getSession(sessionId);
  if (!session?.socket) {
    return res.status(400).json({
      success: false,
      error: 'Session not connected',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }

  try {
    const result = await session.socket.groupParticipantsUpdate(groupId, participants, 'remove');

    res.json({
      success: true,
      data: result,
      message: 'Participants removed successfully',
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
 * /api/groups/{sessionId}/{groupId}/participants/promote:
 *   post:
 *     summary: Promote participants to admin
 *     tags: [Groups]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: groupId
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
 *               - participants
 *             properties:
 *               participants:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Participants promoted successfully
 */
router.post('/:sessionId/:groupId/participants/promote', [
  param('sessionId').notEmpty(),
  param('groupId').notEmpty(),
  body('participants').isArray({ min: 1 }),
  body('participants.*').isString().notEmpty()
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId, groupId } = req.params;
  const { participants } = req.body;

  const session = await whatsAppService.getSession(sessionId);
  if (!session?.socket) {
    return res.status(400).json({
      success: false,
      error: 'Session not connected',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }

  try {
    const result = await session.socket.groupParticipantsUpdate(groupId, participants, 'promote');

    res.json({
      success: true,
      data: result,
      message: 'Participants promoted successfully',
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
 * /api/groups/{sessionId}/{groupId}/participants/demote:
 *   post:
 *     summary: Demote participants from admin
 *     tags: [Groups]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: groupId
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
 *               - participants
 *             properties:
 *               participants:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Participants demoted successfully
 */
router.post('/:sessionId/:groupId/participants/demote', [
  param('sessionId').notEmpty(),
  param('groupId').notEmpty(),
  body('participants').isArray({ min: 1 }),
  body('participants.*').isString().notEmpty()
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId, groupId } = req.params;
  const { participants } = req.body;

  const session = await whatsAppService.getSession(sessionId);
  if (!session?.socket) {
    return res.status(400).json({
      success: false,
      error: 'Session not connected',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }

  try {
    const result = await session.socket.groupParticipantsUpdate(groupId, participants, 'demote');

    res.json({
      success: true,
      data: result,
      message: 'Participants demoted successfully',
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
 * /api/groups/{sessionId}/{groupId}/subject:
 *   put:
 *     summary: Update group subject
 *     tags: [Groups]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: groupId
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
 *               - subject
 *             properties:
 *               subject:
 *                 type: string
 *     responses:
 *       200:
 *         description: Group subject updated successfully
 */
router.put('/:sessionId/:groupId/subject', [
  param('sessionId').notEmpty(),
  param('groupId').notEmpty(),
  body('subject').notEmpty().trim().isLength({ min: 1, max: 100 })
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId, groupId } = req.params;
  const { subject } = req.body;

  const session = await whatsAppService.getSession(sessionId);
  if (!session?.socket) {
    return res.status(400).json({
      success: false,
      error: 'Session not connected',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }

  try {
    await session.socket.groupUpdateSubject(groupId, subject);

    res.json({
      success: true,
      message: 'Group subject updated successfully',
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
 * /api/groups/{sessionId}/{groupId}/description:
 *   put:
 *     summary: Update group description
 *     tags: [Groups]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: groupId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               description:
 *                 type: string
 *     responses:
 *       200:
 *         description: Group description updated successfully
 */
router.put('/:sessionId/:groupId/description', [
  param('sessionId').notEmpty(),
  param('groupId').notEmpty(),
  body('description').optional().trim().isLength({ max: 500 })
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId, groupId } = req.params;
  const { description } = req.body;

  const session = await whatsAppService.getSession(sessionId);
  if (!session?.socket) {
    return res.status(400).json({
      success: false,
      error: 'Session not connected',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }

  try {
    await session.socket.groupUpdateDescription(groupId, description);

    res.json({
      success: true,
      message: 'Group description updated successfully',
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
 * /api/groups/{sessionId}/{groupId}/leave:
 *   post:
 *     summary: Leave a group
 *     tags: [Groups]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: groupId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Left group successfully
 */
router.post('/:sessionId/:groupId/leave', [
  param('sessionId').notEmpty(),
  param('groupId').notEmpty()
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId, groupId } = req.params;

  const session = await whatsAppService.getSession(sessionId);
  if (!session?.socket) {
    return res.status(400).json({
      success: false,
      error: 'Session not connected',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }

  try {
    await session.socket.groupLeave(groupId);

    res.json({
      success: true,
      message: 'Left group successfully',
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
 * /api/groups/{sessionId}/list-from-messages:
 *   get:
 *     summary: Get groups discovered from messages
 *     tags: [Groups]
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
 *         description: Groups list retrieved successfully
 */
router.get('/:sessionId/list-from-messages', [
  param('sessionId').notEmpty()
], sessionMiddleware, handleValidationErrors, asyncHandler(async (req, res) => {
  const { sessionId } = req.params;

  // Get unique group JIDs from messages
  const messages = await dbService.getMessages(sessionId);
  const groupJids = [...new Set(
    messages
      .filter(m => m.chatId.endsWith('@g.us'))
      .map(m => m.chatId)
  )];

  if (groupJids.length === 0) {
    return res.json({
      success: true,
      data: [],
      message: 'No groups found in messages',
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
    // Fetch metadata for each group
    const groups = await Promise.all(
      groupJids.map(async (jid) => {
        try {
          const metadata = await session.socket!.groupMetadata(jid);
          return {
            jid: jid,
            name: metadata.subject,
            participants: metadata.size || metadata.participants?.length || 0,
            owner: metadata.owner,
            creation: metadata.creation
          };
        } catch (error) {
          // If we can't get metadata, return basic info
          return {
            jid: jid,
            name: jid.split('@')[0],
            participants: 0,
            error: 'Could not fetch metadata'
          };
        }
      })
    );

    res.json({
      success: true,
      data: groups,
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
