import { useState, useEffect } from 'react';
import { authAPI } from '../services/api';
import styles from './ApiKeySection.module.css';

const ApiKeySection = ({ apiKey, onRefresh }) => {
  const [isVisible, setIsVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

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
      await navigator.clipboard.writeText(apiKey);
      setCopied(true);
      setError('');
    } catch (err) {
      console.error('Failed to copy:', err);
      setError('Failed to copy API key. Please copy manually.');
    }
  };

  const handleRefresh = async () => {
    if (!window.confirm('This will invalidate your old API key. All applications using the old key will stop working. Continue?')) {
      return;
    }

    setRefreshing(true);
    setError('');
    try {
      const response = await authAPI.refreshApiKey();
      onRefresh(response.data.apiKey);
    } catch (err) {
      setError('Failed to refresh API key: ' + err.message);
    } finally {
      setRefreshing(false);
    }
  };

  const displayKey = isVisible ? apiKey : '•'.repeat(apiKey.length);

  return (
    <div className={styles.container}>
      <h3>Your API Key</h3>
      {error && <div className={styles.error}>{error}</div>}
      <div className={styles.keyBox}>
        <code className={styles.key} aria-label="API Key">{displayKey}</code>
        <div className={styles.actions}>
          <button
            onClick={() => setIsVisible(!isVisible)}
            className={styles.btn}
            title={isVisible ? 'Hide API key' : 'Show API key'}
            aria-label={isVisible ? 'Hide API key' : 'Show API key'}
            aria-pressed={isVisible}
          >
            {isVisible ? '🙈 Hide' : '👁 Show'}
          </button>
          <button
            onClick={handleCopy}
            className={styles.btn}
            title="Copy to clipboard"
            aria-label={copied ? 'API key copied' : 'Copy API key to clipboard'}
          >
            {copied ? '✓ Copied' : '📋 Copy'}
          </button>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className={styles.btn}
            title="Generate new API key"
            aria-label="Generate new API key"
            aria-busy={refreshing}
          >
            {refreshing ? '⏳ Refreshing...' : '🔄 Refresh'}
          </button>
        </div>
      </div>
      <p className={styles.hint}>
        Keep this secure - it's used for all API requests to your WhatsApp sessions.
      </p>
    </div>
  );
};

export default ApiKeySection;
