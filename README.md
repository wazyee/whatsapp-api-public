# WhatsApp REST API + MCP Server

Self-hosted WhatsApp REST API built on [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys), with:

- **Multi-user, multi-session**: each user registers, gets an API key, and connects their own WhatsApp number(s) via QR code. Sessions are strictly scoped per user.
- **REST API** for messages, media, groups, contacts, presence, webhooks (Swagger docs at `/api-docs`).
- **React management dashboard** at `/dashboard` (sessions, QR pairing, logs).
- **MCP server** (`mcp/`) so Claude (Claude Code / Claude Desktop) can read and send WhatsApp messages through your deployment.

Based on [Baileys-2025-Rest-API](https://github.com/pointersoftware/Baileys-2025-Rest-API) by [Abid](https://github.com/pointersoftware) (MIT). Heavily extended: per-user auth with registration gate, per-session proxy support, LID→phone JID canonicalization, self-healing reconnect, React dashboard.

> ⚠️ **Disclaimer**: Baileys is an unofficial WhatsApp Web client. Using it violates WhatsApp's Terms of Service and carries a (small) risk of your number being banned. Use a number you can afford to lose, don't spam, and don't use this for bulk unsolicited messaging.

---

## Requirements

- Node.js ≥ 20
- PostgreSQL ≥ 14
- A server with a domain + HTTPS (any reverse proxy; examples below)

## 1. Deploy the API

### Option A — Docker (fastest)

```bash
git clone <this-repo>
cd whatsapp-api
cp .env.example .env      # edit it — see "Environment" below
docker compose up -d
```

This starts Postgres, Redis, the API on port 3001, and (optionally) nginx. Edit the secrets in `docker-compose.yml` / `.env` first — never keep the defaults.

### Option B — Bare metal (PM2)

```bash
git clone <this-repo>
cd whatsapp-api

# deps
npm install
cd frontend && npm install && cd ..

# config
cp .env.example .env
# edit .env — set DATABASE_URL, JWT_SECRET, REGISTER_PASSWORD (see below)

# database
npx prisma generate
npx prisma db push          # first install (or: npx prisma migrate deploy)

# build backend + dashboard
npm run build

# run
npm install -g pm2
pm2 start dist/app.js --name whatsapp-api
pm2 save && pm2 startup
```

Put a reverse proxy with TLS in front (Caddy, nginx, or your hosting panel). The app listens on `PORT` (default 3001). WebSockets (Socket.IO) must be proxied too — with nginx, set `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";` on the location block (see `nginx.conf` for a full example).

### Environment

Minimum you must set in `.env`:

| Variable | What |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `JWT_SECRET` | Long random string (dashboard login tokens) |
| `REGISTER_PASSWORD` | Long random string — required by `POST /api/auth/register`. This is your signup gate: only people who know it can create accounts on your instance. |
| `API_BASE_URL` / `FRONTEND_URL` | Your public URL, e.g. `https://wa.example.com` |
| `CORS_ORIGIN` | Your public URL (not `*` in production) |

Optional: `WA_PROXY_URL` / `WA_PROXY_COUNTRY` to route WhatsApp connections through a residential proxy (helps if your server IP is flagged).

Everything else in `.env.example` has sane defaults.

## 2. Create your account + connect WhatsApp

```bash
# 1. Register (needs REGISTER_PASSWORD)
curl -X POST https://your-domain.com/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","name":"You","password":"choose-a-login-password","registerPassword":"<REGISTER_PASSWORD>"}'
# → response contains your apiKey. Save it.

# 2. Create a session
curl -X POST https://your-domain.com/api/sessions \
  -H "X-API-Key: <your apiKey>" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"my-session"}'

# 3. Scan the QR code
# Easiest: log into https://your-domain.com/dashboard with your email+password
# and scan the QR with WhatsApp (Settings → Linked Devices → Link a Device).
```

Send a test message:

```bash
curl -X POST https://your-domain.com/api/messages/my-session/send \
  -H "X-API-Key: <your apiKey>" \
  -H "Content-Type: application/json" \
  -d '{"to":"49123456789@s.whatsapp.net","message":{"text":"hello from the API"}}'
```

Full API reference: `https://your-domain.com/api-docs` (Swagger UI). More recipes in [QUICK_START_GUIDE.md](QUICK_START_GUIDE.md) and [USER_MANAGEMENT.md](USER_MANAGEMENT.md).

### Reliability features

**Incremental sync (`since` cursor).** Instead of offset-paginating, clients can pull everything new since their last sync — including delivery-status updates (filtering is on `updatedAt`):

```bash
curl "https://your-domain.com/api/messages/<sessionId>?since=2026-01-01T00:00:00Z&limit=100" \
  -H "X-API-Key: <key>"
# → { data: [...oldest first...], nextCursor: "..." }
# follow-up pages: &cursor=<nextCursor> (keep the same since=)
```

`since` accepts ISO 8601 or unix epoch (seconds or ms). Pagination is stable (id tiebreak), so equal timestamps can never loop or skip.

**Durable webhook delivery.** Webhook retry state is persisted per delivery (not in memory): transient failures (network, 5xx, 408, 429) are retried with backoff — 15s, 1m, 4m, 10m, 30m — up to `WEBHOOK_MAX_ATTEMPTS` (default 6, includes the first try). A 30s DB sweep drives retries, so restarts lose nothing. Permanent 4xx fail fast.

**Webhook replay.** If your receiver was down, re-deliver everything recorded since a timestamp:

```bash
curl -X POST "https://your-domain.com/api/webhooks/<webhookId>/replay?since=2026-01-01T00:00:00Z" \
  -H "X-API-Key: <key>"
# → { replayed: <count> }   (defaults to the last 24h without since)
```

**Edit & delete sent messages.** `POST /api/messages/{sessionId}/send` accepts `options.edit` / `options.delete` with the original message id:

```bash
# edit (WhatsApp allows ~15 minutes)
-d '{"to":"...","content":{"text":"corrected text"},"options":{"edit":"<messageId>"}}'
# delete for everyone
-d '{"to":"...","content":{},"options":{"delete":"<messageId>"}}'
```

## 3. MCP server (Claude integration)

`mcp/server.py` is an MCP server that wraps this API — gives Claude tools like `get_chat_overview`, `get_messages`, `send_message`, `edit_message`, `delete_message`, `send_media`, `send_reaction`.

It runs in two modes: **hosted (streamable HTTP)** — deploy it once next to the API and every user connects with a single command — or **local (stdio)** — each user runs their own copy.

### Option A — hosted (recommended: zero install for users)

Run the MCP server on the same box as the API:

```bash
cd mcp
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
WHATSAPP_API_BASE=http://127.0.0.1:3001 \
MCP_ALLOWED_HOSTS=your-domain.com,127.0.0.1,localhost,127.0.0.1:3002,localhost:3002 \
.venv/bin/python server.py --http   # listens on 127.0.0.1:3002
```

(Or manage it with pm2 — see `ecosystem.config.cjs` for a template.) Then proxy it in nginx:

```nginx
# streamable HTTP = SSE responses: no buffering
location /mcp {
    proxy_pass http://127.0.0.1:3002;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
}
```

Every user now connects with one command — no Python, no clone:

```bash
claude mcp add --transport http whatsapp https://your-domain.com/mcp \
  --header "X-API-Key: <your apiKey>"
```

Auth is per request: each user sends their own API key (`X-API-Key` or `Authorization: Bearer`), so one hosted MCP serves all users of the deployment with strict per-user scoping. If a user has exactly one connected WhatsApp session, it is auto-selected; multiple sessions → pass `session` in tool calls (or set `WHATSAPP_DEFAULT_SESSION` locally).

### Option B — local (stdio)

```bash
cd mcp
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Register with Claude Code (user scope = available in every project):

```bash
claude mcp add whatsapp --scope user \
  -e WHATSAPP_API_BASE=https://your-domain.com \
  -e WHATSAPP_API_KEY=<your apiKey> \
  -e WHATSAPP_DEFAULT_SESSION=my-session \
  -- /absolute/path/to/mcp/.venv/bin/python /absolute/path/to/mcp/server.py
```

Or add it to Claude Desktop's `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "/absolute/path/to/mcp/.venv/bin/python",
      "args": ["/absolute/path/to/mcp/server.py"],
      "env": {
        "WHATSAPP_API_BASE": "https://your-domain.com",
        "WHATSAPP_API_KEY": "<your apiKey>",
        "WHATSAPP_DEFAULT_SESSION": "my-session"
      }
    }
  }
}
```

Then ask Claude something like *"show me my latest WhatsApp chats"*.

**Tip:** treat send tools as confirm-before-send. In Claude Code, allowlist only the read tools in your settings and let the harness prompt on every `send_*` call.

## Security notes

- **Never commit `.env` or `auth_sessions/`** — `auth_sessions/` holds live WhatsApp credentials; anyone with those files IS your WhatsApp. Both are gitignored.
- `REGISTER_PASSWORD` is the only thing standing between the internet and account creation on your instance. Make it long and random.
- API keys are per-user; every session and message is scoped to its owner. Don't share your key.
- Run behind HTTPS. Always.

## License

MIT — see [LICENSE](LICENSE). Original work © Abid (pointersoftware), modifications © contributors.
