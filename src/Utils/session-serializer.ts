import { WhatsAppSession, SessionResponse } from '../Types/api.js';

/**
 * Converts a WhatsAppSession to a serializable SessionResponse
 * Excludes socket and other circular/non-serializable properties
 */
export function serializeSession(session: WhatsAppSession): SessionResponse {
  return {
    sessionId: session.id,
    status: session.status,
    qrCode: session.qrCode,
    pairingCode: session.pairingCode,
    phoneNumber: session.phoneNumber,
    name: session.name,
    lastSeen: session.lastSeen
  };
}

/**
 * Converts multiple WhatsAppSessions to serializable format
 */
export function serializeSessions(sessions: WhatsAppSession[]): SessionResponse[] {
  return sessions.map(serializeSession);
}
