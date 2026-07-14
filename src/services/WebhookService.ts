import axios, { AxiosResponse } from 'axios';
import crypto from 'crypto';
import { DatabaseService } from './DatabaseService.js';
import { webhookLogger } from '../Utils/apiLogger.js';

// Retry state lives on the WebhookDelivery row (attempts / nextRetry / status),
// never in memory: a process restart loses nothing, the periodic sweep picks
// scheduled retries back up from the DB. The legacy per-Webhook `retries`
// counter is informational only — it never gates delivery (it used to, and
// permanently disabled a webhook after 3 failures ever).
//
// Delivery lifecycle:
//   PENDING  -> created, first attempt in flight
//   SUCCESS  -> receiver answered 2xx
//   RETRYING -> transient failure (network/5xx/408/429), nextRetry scheduled
//   FAILED   -> permanent 4xx, or attempts exhausted
//
// ponytail: single-process sweep (pm2 fork, instances=1); move claims into
// SELECT ... FOR UPDATE SKIP LOCKED if this ever runs multi-instance.

const RETRY_DELAYS_MS = [15_000, 60_000, 4 * 60_000, 10 * 60_000, 30 * 60_000];

function maxAttempts(): number {
  return parseInt(process.env.WEBHOOK_MAX_ATTEMPTS || '6', 10); // 1 initial + 5 retries
}

const SWEEP_INTERVAL_MS = 30_000;
let sweepTimer: NodeJS.Timeout | null = null; // module-level: N service instances, one sweep

export class WebhookService {
  private dbService: DatabaseService;

  constructor() {
    this.dbService = new DatabaseService();
    this.startSweeper();
  }

  async sendWebhook(sessionId: string, event: string, payload: any): Promise<void> {
    try {
      const session = await this.dbService.getSession(sessionId);
      if (!session) {
        webhookLogger.warn(`Session ${sessionId} not found for webhook`);
        return;
      }

      const webhooks = await this.dbService.getUserWebhooks(session.userId);
      const relevantWebhooks = webhooks.filter(webhook =>
        webhook.events.includes(event) || webhook.events.includes('*')
      );

      for (const webhook of relevantWebhooks) {
        const delivery = await this.dbService.client.webhookDelivery.create({
          data: { webhookId: webhook.id, event, payload, status: 'PENDING' }
        });
        await this.attempt(delivery.id);
      }
    } catch (error) {
      webhookLogger.error('Error sending webhooks:', error);
    }
  }

  // One delivery attempt. Reads everything it needs from the DB so it can be
  // called from the live path, the sweep, and replay alike.
  private async attempt(deliveryId: string): Promise<void> {
    const delivery = await this.dbService.client.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: { webhook: true }
    });
    if (!delivery || delivery.status === 'SUCCESS') return;

    const { webhook } = delivery;
    const webhookPayload = {
      event: delivery.event,
      timestamp: new Date().toISOString(),
      data: delivery.payload
    };

    const headers: any = {
      'Content-Type': 'application/json',
      'User-Agent': 'Baileys-API-Webhook/1.0'
    };
    if (webhook.secret) {
      headers['X-Webhook-Signature'] = this.createSignature(JSON.stringify(webhookPayload), webhook.secret);
    }

    let response: AxiosResponse | null = null;
    let errorMessage = '';
    try {
      response = await axios.post(webhook.url, webhookPayload, {
        headers,
        timeout: parseInt(process.env.WEBHOOK_TIMEOUT || '10000'),
        validateStatus: () => true // classify below, never throw on HTTP status
      });
    } catch (error: any) {
      errorMessage = error?.message || 'network error';
    }

    const attempts = delivery.attempts + 1;
    const responseSnapshot = response
      ? JSON.stringify({ status: response.status, statusText: response.statusText, data: response.data })
      : JSON.stringify({ error: errorMessage });

    if (response && response.status >= 200 && response.status < 300) {
      await this.dbService.client.webhookDelivery.update({
        where: { id: deliveryId },
        data: { status: 'SUCCESS', attempts, nextRetry: null, response: responseSnapshot }
      });
      webhookLogger.info('Webhook delivered', {
        webhookId: webhook.id, url: webhook.url, event: delivery.event, attempts, deliveryId
      });
      return;
    }

    // Permanent: receiver actively rejected (bad signature/config). 408/429 are transient.
    const status = response?.status ?? 0;
    const permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
    const exhausted = attempts >= maxAttempts();

    if (permanent || exhausted) {
      await this.dbService.client.webhookDelivery.update({
        where: { id: deliveryId },
        data: { status: 'FAILED', attempts, nextRetry: null, response: responseSnapshot }
      });
      await this.dbService.client.webhook.update({
        where: { id: webhook.id },
        data: { retries: { increment: 1 }, lastError: errorMessage || `HTTP ${status}` }
      }).catch(() => {});
      webhookLogger.warn('Webhook delivery failed permanently', {
        webhookId: webhook.id, url: webhook.url, event: delivery.event, attempts, status, permanent
      });
      return;
    }

    const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
    await this.dbService.client.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'RETRYING',
        attempts,
        nextRetry: new Date(Date.now() + delay),
        response: responseSnapshot
      }
    });
    webhookLogger.info('Webhook retry scheduled', {
      webhookId: webhook.id, url: webhook.url, event: delivery.event, attempts, retryInMs: delay
    });
  }

  // DB-driven retry engine: every 30s re-attempt due RETRYING deliveries and
  // adopt PENDING orphans older than 2 minutes (process died mid-attempt).
  private startSweeper(): void {
    if (sweepTimer) return;
    sweepTimer = setInterval(() => {
      this.sweep().catch(err => webhookLogger.error('Webhook sweep error:', err));
    }, SWEEP_INTERVAL_MS);
    sweepTimer.unref();
    // Immediate boot sweep so restarts resume without waiting an interval.
    this.sweep().catch(err => webhookLogger.error('Webhook boot sweep error:', err));
  }

  private async sweep(): Promise<void> {
    const now = new Date();
    const due = await this.dbService.client.webhookDelivery.findMany({
      where: {
        OR: [
          { status: 'RETRYING', nextRetry: { lte: now } },
          { status: 'PENDING', createdAt: { lt: new Date(now.getTime() - 2 * 60_000) } }
        ]
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
      select: { id: true }
    });

    for (const { id } of due) {
      await this.attempt(id);
    }
  }

  // Re-enqueue every delivery of a webhook created since `since` (downtime
  // recovery). Payloads are persisted on the delivery rows, so this re-sends
  // the original events. Resets attempts; the sweep does the actual sending.
  async replayDeliveries(webhookId: string, since: Date): Promise<number> {
    const result = await this.dbService.client.webhookDelivery.updateMany({
      where: {
        webhookId,
        createdAt: { gte: since },
        status: { in: ['SUCCESS', 'FAILED', 'RETRYING'] }
      },
      data: { status: 'RETRYING', attempts: 0, nextRetry: new Date() }
    });
    webhookLogger.info('Webhook replay enqueued', { webhookId, since: since.toISOString(), count: result.count });
    return result.count;
  }

  private createSignature(payload: string, secret: string): string {
    return crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');
  }

  async verifyWebhookSignature(payload: string, signature: string, secret: string): Promise<boolean> {
    const expectedSignature = this.createSignature(payload, secret);
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  }

  async testWebhook(webhookId: string): Promise<boolean> {
    try {
      const webhook = await this.dbService.client.webhook.findUnique({
        where: { id: webhookId }
      });

      if (!webhook) {
        throw new Error('Webhook not found');
      }

      const testPayload = {
        event: 'webhook.test',
        timestamp: new Date().toISOString(),
        data: {
          message: 'This is a test webhook delivery',
          webhookId
        }
      };

      const headers: any = {
        'Content-Type': 'application/json',
        'User-Agent': 'Baileys-API-Webhook/1.0'
      };

      if (webhook.secret) {
        const signature = this.createSignature(JSON.stringify(testPayload), webhook.secret);
        headers['X-Webhook-Signature'] = signature;
      }

      const response = await axios.post(webhook.url, testPayload, {
        headers,
        timeout: parseInt(process.env.WEBHOOK_TIMEOUT || '10000')
      });

      webhookLogger.info(`Webhook test successful`, {
        webhookId,
        url: webhook.url,
        status: response.status
      });

      return response.status >= 200 && response.status < 300;
    } catch (error) {
      webhookLogger.error(`Webhook test failed`, {
        webhookId,
        error: error.message
      });
      return false;
    }
  }

  async getWebhookDeliveries(webhookId: string, limit = 50, offset = 0) {
    return this.dbService.client.webhookDelivery.findMany({
      where: { webhookId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset
    });
  }

  async cleanup(): Promise<void> {
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }

    // Clean up old delivery records (older than 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    await this.dbService.client.webhookDelivery.deleteMany({
      where: {
        createdAt: {
          lt: thirtyDaysAgo
        }
      }
    });

    webhookLogger.info('Webhook service cleanup completed');
  }
}
