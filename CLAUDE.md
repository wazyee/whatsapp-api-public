# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a REST API wrapper for the Baileys WhatsApp Web library with a React-based management dashboard. The project enables programmatic control of WhatsApp through a REST API with features like multi-session support, webhooks, and real-time updates.

**Stack:**
- **Backend:** Node.js/TypeScript with Express
- **Frontend:** React 19 with Vite
- **Database:** PostgreSQL with Prisma ORM
- **Real-time:** Socket.IO
- **Core Library:** Baileys (@whiskeysockets/baileys)

## Common Commands

### Development
```bash
# Backend development
yarn dev                    # Start backend with hot-reload
yarn dev:debug             # Start with debugger enabled

# Frontend development
yarn frontend:dev          # Start React dev server (port 3000)

# Full stack development
yarn dev &                 # Run backend in background
yarn frontend:dev          # Run frontend in separate terminal
```

### Database Operations
```bash
yarn db:generate           # Generate Prisma client after schema changes
yarn migrate               # Run migrations in development
yarn migrate:deploy        # Run migrations in production
yarn db:studio            # Open Prisma Studio GUI
```

### Building & Production
```bash
yarn build                 # Build both backend (TypeScript) and frontend (React)
yarn build:tsc            # Build only backend TypeScript
yarn frontend:build       # Build only frontend
yarn start                # Start production server
```

### Testing & Quality
```bash
yarn test                 # Run all tests
yarn test:watch          # Run tests in watch mode
yarn test:coverage       # Generate coverage report
yarn lint                # Run ESLint
yarn lint:fix           # Auto-fix linting issues
```

### Setup
```bash
yarn install             # Install backend dependencies
yarn frontend:install    # Install frontend dependencies
```

## Architecture

### Backend Service Layer Pattern

The backend uses a three-tier architecture:

1. **Routes** (`src/routes/`) - HTTP endpoint definitions with validation
2. **Services** (`src/services/`) - Business logic and orchestration
3. **Database** - Prisma client for data persistence

**Key Services:**

- **WhatsAppService** (`src/services/WhatsAppService.ts`)
  - Manages Baileys socket connections for each session
  - Maintains in-memory map of active WhatsApp sessions
  - Handles QR code generation, pairing codes, and reconnection logic
  - Emits events via Socket.IO for real-time UI updates
  - Auth state stored in `auth_sessions/{sessionId}/` directory

- **DatabaseService** (`src/services/DatabaseService.ts`)
  - Singleton wrapper around Prisma client
  - Provides typed methods for all database operations
  - Handles connection lifecycle and logging

- **WebhookService** (`src/services/WebhookService.ts`)
  - Delivers event notifications to user-configured webhook URLs
  - Implements retry logic with exponential backoff
  - Tracks delivery status in `webhook_deliveries` table

### Session Management Architecture

WhatsApp sessions are the core abstraction:

- Each session has a unique `sessionId` (user-defined string)
- Session state is **dual-persistence**:
  - Runtime: In-memory map in `WhatsAppService.sessions`
  - Persistent: Database `sessions` table + filesystem auth data
- Sessions survive server restarts by loading auth from `auth_sessions/` directory
- Session status flows: `CONNECTING → QR_REQUIRED/PAIRING_REQUIRED → CONNECTED → DISCONNECTED`

**Critical:** When adding session-related features, update both in-memory state and database. The reconnect/restart endpoints demonstrate this pattern.

### Frontend Architecture

React SPA with simple structure:

- **Context:** `AuthContext` manages authentication state and API key storage
- **API Layer:** `src/services/api.js` - Axios instance with interceptors for API key injection
- **Routes:** React Router v7 with protected routes
- **Components:** Function components with hooks (no class components)

The frontend is served as static files from `frontend/dist` by the Express backend. API requests use relative paths (`/api/*`) which are proxied in development.

### Database Schema Patterns

Prisma schema uses several important patterns:

- **Cascade Deletes:** All related entities use `onDelete: Cascade` (e.g., deleting user deletes all their sessions)
- **Composite Unique Keys:** Many models use `@@unique([sessionId, jid])` to ensure data uniqueness per session
- **JSON Fields:** Complex data (message content, metadata) stored as `Json` type for flexibility
- **Soft Deletes:** Sessions and webhooks use `isActive` boolean instead of hard deletion

When modifying schema:
1. Edit `prisma/schema.prisma`
2. Run `yarn db:generate` to update client
3. Run `yarn migrate` to create and apply migration

### Authentication & Authorization

Dual authentication system:

1. **API Key** (recommended): `X-API-Key` header - used by external integrations
2. **JWT Token**: `Authorization: Bearer <token>` header - used by dashboard

Both methods identify the user via `authMiddleware` in `src/middleware/auth.ts`. All API routes except `/api/auth/*` are protected.

The frontend stores the API key in localStorage and injects it via axios interceptor.

### Baileys Integration

This project wraps the Baileys library located in `src/` (Socket, Types, Utils, WABinary, etc.). Key integration points:

- **Socket Creation:** `makeWASocket()` in `WhatsAppService.initializeWhatsAppConnection()`
- **Auth State:** `useMultiFileAuthState()` manages credentials per session
- **Event Handling:** Baileys events (messages, connection updates) are handled in `WhatsAppService` and:
  - Persisted to database via `DatabaseService`
  - Forwarded to webhooks via `WebhookService`
  - Emitted to frontend via Socket.IO

**Important:** Baileys is actively developed. When updating the library, check for breaking changes in event structures and socket options.

## Project Structure Notes

### Backend (`src/`)
- `app.ts` - Express app setup, middleware chain, route registration
- `index.ts` - Re-exports Baileys library types and functions
- `routes/` - Express routers with JSDoc for Swagger generation
- `middleware/` - Auth middleware and error handler
- `services/` - Core business logic (see Service Layer Pattern above)
- `Types/` - TypeScript type definitions from Baileys
- `Utils/` - Helper functions (auth utils, loggers, crypto, etc.)
- `Socket/`, `WABinary/`, `WAUSync/` - Baileys library internals

### Frontend (`frontend/src/`)
- `main.jsx` - React entry point
- `App.jsx` - Router setup
- `pages/` - Route components (Home, Login, Register, Sessions)
- `components/` - Reusable UI components (SessionCard, MessageComposer, etc.)
- `context/` - React context providers
- `services/` - API client setup

### Key Files
- `.env.example` - Complete environment variable reference
- `prisma/schema.prisma` - Database schema (source of truth)
- `package.json` - Backend dependencies and scripts
- `frontend/package.json` - Frontend dependencies and scripts

## Development Workflow

### Adding a New API Endpoint

1. Define route in `src/routes/{resource}.ts` with JSDoc for Swagger
2. Add validation using `express-validator`
3. Implement handler that calls service methods
4. Update service layer if new business logic needed
5. Update Prisma schema if new data model needed
6. Add frontend API method in `frontend/src/services/api.js`

### Working with Sessions

- Sessions persist across restarts via filesystem auth in `auth_sessions/`
- Always update both in-memory (`WhatsAppService.sessions`) and database state
- Use `whatsappLogger` for session-related logs
- Handle disconnection gracefully - Baileys auto-reconnects on network issues

### Database Changes

1. Modify `prisma/schema.prisma`
2. Run `yarn db:generate` (updates Prisma client types)
3. Run `yarn migrate` (creates migration file, applies to DB)
4. Update TypeScript types in `src/Types/api.ts` if needed
5. Update service methods in `DatabaseService` if needed

### Frontend Changes

- Frontend dev server proxies `/api` to backend (configured in `vite.config.js`)
- For production, frontend builds to `frontend/dist` and is served by Express
- State management is minimal - mostly local state and AuthContext
- API calls should use the shared axios instance from `services/api.js`

## Important Patterns

### Error Handling
- Services throw errors with descriptive messages
- `errorHandler` middleware in `src/middleware/errorHandler.ts` formats all errors
- Frontend axios interceptor extracts error messages from responses

### Logging
Multiple Pino logger instances in `src/Utils/apiLogger.ts`:
- `logger` - General application logs
- `whatsappLogger` - WhatsApp/Baileys specific logs
- `webhookLogger` - Webhook delivery logs

### Session Serialization
When returning session objects via API, use `serializeSession()` from `src/Utils/session-serializer.ts` to prevent circular reference errors (Baileys socket objects contain circular refs).

### Real-time Updates
Socket.IO (`io` instance in `app.ts`) emits events to frontend for:
- QR code updates
- Connection status changes
- New messages
- Session state changes

Frontend should listen to these events for live UI updates.

## Configuration

Environment variables are defined in `.env.example`. Critical ones:

- `DATABASE_URL` - PostgreSQL connection string
- `JWT_SECRET` - Used for JWT token signing
- `API_KEY_SECRET` - Used for API key generation
- `PORT` - Server port (default 3001)
- `NODE_ENV` - Affects logging and error responses

## Notes

- The project uses Yarn as package manager (`yarn@1.22.19`)
- Node.js 20+ required (specified in `engines` in package.json)
- Trust proxy is configured for deployment behind NGINX/Cloudflare
- Rate limiting uses IP-based throttling (15min window, 100 req/IP)
- Swagger docs auto-generated from JSDoc comments in route files
