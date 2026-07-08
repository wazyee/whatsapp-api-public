import axios from 'axios';

// Create axios instance
const api = axios.create({
  baseURL: '/api',
  headers: {
    'Content-Type': 'application/json'
  }
});

// Request interceptor to add API key
api.interceptors.request.use(
  (config) => {
    const apiKey = localStorage.getItem('apiKey');
    if (apiKey) {
      config.headers['X-API-Key'] = apiKey;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor to handle errors
api.interceptors.response.use(
  (response) => response.data,
  (error) => {
    const message = error.response?.data?.error || error.message || 'Something went wrong';
    return Promise.reject(new Error(message));
  }
);

// Auth API
export const authAPI = {
  register: (email, name, password, registerPassword) =>
    api.post('/auth/register', { email, name, password, registerPassword }),

  login: (email, password) =>
    api.post('/auth/login', { email, password }),

  getProfile: () =>
    api.get('/auth/me'),

  refreshApiKey: () =>
    api.post('/auth/refresh-api-key'),

  changePassword: (currentPassword, newPassword) =>
    api.post('/auth/change-password', { currentPassword, newPassword })
};

// Sessions API
export const sessionsAPI = {
  getAll: () =>
    api.get('/sessions'),

  create: (sessionId, usePairingCode) =>
    api.post('/sessions', { sessionId, usePairingCode }),

  get: (sessionId) =>
    api.get(`/sessions/${sessionId}`),

  delete: (sessionId) =>
    api.delete(`/sessions/${sessionId}`),

  getQR: (sessionId) =>
    api.get(`/sessions/${sessionId}/qr`),

  getStatus: (sessionId) =>
    api.get(`/sessions/${sessionId}/status`),

  reconnect: (sessionId) =>
    api.post(`/sessions/${sessionId}/reconnect`),

  restart: (sessionId) =>
    api.post(`/sessions/${sessionId}/restart`)
};

// Chats API
export const chatsAPI = {
  getAll: (sessionId) =>
    api.get(`/chats/${sessionId}`)
};

// Messages API
export const messagesAPI = {
  sendText: (sessionId, to, text) =>
    api.post(`/messages/${sessionId}/send`, {
      to,
      type: 'text',
      content: { text }
    })
};

// Contacts API
export const contactsAPI = {
  getAll: (sessionId) =>
    api.get(`/contacts/${sessionId}`),

  listFromMessages: (sessionId) =>
    api.get(`/contacts/${sessionId}/list-from-messages`)
};

// Groups API
export const groupsAPI = {
  getMetadata: (sessionId, groupId) =>
    api.get(`/groups/${sessionId}/${groupId}/metadata`),

  listFromMessages: (sessionId) =>
    api.get(`/groups/${sessionId}/list-from-messages`)
};

export default api;
