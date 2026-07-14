// pm2 template for API + hosted MCP. Adjust paths/domain, then:
//   pm2 start ecosystem.config.cjs && pm2 save
// (.cjs because package.json has "type":"module")
module.exports = {
  apps: [
    {
      name: "whatsapp-api",
      script: "dist/app.js",
      cwd: __dirname,
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "1G",
      env: { NODE_ENV: "production" }
    },
    {
      // Hosted MCP (streamable HTTP) — nginx proxies your-domain.com/mcp here.
      // Talks to the API via loopback so it skips your proxy + rate limit.
      name: "whatsapp-mcp",
      script: "mcp/.venv/bin/python",
      args: "mcp/server.py --http",
      cwd: __dirname,
      interpreter: "none",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "300M",
      env: {
        WHATSAPP_API_BASE: "http://127.0.0.1:3001",
        MCP_ALLOWED_HOSTS: "your-domain.com,127.0.0.1,localhost,127.0.0.1:3002,localhost:3002",
        MCP_HTTP_HOST: "127.0.0.1",
        MCP_HTTP_PORT: "3002"
      }
    }
  ]
};
