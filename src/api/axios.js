// src/api/axios.js
import axios from 'axios';

const BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

const api = axios.create({
  baseURL: BASE_URL,
  timeout: 15000,
});

// Attach token to every request
api.interceptors.request.use(config => {
  const token = localStorage.getItem('accessToken');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Handle 401 - auto refresh or logout
let isRefreshing = false;
let failedQueue = [];

const processQueue = (error, token = null) => {
  failedQueue.forEach(prom => error ? prom.reject(error) : prom.resolve(token));
  failedQueue = [];
};

api.interceptors.response.use(
  res => res,
  async err => {
    const original = err.config;
    if (err.response?.status === 401 && !original._retry) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        }).then(token => {
          original.headers.Authorization = `Bearer ${token}`;
          return api(original);
        });
      }
      original._retry = true;
      isRefreshing = true;
      const refreshToken = localStorage.getItem('refreshToken');
      if (!refreshToken) {
        window.dispatchEvent(new Event('auth:logout'));
        return Promise.reject(err);
      }
      try {
        const { data } = await axios.post(`${BASE_URL}/auth/refresh`, { refreshToken });
        localStorage.setItem('accessToken', data.accessToken);
        localStorage.setItem('refreshToken', data.refreshToken);
        processQueue(null, data.accessToken);
        original.headers.Authorization = `Bearer ${data.accessToken}`;
        return api(original);
      } catch (refreshErr) {
        processQueue(refreshErr, null);
        window.dispatchEvent(new Event('auth:logout'));
        return Promise.reject(refreshErr);
      } finally {
        isRefreshing = false;
      }
    }
    return Promise.reject(err);
  }
);

export default api;

// ─── API helpers ───────────────────────────────────────────────

export const authAPI = {
  login: (email, password) => api.post('/auth/login', { email, password }),
  me: () => api.get('/auth/me'),
  changePassword: (data) => api.post('/auth/change-password', data),
};

export const studentAPI = {
  list: (params) => api.get('/students', { params }),
  get: (id) => api.get(`/students/${id}`),
  create: (data) => api.post('/students', data),
  update: (id, data) => api.put(`/students/${id}`, data),
  delete: (id) => api.delete(`/students/${id}`),
};

export const teacherAPI = {
  list: (params) => api.get('/teachers', { params }),
  get: (id) => api.get(`/teachers/${id}`),
  create: (data) => api.post('/teachers', data),
  update: (id, data) => api.put(`/teachers/${id}`, data),
  delete: (id) => api.delete(`/teachers/${id}`),
  markAttendance: (records) => api.post('/teachers/attendance/mark', { records }),
};

export const attendanceAPI = {
  get: (params) => api.get('/attendance', { params }),
  save: (data) => api.post('/attendance', data),
  analysis: (params) => api.get('/attendance/analysis', { params }),
  student: (id, params) => api.get(`/attendance/student/${id}`, { params }),
};

export const feeAPI = {
  list: (params) => api.get('/fees', { params }),
  summary: () => api.get('/fees/summary'),
  history: (studentId) => api.get(`/fees/student/${studentId}/history`),
  pay: (data) => api.post('/fees/pay', data),
};

export const marksAPI = {
  get: (params) => api.get('/marks', { params }),
  save: (entries) => api.post('/marks', { entries }),
  student: (id) => api.get(`/marks/student/${id}`),
};

export const testAPI = {
  list: (params) => api.get('/tests', { params }),
  create: (data) => api.post('/tests', data),
  updateEntries: (id, entries) => api.put(`/tests/${id}/entries`, { entries }),
};

export const timetableAPI = {
  get: (params) => api.get('/timetable', { params }),
  save: (data) => api.post('/timetable', data),
};

export const schoolAPI = {
  config: () => api.get('/school/config'),
  updateConfig: (data) => api.put('/school/config', data),
  classes: () => api.get('/school/classes'),
};

export const dashboardAPI = {
  stats: () => api.get('/dashboard/stats'),
  charts: () => api.get('/dashboard/charts'),
};
