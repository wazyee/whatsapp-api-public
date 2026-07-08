import { useState, useEffect } from 'react';
import { messagesAPI, contactsAPI, groupsAPI } from '../services/api';
import { useAuth } from '../context/AuthContext';
import SearchableSelect from './SearchableSelect';
import styles from './MessageComposer.module.css';

const MessageComposer = ({ sessions }) => {
  const { apiKey } = useAuth();
  const [selectedSession, setSelectedSession] = useState('');
  const [recipientType, setRecipientType] = useState('contact'); // 'contact' or 'group'
  const [contacts, setContacts] = useState([]);
  const [groups, setGroups] = useState([]);
  const [selectedRecipient, setSelectedRecipient] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingChats, setLoadingChats] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [copied, setCopied] = useState(false);

  // Load contacts and groups when session is selected
  useEffect(() => {
    let isMounted = true;

    if (selectedSession) {
      const loadChats = async () => {
        setLoadingChats(true);
        setError('');
        try {
          // Load contacts and groups from messages in parallel
          const [contactsResponse, groupsResponse] = await Promise.all([
            contactsAPI.listFromMessages(selectedSession),
            groupsAPI.listFromMessages(selectedSession)
          ]);

          if (!isMounted) return;

          const contactsList = (contactsResponse.data || []).map(contact => ({
            value: contact.jid,
            label: `+${contact.phoneNumber}`,
            sublabel: contact.jid,
            icon: '📱'
          }));

          const groupsList = (groupsResponse.data || []).map(group => ({
            value: group.jid,
            label: group.name,
            sublabel: `${group.participants} participants`,
            icon: '👥'
          }));

          if (isMounted) {
            setContacts(contactsList);
            setGroups(groupsList);
          }
        } catch (err) {
          if (isMounted) {
            setError('Failed to load chats: ' + err.message);
          }
        } finally {
          if (isMounted) {
            setLoadingChats(false);
          }
        }
      };

      loadChats();
    } else {
      setContacts([]);
      setGroups([]);
      setSelectedRecipient('');
    }

    return () => {
      isMounted = false;
    };
  }, [selectedSession]);

  // Format phone number to JID
  const formatPhoneToJid = (phone) => {
    // Remove all non-numeric characters
    let cleaned = phone.replace(/\D/g, '');

    // If number starts with 0, it's likely a local number without country code
    // Remove the leading 0, but user must provide the country code separately
    // or enter the full international number
    if (cleaned.startsWith('0')) {
      cleaned = cleaned.substring(1);
    }

    // Return the number as-is (should be in international format without + or 0 prefix)
    return `${cleaned}@s.whatsapp.net`;
  };

  const handleSend = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);

    try {
      let recipient = selectedRecipient;

      // If contact type and phone number is entered, use that
      if (recipientType === 'contact' && phoneNumber && !selectedRecipient) {
        recipient = formatPhoneToJid(phoneNumber);
      }

      if (!recipient) {
        setError('Please select a recipient or enter a phone number');
        setLoading(false);
        return;
      }

      await messagesAPI.sendText(selectedSession, recipient, message);
      setSuccess('Message sent successfully!');
      setMessage('');
      setPhoneNumber('');
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError('Failed to send message: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  const generateLLMPrompt = () => {
    let recipient = selectedRecipient;
    if (recipientType === 'contact' && phoneNumber && !selectedRecipient) {
      recipient = formatPhoneToJid(phoneNumber);
    }

    if (!selectedSession || !recipient) {
      return null;
    }

    const apiUrl = window.location.origin;
    const recipientLabel = recipientType === 'group'
      ? groups.find(g => g.value === recipient)?.label || recipient
      : contacts.find(c => c.value === recipient)?.label || phoneNumber || recipient;

    return `# WhatsApp Message API Configuration

**API Endpoint:** \`${apiUrl}/api/messages/${selectedSession}/send\`
**Method:** POST
**API Key:** \`${apiKey || 'YOUR_API_KEY'}\`
**Session:** \`${selectedSession}\`
**Recipient:** \`${recipient}\`
**Recipient Type:** ${recipientType === 'group' ? 'Group' : 'Contact'} (${recipientLabel})

## Headers Required
\`\`\`
Content-Type: application/json
X-API-Key: ${apiKey || 'YOUR_API_KEY'}
\`\`\`

## Request Body Format
\`\`\`json
{
  "to": "${recipient}",
  "content": {
    "text": "YOUR_MESSAGE_HERE"
  }
}
\`\`\`

## Message Formatting Rules
- **Bold text:** Wrap in asterisks: \`*bold*\`
- **Italic text:** Wrap in underscores: \`_italic_\`
- **Strikethrough:** Wrap in tildes: \`~strikethrough~\`
- **Monospace:** Wrap in triple backticks: \`\`\`monospace\`\`\`
- **Line breaks:** Use \\n
- **Emojis:** Use standard emojis directly in text

## Example Message Formats

### Example 1: Event/Ticket Purchase
\`\`\`
🎟️ *Event Name*
_DD.MM.YY HH:MM_

💰 Purchase: *123.45 EUR*
🎫 Tickets: *5*

👤 Customer Name
📧 email@example.com
\`\`\`

### Example 2: New Lead
\`\`\`
🆕 *New Lead Received*
_DD.MM.YY HH:MM_

👤 Name: *John Doe*
📧 Email: *john@example.com*
📱 Phone: *+49 176 XXX XXXX*
💼 Company: *Example GmbH*

📝 Message:
_Lead message or inquiry details here_
\`\`\`

### Example 3: Order Confirmation
\`\`\`
🛒 *New Order #12345*
_DD.MM.YY HH:MM_

💰 Total: *456.78 EUR*
📦 Items: *3*

👤 Customer Name
📧 email@example.com
📍 Shipping City, Country
\`\`\`

## Example cURL Command
\`\`\`bash
curl -X POST "${apiUrl}/api/messages/${selectedSession}/send" \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: ${apiKey || 'YOUR_API_KEY'}" \\
  -d '{
    "to": "${recipient}",
    "content": {
      "text": "🎟️ *Your Message Here*\\n_Timestamp_\\n\\n💰 Info: *Value*"
    }
  }'
\`\`\`

---
Use this configuration to send WhatsApp messages via the API.`;
  };

  const handleCopyForLLM = () => {
    const prompt = generateLLMPrompt();
    if (!prompt) {
      setError('Please select a session and recipient first');
      return;
    }

    navigator.clipboard.writeText(prompt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      setError('Failed to copy to clipboard');
    });
  };

  // Generate curl command
  const generateCurl = () => {
    if (!selectedSession || !message) {
      return '# Fill in all fields to see the curl command';
    }

    let recipient = selectedRecipient;
    if (recipientType === 'contact' && phoneNumber && !selectedRecipient) {
      recipient = formatPhoneToJid(phoneNumber);
    }

    if (!recipient) {
      return '# Select a recipient or enter a phone number';
    }

    const apiUrl = window.location.origin;
    const endpoint = `/api/messages/${selectedSession}/send`;

    return `curl -X POST "${apiUrl}${endpoint}" \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: ${apiKey || 'YOUR_API_KEY'}" \\
  -d '{
    "to": "${recipient}",
    "content": {
      "text": "${message.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"
    }
  }'`;
  };

  const sessionOptions = sessions.map(s => ({
    value: s.sessionId,
    label: s.sessionId,
    sublabel: s.liveStatus,
    icon: s.liveStatus === 'CONNECTED' ? '✓' : '○'
  }));

  const recipientOptions = recipientType === 'contact' ? contacts : groups;

  return (
    <div className={styles.container}>
      <h2>Send Message</h2>

      {error && <div className={styles.error}>{error}</div>}
      {success && <div className={styles.success}>{success}</div>}

      <form onSubmit={handleSend} className={styles.form}>
        <SearchableSelect
          label="Select Session"
          options={sessionOptions}
          value={selectedSession}
          onChange={setSelectedSession}
          placeholder="Choose a session..."
          disabled={sessions.length === 0}
        />

        <div className={styles.recipientTypeGroup}>
          <label className={styles.radioLabel}>
            <input
              type="radio"
              value="contact"
              checked={recipientType === 'contact'}
              onChange={(e) => {
                setRecipientType(e.target.value);
                setSelectedRecipient('');
                setPhoneNumber('');
              }}
            />
            Contact (Phone Number)
          </label>
          <label className={styles.radioLabel}>
            <input
              type="radio"
              value="group"
              checked={recipientType === 'group'}
              onChange={(e) => {
                setRecipientType(e.target.value);
                setSelectedRecipient('');
                setPhoneNumber('');
              }}
            />
            Group
          </label>
        </div>

        {recipientType === 'group' && (
          <SearchableSelect
            label="Select Group"
            options={groups}
            value={selectedRecipient}
            onChange={setSelectedRecipient}
            placeholder={
              loadingChats
                ? 'Loading groups...'
                : groups.length === 0
                  ? 'No groups found'
                  : 'Search and select...'
            }
            disabled={!selectedSession || loadingChats}
          />
        )}

        {recipientType === 'contact' && (
          <>
            {contacts.length > 0 && (
              <SearchableSelect
                label="Select Recent Contact"
                options={contacts}
                value={selectedRecipient}
                onChange={(value) => {
                  setSelectedRecipient(value);
                  setPhoneNumber('');
                }}
                placeholder={
                  loadingChats
                    ? 'Loading contacts...'
                    : 'Or select a recent contact...'
                }
                disabled={!selectedSession || loadingChats || phoneNumber}
              />
            )}

            <div className={styles.orDivider}>
              {contacts.length > 0 && <span>OR</span>}
            </div>

            <div className={styles.formGroup}>
              <label htmlFor="phoneNumber">
                {contacts.length > 0 ? 'Enter Phone Number' : 'Enter Phone Number'}
              </label>
              <input
                type="text"
                id="phoneNumber"
                value={phoneNumber}
                onChange={(e) => {
                  setPhoneNumber(e.target.value);
                  setSelectedRecipient('');
                }}
                placeholder="+Country Phone"
                disabled={!selectedSession || selectedRecipient}
              />
              <small className={styles.hint}>
                Enter with country code (e.g., +351 9XX XXX XXX, +49 176 XXX XXXX)
              </small>
            </div>
          </>
        )}

        <div className={styles.formGroup}>
          <label htmlFor="message">Message</label>
          <textarea
            id="message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Type your message here..."
            rows={4}
            required
            disabled={recipientType === 'group' ? !selectedRecipient : !selectedRecipient && !phoneNumber}
          />
        </div>

        <div className={styles.buttonGrid}>
          <button
            type="submit"
            disabled={loading || !selectedSession || !message || (recipientType === 'group' ? !selectedRecipient : !selectedRecipient && !phoneNumber)}
            className={styles.sendBtn}
          >
            {loading ? 'Sending...' : '📤 Send Message'}
          </button>
          <button
            type="button"
            onClick={handleCopyForLLM}
            disabled={!selectedSession || (recipientType === 'group' ? !selectedRecipient : !selectedRecipient && !phoneNumber)}
            className={styles.copyBtn}
          >
            {copied ? '✓ Copied!' : '🤖 Copy for LLM'}
          </button>
        </div>
      </form>

      <div className={styles.curlSection}>
        <h3>Equivalent curl command:</h3>
        <pre className={styles.curlCode}>
          <code>{generateCurl()}</code>
        </pre>
      </div>
    </div>
  );
};

export default MessageComposer;
