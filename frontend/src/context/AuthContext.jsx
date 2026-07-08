import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { authAPI } from '../services/api';

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [apiKey, setApiKey] = useState(null);

  // Load auth data from localStorage on mount
  useEffect(() => {
    const storedUser = localStorage.getItem('user');
    const storedApiKey = localStorage.getItem('apiKey');

    if (storedUser && storedApiKey) {
      setUser(JSON.parse(storedUser));
      setApiKey(storedApiKey);
    }

    setLoading(false);
  }, []);

  // Login
  const login = async (email, password) => {
    const response = await authAPI.login(email, password);
    const { user } = response.data;

    setUser(user);
    setApiKey(user.apiKey);

    localStorage.setItem('user', JSON.stringify(user));
    localStorage.setItem('apiKey', user.apiKey);

    return response;
  };

  // Register
  const register = async (email, name, password, registerPassword) => {
    const response = await authAPI.register(email, name, password, registerPassword);
    const { user } = response.data;

    setUser(user);
    setApiKey(user.apiKey);

    localStorage.setItem('user', JSON.stringify(user));
    localStorage.setItem('apiKey', user.apiKey);

    return response;
  };

  // Logout
  const logout = () => {
    setUser(null);
    setApiKey(null);
    localStorage.removeItem('user');
    localStorage.removeItem('apiKey');
  };

  // Check if authenticated
  const isAuthenticated = useCallback(() => {
    return !!user && !!apiKey;
  }, [user, apiKey]);

  const value = {
    user,
    apiKey,
    loading,
    login,
    register,
    logout,
    isAuthenticated
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

// Custom hook to use auth context
export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};
