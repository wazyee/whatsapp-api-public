import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { sessionsAPI } from '../services/api';
import SessionCard from '../components/SessionCard';
import ApiKeySection from '../components/ApiKeySection';
import MessageComposer from '../components/MessageComposer';
import styles from './Sessions.module.css';

const Sessions = () => {
  const { user, logout, apiKey: contextApiKey } = useAuth();
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [createLoading, setCreateLoading] = useState(false);
  const [newSessionId, setNewSessionId] = useState('');
  const [activeTab, setActiveTab] = useState('connections');
  const [apiKey, setApiKey] = useState(contextApiKey);

  // Load sessions
  const loadSessions = useCallback(async () => {
    try {
      const response = await sessionsAPI.getAll();
      setSessions(response.data || []);
      setError('');
    } catch (err) {
      setError(err.message);
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    loadSessions();

    // Auto-refresh every 10 seconds
    const interval = setInterval(loadSessions, 10000);

    return () => clearInterval(interval);
  }, [loadSessions]);

  // Create session
  const handleCreateSession = async (e) => {
    e.preventDefault();

    if (!newSessionId.trim()) {
      return;
    }

    setCreateLoading(true);
    setError('');

    try {
      await sessionsAPI.create(newSessionId.trim(), false);
      setNewSessionId('');
      await loadSessions();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreateLoading(false);
    }
  };

  // Refresh single session
  const handleRefresh = async (sessionId) => {
    try {
      // Reload all sessions to get latest status and any QR codes
      await loadSessions();
    } catch (err) {
      console.error('Failed to refresh session:', err);
    }
  };

  // Delete session
  const handleDelete = async (sessionId) => {
    try {
      await sessionsAPI.delete(sessionId);
      await loadSessions();
    } catch (err) {
      setError(err.message);
    }
  };

  // Handle API key refresh
  const handleApiKeyRefresh = (newApiKey) => {
    setApiKey(newApiKey);
    // Update localStorage
    const storedUser = JSON.parse(localStorage.getItem('user'));
    if (storedUser) {
      storedUser.apiKey = newApiKey;
      localStorage.setItem('user', JSON.stringify(storedUser));
      localStorage.setItem('apiKey', newApiKey);
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.navbar}>
        <h1>📱 WhatsApp API Dashboard</h1>
        <div className={styles.userInfo}>
          <span>{user?.email}</span>
          <button onClick={logout} className={styles.logoutBtn}>
            Logout
          </button>
        </div>
      </div>

      <div className={styles.tabs}>
        <button
          className={`${styles.tab} ${activeTab === 'connections' ? styles.activeTab : ''}`}
          onClick={() => setActiveTab('connections')}
        >
          Connections
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'send' ? styles.activeTab : ''}`}
          onClick={() => setActiveTab('send')}
        >
          Send Message
        </button>
        <a
          href="/api-docs/#/"
          target="_blank"
          rel="noopener noreferrer"
          className={styles.docLink}
        >
          Documentation →
        </a>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {activeTab === 'connections' && (
        <>
          <ApiKeySection
            apiKey={apiKey}
            onRefresh={handleApiKeyRefresh}
          />

          <div className={styles.createForm}>
            <h3>Create New Session</h3>
            <form onSubmit={handleCreateSession}>
              <div className={styles.formRow}>
                <div className={styles.formGroup}>
                  <label htmlFor="sessionId">Session ID</label>
                  <input
                    type="text"
                    id="sessionId"
                    value={newSessionId}
                    onChange={(e) => setNewSessionId(e.target.value)}
                    placeholder="my-whatsapp-session"
                    pattern="[a-zA-Z0-9-_]+"
                    title="Only letters, numbers, hyphens and underscores"
                    required
                  />
                </div>
                <button
                  type="submit"
                  disabled={createLoading}
                  className={styles.createBtn}
                >
                  {createLoading ? 'Creating...' : 'Create Session'}
                </button>
              </div>
            </form>
          </div>

          {loading ? (
            <div className={styles.loading}>Loading sessions...</div>
          ) : sessions.length === 0 ? (
            <div className={styles.empty}>
              <h3>No sessions yet</h3>
              <p>Create your first WhatsApp session to get started</p>
            </div>
          ) : (
            <div className={styles.grid}>
              {sessions.map((session) => (
                <SessionCard
                  key={session.sessionId}
                  session={session}
                  onRefresh={handleRefresh}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          )}
        </>
      )}

      {activeTab === 'send' && (
        <MessageComposer sessions={sessions.filter(s => s.liveStatus === 'CONNECTED')} />
      )}
    </div>
  );
};

export default Sessions;
