# 👥 User & Session Management Explained

## 🏗️ Architecture

```
User (You/Your Client)
  ├── Session 1 (WhatsApp Account #1)
  │   ├── Messages
  │   ├── Chats
  │   ├── Contacts
  │   └── Groups
  ├── Session 2 (WhatsApp Account #2)
  │   ├── Messages
  │   ├── Chats
  │   └── Groups
  └── Session 3 (WhatsApp Account #3)
      └── ...
```

**One User = Multiple WhatsApp Accounts (Sessions)**

---

## 📝 Creating Users

### Method 1: Via API (Recommended)

```bash
curl -X POST https://your-domain.com/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "client@example.com",
    "password": "SecurePass123!",
    "name": "Client Name"
  }'
```

**Response:**
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "cm4xyz...",
      "email": "client@example.com",
      "name": "Client Name",
      "role": "USER",
      "apiKey": "cm4abc123..."  ← Give this to your client
    },
    "token": "eyJhbGc..."
  }
}
```

---

### Method 2: Direct Database Insert

```bash
# SSH into server
cd /path/to/whatsapp-api

# Create user via Node.js script
node -e "
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

(async () => {
  const prisma = new PrismaClient();
  
  const user = await prisma.user.create({
    data: {
      email: 'admin@example.com',
      name: 'Admin User',
      password: await bcrypt.hash('YourPassword123', 12),
      role: 'ADMIN'
    }
  });
  
  console.log('User created:', user);
  console.log('API Key:', user.apiKey);
  process.exit(0);
})();
"
```

---

## 🔑 User Roles

- **USER** (Default) - Regular user, can create sessions
- **ADMIN** - Full access to all features

---

## 📱 Multiple Sessions (Multiple WhatsApp Accounts)

**YES!** One user can have unlimited sessions:

```bash
# User creates Session 1 (Personal WhatsApp)
curl -X POST https://your-domain.com/api/sessions \
  -H "X-API-Key: USER_API_KEY" \
  -d '{"sessionId": "personal-wa"}'

# Same user creates Session 2 (Business WhatsApp)
curl -X POST https://your-domain.com/api/sessions \
  -H "X-API-Key: USER_API_KEY" \
  -d '{"sessionId": "business-wa"}'

# Same user creates Session 3 (Support WhatsApp)
curl -X POST https://your-domain.com/api/sessions \
  -H "X-API-Key: USER_API_KEY" \
  -d '{"sessionId": "support-wa"}'
```

Each session = Different WhatsApp number/account!

---

## 👥 Groups Management

### Get All Groups (for a session)
```bash
curl https://your-domain.com/api/groups/SESSION_ID \
  -H "X-API-Key: API_KEY"
```

### Create a Group
```bash
curl -X POST https://your-domain.com/api/groups/SESSION_ID \
  -H "Content-Type: application/json" \
  -H "X-API-Key: API_KEY" \
  -d '{
    "name": "My Group",
    "participants": [
      "491234567890@s.whatsapp.net",
      "447700900123@s.whatsapp.net"
    ]
  }'
```

### Add Participant to Group
```bash
curl -X POST https://your-domain.com/api/groups/SESSION_ID/GROUP_JID/participants \
  -H "Content-Type: application/json" \
  -H "X-API-Key: API_KEY" \
  -d '{
    "participants": ["441234567890@s.whatsapp.net"]
  }'
```

### Remove Participant
```bash
curl -X DELETE https://your-domain.com/api/groups/SESSION_ID/GROUP_JID/participants \
  -H "Content-Type: application/json" \
  -H "X-API-Key: API_KEY" \
  -d '{
    "participants": ["441234567890@s.whatsapp.net"]
  }'
```

### Update Group Settings
```bash
curl -X PATCH https://your-domain.com/api/groups/SESSION_ID/GROUP_JID \
  -H "Content-Type: application/json" \
  -H "X-API-Key: API_KEY" \
  -d '{
    "subject": "New Group Name",
    "description": "Updated description"
  }'
```

### Get Group Invite Link
```bash
curl https://your-domain.com/api/groups/SESSION_ID/GROUP_JID/invite \
  -H "X-API-Key: API_KEY"
```

---

## 🎯 Real-World Example

**Scenario:** SaaS company with 3 clients

### 1. Create 3 Users (Clients)
```bash
# Client A
curl -X POST https://your-domain.com/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"clientA@company.com","password":"pass123","name":"Client A"}'
# → API Key: abc123...

# Client B
curl -X POST https://your-domain.com/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"clientB@company.com","password":"pass456","name":"Client B"}'
# → API Key: def456...

# Client C
curl -X POST https://your-domain.com/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"clientC@company.com","password":"pass789","name":"Client C"}'
# → API Key: ghi789...
```

### 2. Each Client Creates Sessions
```bash
# Client A creates 2 sessions (sales + support)
curl -X POST https://your-domain.com/api/sessions \
  -H "X-API-Key: abc123..." \
  -d '{"sessionId":"clientA-sales"}'

curl -X POST https://your-domain.com/api/sessions \
  -H "X-API-Key: abc123..." \
  -d '{"sessionId":"clientA-support"}'
```

### 3. Clients Use Their Sessions
```bash
# Client A sends from sales WhatsApp
curl -X POST https://your-domain.com/api/messages/clientA-sales/send \
  -H "X-API-Key: abc123..." \
  -d '{"to":"123@s.whatsapp.net","message":"Sales inquiry"}'

# Client A sends from support WhatsApp
curl -X POST https://your-domain.com/api/messages/clientA-support/send \
  -H "X-API-Key: abc123..." \
  -d '{"to":"456@s.whatsapp.net","message":"Support ticket"}'
```

---

## 📊 Database Structure

```
users
├── id
├── email (unique)
├── apiKey (unique) ← Used for authentication
├── password (hashed)
└── role (USER/ADMIN)

sessions (linked to user)
├── id
├── sessionId (unique)
├── userId (foreign key)
├── status (PENDING/CONNECTED/DISCONNECTED)
├── phoneNumber
└── qrCode

messages (linked to session)
├── id
├── sessionId (foreign key)
├── chatId
├── content
└── timestamp

groups (linked to session)
├── id
├── sessionId (foreign key)
├── jid (WhatsApp group ID)
├── name
└── participants
```

---

## 🔐 Security Best Practices

### For Your Clients:
1. **One API Key per client** - Don't share
2. **Rotate keys regularly** - Can reset via API
3. **Use environment variables** - Don't hardcode
4. **Implement rate limiting** - Protect your API

### For You (Admin):
1. **Create admin user** for full access
2. **Monitor API usage** - Check database
3. **Set up backups** - Database + sessions
4. **Configure webhooks** - Get notified of events

---

## 🚀 Quick Commands

### List All Users
```bash
psql -U whatsapp_api -h 127.0.0.1 -d whatsapp_api \
  -c "SELECT id, email, name, role, \"apiKey\" FROM users;"
```

### List All Sessions
```bash
psql -U whatsapp_api -h 127.0.0.1 -d whatsapp_api \
  -c "SELECT \"sessionId\", status, \"phoneNumber\", \"userId\" FROM sessions;"
```

### Delete a Session
```bash
curl -X DELETE https://your-domain.com/api/sessions/SESSION_ID \
  -H "X-API-Key: API_KEY"
```

---

## 💡 Tips

- **Session IDs** can be anything: `my-phone`, `sales-wa`, `support-001`
- **One WhatsApp number** = **One session** (can't share across users)
- **Group JID** format: `120363XXXXXXXXX@g.us`
- **Phone format**: Always use international format without `+`

