import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { handleValidationErrors, asyncHandler } from '../middleware/errorHandler.js';
import { AuthenticatedRequest } from '../middleware/auth.js';
import { DatabaseService } from '../services/DatabaseService.js';
import { WebhookService } from '../services/WebhookService.js';
import { ApiResponse } from '../Types/api.js';

const router = Router();
const dbService = new DatabaseService();
const webhookService = new WebhookService();

/**
 * @swagger
 * /api/webhooks:
 *   get:
 *     summary: Get user webhooks
 *     tags: [Webhooks]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Webhooks retrieved successfully
 */
router.get('/', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const webhooks = await dbService.getUserWebhooks(req.user!.id);

  res.json({
    success: true,
    data: webhooks,
    timestamp: new Date().toISOString()
  } as ApiResponse);
}));

/**
 * @swagger
 * /api/webhooks:
 *   post:
 *     summary: Create a new webhook
 *     tags: [Webhooks]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - url
 *               - events
 *             properties:
 *               url:
 *                 type: string
 *                 format: uri
 *               events:
 *                 type: array
 *                 items:
 *                   type: string
 *               secret:
 *                 type: string
 *     responses:
 *       201:
 *         description: Webhook created successfully
 */
router.post('/', [
  body('url').isURL(),
  body('events').isArray({ min: 1 }),
  body('events.*').isString().notEmpty(),
  body('secret').optional().isString()
], handleValidationErrors, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const { url, events, secret } = req.body;

  const webhook = await dbService.createWebhook({
    userId: req.user!.id,
    url,
    events,
    secret
  });

  res.status(201).json({
    success: true,
    data: webhook,
    message: 'Webhook created successfully',
    timestamp: new Date().toISOString()
  } as ApiResponse);
}));

/**
 * @swagger
 * /api/webhooks/{webhookId}:
 *   delete:
 *     summary: Delete a webhook
 *     tags: [Webhooks]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: webhookId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Webhook deleted successfully
 */
router.delete('/:webhookId', [
  param('webhookId').notEmpty()
], handleValidationErrors, asyncHandler(async (req, res) => {
  const { webhookId } = req.params;

  await dbService.deleteWebhook(webhookId);

  res.json({
    success: true,
    message: 'Webhook deleted successfully',
    timestamp: new Date().toISOString()
  } as ApiResponse);
}));

/**
 * @swagger
 * /api/webhooks/{webhookId}/test:
 *   post:
 *     summary: Test a webhook
 *     tags: [Webhooks]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: webhookId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Webhook test completed
 */
router.post('/:webhookId/test', [
  param('webhookId').notEmpty()
], handleValidationErrors, asyncHandler(async (req, res) => {
  const { webhookId } = req.params;

  const success = await webhookService.testWebhook(webhookId);

  res.json({
    success: true,
    data: { testSuccess: success },
    message: success ? 'Webhook test successful' : 'Webhook test failed',
    timestamp: new Date().toISOString()
  } as ApiResponse);
}));

/**
 * @swagger
 * /api/webhooks/{webhookId}/replay:
 *   post:
 *     summary: Re-deliver all events recorded since a timestamp (downtime recovery)
 *     tags: [Webhooks]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: webhookId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: since
 *         description: ISO 8601 or unix epoch (seconds or ms). Defaults to 24h ago.
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Number of deliveries re-enqueued
 *       404:
 *         description: Webhook not found
 */
router.post('/:webhookId/replay', [
  param('webhookId').notEmpty(),
  query('since').optional().isString()
], handleValidationErrors, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const { webhookId } = req.params;
  const raw = req.query.since as string | undefined;

  let since: Date;
  if (!raw) {
    since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  } else if (/^\d+$/.test(raw)) {
    const n = parseInt(raw, 10);
    since = new Date(n < 1e12 ? n * 1000 : n);
  } else {
    since = new Date(raw);
  }
  if (isNaN(since.getTime())) {
    return res.status(400).json({
      success: false,
      error: 'Invalid since — use ISO 8601 or unix epoch (seconds or ms)',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }

  const webhook = await dbService.client.webhook.findUnique({ where: { id: webhookId } });
  if (!webhook || webhook.userId !== req.user!.id) {
    return res.status(404).json({
      success: false,
      error: 'Webhook not found',
      timestamp: new Date().toISOString()
    } as ApiResponse);
  }

  const count = await webhookService.replayDeliveries(webhookId, since);

  res.json({
    success: true,
    data: { replayed: count, since: since.toISOString() },
    timestamp: new Date().toISOString()
  } as ApiResponse);
}));

export default router;
