import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useEffect } from 'react';
import styles from './Home.module.css';

const Home = () => {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();

  // Redirect if already logged in
  useEffect(() => {
    if (isAuthenticated()) {
      navigate('/sessions');
    }
  }, [isAuthenticated, navigate]);

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <h1>🚀 WhatsApp API</h1>
        <h2>Multi-Device WhatsApp Business API</h2>

        <div className={styles.info}>
          <p>
            Connect multiple WhatsApp accounts, send messages programmatically,
            manage groups, and integrate WhatsApp into your applications.
          </p>
          <p className={styles.subInfo}>
            Built with Baileys - No official WhatsApp Business API subscription required.
          </p>
        </div>

        <Link to="/register" className={styles.btn}>
          Get Started
        </Link>

        <Link to="/login" className={styles.btnSecondary}>
          Login
        </Link>

        <div className={styles.footer}>
          <a href="/api-docs" className={styles.link}>
            📚 API Documentation
          </a>
        </div>
      </div>
    </div>
  );
};

export default Home;
