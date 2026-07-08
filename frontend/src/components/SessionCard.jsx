import { useState, useEffect } from 'react';
import { sessionsAPI } from '../services/api';
import styles from './SessionCard.module.css';

const SessionCard = ({ session, onRefresh, onDelete }) => {
  const [deleting, setDeleting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [restarting, setRestarting] = useState(false);

  // Cleanup timeout on unmount to prevent memory leaks
  useEffect(() => {
    let timeoutId;
    if (copied) {
      timeoutId = setTimeout(() => setCopied(false), 2000);
    }
    return () => {
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [copied]);

  const handleCopy = async () => {
    try {
      // Check if Clipboard API is available
      if (!navigator.clipboard) {
        throw new Error('Clipboard API not supported in this browser');
      }
      await navigator.clipboard.writeText(session.sessionId);
      setCopied(true);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const handleReconnect = async () => {
    if (!window.confirm(`Reconnect session "${session.sessionId}" using existing credentials?`)) {
      return;
    }

    setReconnecting(true);
    try {
      await sessionsAPI.reconnect(session.sessionId);
      // Trigger parent to reload sessions to show updated status
      await onRefresh(session.sessionId);
    } catch (error) {
      console.error('Reconnect failed:', error);
      alert('Failed to reconnect: ' + (error.response?.data?.error || error.message));
    } finally {
      setReconnecting(false);
    }
  };

  const handleRestart = async () => {
    if (!window.confirm(`Restart session "${session.sessionId}"? This will delete existing credentials and require scanning a new QR code.`)) {
      return;
    }

    setRestarting(true);
    try {
      await sessionsAPI.restart(session.sessionId);
      // Trigger parent to reload sessions to show new QR code
      await onRefresh(session.sessionId);
    } catch (error) {
      console.error('Restart failed:', error);
      alert('Failed to restart: ' + (error.response?.data?.error || error.message));
    } finally {
      setRestarting(false);
    }
  };

  const getStatusClass = (status) => {
    const statusMap = {
      'CONNECTED': styles.statusConnected,
      'CONNECTING': styles.statusConnecting,
      'DISCONNECTED': styles.statusDisconnected,
      'QR_REQUIRED': styles.statusQrRequired,
      'PAIRING_REQUIRED': styles.statusQrRequired,
      'ERROR': styles.statusDisconnected
    };
    return statusMap[status] || styles.statusDisconnected;
  };

  const handleDelete = async () => {
    if (!window.confirm(`Are you sure you want to delete session "${session.sessionId}"?`)) {
      return;
    }

    setDeleting(true);
    try {
      await onDelete(session.sessionId);
    } catch (error) {
      console.error('Delete failed:', error);
      setDeleting(false);
    }
  };

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <div className={styles.sessionIdRow}>
          <div className={styles.sessionId}>{session.sessionId}</div>
          <button
            onClick={handleCopy}
            className={styles.copyBtn}
            title="Copy session ID"
            aria-label={copied ? 'Session ID copied' : 'Copy session ID to clipboard'}
          >
            {copied ? '✓' : '📋'}
          </button>
        </div>
        <span className={`${styles.statusBadge} ${getStatusClass(session.liveStatus)}`}>
          {session.liveStatus}
        </span>
      </div>

      {session.phoneNumber && (
        <div className={styles.phoneNumber}>
          📞 {session.phoneNumber}
        </div>
      )}

      {session.qrCode && (
        <div className={styles.qrCode}>
          <img src={session.qrCode} alt="QR Code" />
          <p className={styles.qrHelp}>Scan with WhatsApp to connect</p>
        </div>
      )}

      <div className={styles.actions}>
        <button
          onClick={() => onRefresh(session.sessionId)}
          className={styles.btnSecondary}
          title="Refresh session status"
        >
          🔄 Refresh
        </button>
        <button
          onClick={handleReconnect}
          disabled={reconnecting}
          className={styles.btnPrimary}
          title="Reconnect using existing credentials"
        >
          {reconnecting ? '⏳ Reconnecting...' : '🔌 Reconnect'}
        </button>
        <button
          onClick={handleRestart}
          disabled={restarting}
          className={styles.btnWarning}
          title="Delete and restart (requires new QR code)"
        >
          {restarting ? '⏳ Restarting...' : '♻️ Restart'}
        </button>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className={styles.btnDanger}
          title="Delete session permanently"
        >
          {deleting ? 'Deleting...' : '🗑️ Delete'}
        </button>
      </div>
    </div>
  );
};

export default SessionCard;
