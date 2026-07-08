import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';
import dotenv from 'dotenv';

import { errorHandler } from './middleware/errorHandler.js';
import { authMiddleware } from './middleware/auth.js';
import { logger } from './Utils/apiLogger.js';
import { DatabaseService } from './services/DatabaseService.js';
import { WhatsAppService } from './services/WhatsAppService.js';

// Routes
import authRoutes from './routes/auth.js';
import sessionRoutes from './routes/sessions.js';
import messageRoutes from './routes/messages.js';
import chatRoutes from './routes/chats.js';
import groupRoutes from './routes/groups.js';
import contactRoutes from './routes/contacts.js';
import mediaRoutes from './routes/media.js';
import businessRoutes from './routes/business.js';
import webhookRoutes from './routes/webhooks.js';
import dashboardRoutes from './routes/dashboard.js';

// Load environment variables
dotenv.config();

const app = express();

// Trust proxy - trust only the first proxy hop (NGINX on localhost)
// This is secure because NGINX is on the same server and Cloudflare IPs are in X-Forwarded-For
app.set('trust proxy', 1);

const server = createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

// Swagger configuration
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Baileys WhatsApp API',
      version: '1.0.0',
      description: 'REST API wrapper for Baileys WhatsApp Web library',
    },
    servers: [
      {
        url: process.env.API_BASE_URL || 'http://localhost:3001',
        description: 'Development server',
      },
    ],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key'
        }
      }
    },
    security: [
      {
        ApiKeyAuth: []
      }
    ]
  },
  apis: ['./src/routes/*.ts', './src/controllers/*.ts'],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);

// Rate limiting with proper proxy support
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || String(15 * 60 * 1000)),
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '3000'), // generous default: backends often proxy many reads from one IP
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  // Use standardHeaders which works properly with trust proxy
  // The rate limiter will use req.ip which Express sets correctly when trust proxy is configured
  validate: {
    xForwardedForHeader: false, // Disable validation since we're using trust proxy
    trustProxy: false // Disable validation since we've configured it at app level
  }
});

// Middleware
app.use(helmet());
app.use(compression() as any);
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true
}));
app.use(morgan('combined', { stream: { write: (message) => logger.info(message.trim()) } }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(limiter);

// API Documentation
app.use('/api-docs', swaggerUi.serve as any, swaggerUi.setup(swaggerSpec) as any);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0'
  });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/sessions', authMiddleware, sessionRoutes);
app.use('/api/messages', authMiddleware, messageRoutes);
app.use('/api/chats', authMiddleware, chatRoutes);
app.use('/api/groups', authMiddleware, groupRoutes);
app.use('/api/contacts', authMiddleware, contactRoutes);
app.use('/api/media', authMiddleware, mediaRoutes);
app.use('/api/business', authMiddleware, businessRoutes);
app.use('/api/webhooks', authMiddleware, webhookRoutes);
app.use('/dashboard', dashboardRoutes);

// Serve React frontend static files
app.use(express.static('frontend/dist'));

// Fallback for React Router - serve index.html for non-API routes
app.get('*', (req, res, next) => {
  // Skip API routes, health check, api-docs, and dashboard routes
  if (req.path.startsWith('/api') ||
      req.path.startsWith('/dashboard') ||
      req.path === '/health' ||
      req.path === '/api-docs') {
    return next();
  }
  res.sendFile('index.html', { root: 'frontend/dist' });
});

// Error handling
app.use(errorHandler);

// Socket.IO for real-time updates
io.on('connection', (socket) => {
  logger.info(`Client connected: ${socket.id}`);

  socket.on('disconnect', () => {
    logger.info(`Client disconnected: ${socket.id}`);
  });
});

// Initialize services
const databaseService = new DatabaseService();
const whatsAppService = new WhatsAppService(io);

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  await whatsAppService.shutdown();
  await databaseService.disconnect();
  server.close(() => {
    logger.info('Process terminated');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  await whatsAppService.shutdown();
  await databaseService.disconnect();
  server.close(() => {
    logger.info('Process terminated');
    process.exit(0);
  });
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info(`API Documentation available at http://localhost:${PORT}/api-docs`);
  logger.info(`Dashboard available at http://localhost:${PORT}/dashboard`);
  whatsAppService.restoreSessions().catch((err) => logger.error('restoreSessions failed', err));
});

export { app, io, whatsAppService };
