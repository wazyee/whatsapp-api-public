# 🚀 WhatsApp API - Quick Start Guide

## Step 1: Register a User

First, create a user account to get an API key:

```bash
curl -X POST https://your-domain.com/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "your@email.com",
    "name": "Your Name",
    "password": "your-secure-password"
  }'
```

**Response:**
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "clxxx...",
      "email": "your@email.com",
      "name": "Your Name",
      "role": "USER",
      "apiKey": "clyyy..."  ← SAVE THIS!
    },
    "token": "eyJhbGc..." ← OR USE THIS JWT TOKEN
  },
  "message": "User registered successfully"
}
```

**💾 Save your API Key or Token!** You'll need it for all requests.

---

## Step 2: Create a WhatsApp Session

Create a session to connect your WhatsApp account:

```bash
curl -X POST https://your-domain.com/api/sessions \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY_HERE" \
  -d '{
    "sessionId": "my-whatsapp-1",
    "usePairingCode": false
  }'
```

**Response:**
```json
{
  "success": true,
  "data": {
    "sessionId": "my-whatsapp-1",
    "status": "PENDING",
    "qrCode": "data:image/png;base64,iVBORw0KGgoAAAANSUh..." ← QR CODE!
  },
  "message": "Session created successfully"
}
```

---

## Step 3: Get QR Code to Scan

The `qrCode` field contains a base64 image. You have two options:

### Option A: View in Browser
1. Copy the entire `qrCode` value
2. Paste it in your browser address bar
3. Scan with WhatsApp mobile app

### Option B: Get QR Code via API
```bash
curl -X GET https://your-domain.com/api/sessions/my-whatsapp-1 \
  -H "X-API-Key: YOUR_API_KEY_HERE"
```

**Response includes:**
```json
{
  "success": true,
  "data": {
    "sessionId": "my-whatsapp-1",
    "status": "CONNECTED",  ← Status updates after scanning
    "qrCode": "...",
    "phoneNumber": "+1234567890"
  }
}
```

---

## Step 4: Send a Message

Once your session is **CONNECTED**, send messages:

### Send Text Message
```bash
curl -X POST https://your-domain.com/api/messages/my-whatsapp-1/send \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY_HERE" \
  -d '{
    "to": "1234567890@s.whatsapp.net",
    "message": "Hello from the API! 🚀"
  }'
```

**Phone Number Format:**
- Individual: `COUNTRYCODE+NUMBER@s.whatsapp.net`
- Example: `491234567890@s.whatsapp.net` (Germany)
- Group: `GROUP_ID@g.us`

---

## 📱 Authentication Methods

You can use either:

### Method 1: API Key (Recommended)
```bash
-H "X-API-Key: YOUR_API_KEY"
```

### Method 2: JWT Token
```bash
-H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### Method 3: Query Parameter
```bash
?apiKey=YOUR_API_KEY
```

---

## 🔍 Check Session Status

Monitor your session status:

```bash
curl https://your-domain.com/api/sessions/my-whatsapp-1 \
  -H "X-API-Key: YOUR_API_KEY"
```

**Possible statuses:**
- `PENDING` - Waiting for QR scan
- `CONNECTED` - Ready to send messages
- `DISCONNECTED` - Not connected

---

## 📋 List All Sessions

```bash
curl https://your-domain.com/api/sessions \
  -H "X-API-Key: YOUR_API_KEY"
```

---

## 💬 Advanced: Send Media

### Send Image
```bash
curl -X POST https://your-domain.com/api/messages/my-whatsapp-1/send-media \
  -H "X-API-Key: YOUR_API_KEY" \
  -F "to=1234567890@s.whatsapp.net" \
  -F "file=@/path/to/image.jpg" \
  -F "caption=Check this out!"
```

### Send Document
```bash
curl -X POST https://your-domain.com/api/messages/my-whatsapp-1/send-media \
  -H "X-API-Key: YOUR_API_KEY" \
  -F "to=1234567890@s.whatsapp.net" \
  -F "file=@/path/to/document.pdf" \
  -F "caption=Important document"
```

---

## 🔄 Webhooks (Optional)

Configure webhooks to receive message events:

```bash
curl -X POST https://your-domain.com/api/webhooks \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{
    "url": "https://your-server.com/webhook",
    "events": ["message", "status"],
    "sessionId": "my-whatsapp-1"
  }'
```

---

## 🎯 Complete Example Flow

```bash
# 1. Register
RESPONSE=$(curl -s -X POST https://your-domain.com/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"test123","name":"Test User"}')

# Extract API key (using jq)
API_KEY=$(echo $RESPONSE | jq -r '.data.user.apiKey')
echo "API Key: $API_KEY"

# 2. Create session
curl -X POST https://your-domain.com/api/sessions \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{"sessionId":"my-session","usePairingCode":false}'

# 3. Get QR code
curl https://your-domain.com/api/sessions/my-session \
  -H "X-API-Key: $API_KEY" | jq -r '.data.qrCode'

# Scan QR code with WhatsApp mobile app
# Wait for status to become CONNECTED

# 4. Send message
curl -X POST https://your-domain.com/api/messages/my-session/send \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{"to":"1234567890@s.whatsapp.net","message":"Hello!"}'
```

---

## 📚 API Documentation

**Full API Docs:** https://your-domain.com/api-docs

**Dashboard:** https://your-domain.com/dashboard

**Health Check:** https://your-domain.com/health

---

## 🛠️ Troubleshooting

**QR Code expired?**
- Create a new session or delete and recreate

**Session disconnected?**
- Check WhatsApp is connected on mobile
- Restart session via API

**Can't send messages?**
- Verify session status is `CONNECTED`
- Check phone number format
- Ensure WhatsApp account is not banned

---

## 🔐 Security Tips

- ✅ Keep your API key secret
- ✅ Use HTTPS always
- ✅ Rotate API keys regularly
- ✅ Set up webhooks with signature verification
- ✅ Implement rate limiting on your end

---

**Ready to integrate!** 🚀
