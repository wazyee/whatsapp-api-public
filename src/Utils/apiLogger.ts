import pino from 'pino';
import { createWriteStream } from 'fs';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';

// Ensure logs directory exists
const logsDir = join(process.cwd(), 'logs');
if (!existsSync(logsDir)) {
  mkdirSync(logsDir, { recursive: true });
}

// Create log streams
const logFile = join(logsDir, 'app.log');
const errorFile = join(logsDir, 'error.log');

const streams = [
  // Console output for development
  {
    level: process.env.LOG_LEVEL || 'info',
    stream: process.stdout
  },
  // File output for all logs
  {
    level: 'info',
    stream: createWriteStream(logFile, { flags: 'a' })
  },
  // Separate file for errors
  {
    level: 'error',
    stream: createWriteStream(errorFile, { flags: 'a' })
  }
];

// Create logger with multiple streams
export const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => {
        return { level: label };
      }
    },
    serializers: {
      req: (req) => ({
        method: req.method,
        url: req.url,
        headers: {
          'user-agent': req.headers['user-agent'],
          'content-type': req.headers['content-type'],
          'x-forwarded-for': req.headers['x-forwarded-for']
        },
        remoteAddress: req.remoteAddress,
        remotePort: req.remotePort
      }),
      res: (res) => ({
        statusCode: res.statusCode,
        headers: {
          'content-type': res.getHeader('content-type'),
          'content-length': res.getHeader('content-length')
        }
      }),
      err: pino.stdSerializers.err
    }
  },
  pino.multistream(streams)
);

// Permissive logger interface so wrapper code can use either pino's
// (obj, msg) style or the legacy (msg, obj) style without TS friction.
export type LooseLogger = {
  info(...args: any[]): void;
  error(...args: any[]): void;
  warn(...args: any[]): void;
  debug(...args: any[]): void;
  trace(...args: any[]): void;
  fatal(...args: any[]): void;
  child(bindings: Record<string, unknown>): LooseLogger;
};

export const createLogger = (component: string): LooseLogger =>
  logger.child({ component }) as unknown as LooseLogger;

export const apiLogger = createLogger('api');
export const whatsappLogger = createLogger('whatsapp');
export const dbLogger = createLogger('database');
export const webhookLogger = createLogger('webhook');

// Helper function to log API requests
export const logApiRequest = (req: any, res: any, duration: number) => {
  apiLogger.info({
    req,
    res,
    duration,
    userId: req.user?.id,
    sessionId: req.sessionId
  }, 'API Request');
};

// Helper function to log WhatsApp events
export const logWhatsAppEvent = (sessionId: string, event: string, data?: any) => {
  whatsappLogger.info({
    sessionId,
    event,
    data
  }, 'WhatsApp Event');
};

// Helper function to log errors with context
export const logError = (error: Error, context?: any) => {
  logger.error({
    err: error,
    context
  }, 'Application Error');
};

// Helper function to log webhook deliveries
export const logWebhookDelivery = (webhookId: string, url: string, event: string, status: string, response?: any) => {
  webhookLogger.info({
    webhookId,
    url,
    event,
    status,
    response
  }, 'Webhook Delivery');
};

export default logger;
