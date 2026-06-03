// src/server.js
require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const compression= require('compression');
const rateLimit  = require('express-rate-limit');
const { getPool }= require('./config/db');
const logger     = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');

const app = express();

// ── Security & compression ─────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(compression());

// ── CORS ──────────────────────────────────────────────────────────────
// ── CORS ──────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:3000,https://dpw5tz.csb.app').split(',');

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-School-Id'],
}));
app.options('*', cors());

// ── Body parsing ──────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Logging ───────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined', {
    stream: { write: (msg) => logger.info(msg.trim()) },
  }));
}

// ── Rate limiting ──────────────────────────────────────────────────────
app.use('/api/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 20,
  message: { success: false, message: 'Too many login attempts. Try after 15 minutes.' },
}));

app.use('/api/', rateLimit({
  windowMs: 1 * 60 * 1000,  // 1 min
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests' },
}));

// ── Health check ───────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', env: process.env.NODE_ENV, ts: new Date().toISOString() });
});

// ── API Routes ─────────────────────────────────────────────────────────
const API = '/api';

app.use(`${API}/auth`,          require('./routes/auth'));
app.use(`${API}/dashboard`,     require('./routes/dashboard'));
app.use(`${API}/setup`,         require('./routes/setup'));
app.use(`${API}/students`,      require('./routes/students'));
app.use(`${API}/teachers`,      require('./routes/teachers'));
app.use(`${API}/attendance`,    require('./routes/attendance'));
app.use(`${API}/fees`,          require('./routes/fees'));
app.use(`${API}/results`,       require('./routes/results'));
app.use(`${API}/timetables`,    require('./routes/timetables'));
app.use(`${API}/quick-tests`,   require('./routes/quickTests'));
app.use(`${API}/exams`,         require('./routes/exams'));
app.use(`${API}/notices`,       require('./routes/notices'));
app.use(`${API}/homework`,      require('./routes/homework'));

// ── 404 ────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.path} not found` });
});

// ── Global error handler ───────────────────────────────────────────────
app.use(errorHandler);

// ── Start ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;

const start = async () => {
  try {
    await getPool();                       // warm up DB pool on startup
    app.listen(PORT, () => {
      logger.info(`🚀 School ERP API running on port ${PORT} [${process.env.NODE_ENV}]`);
      logger.info(`📡 Azure SQL: ${process.env.DB_SERVER}/${process.env.DB_DATABASE}`);
    });
  } catch (err) {
    logger.error('❌ Startup failed:', err.message);
    process.exit(1);
  }
};

start();

module.exports = app; // for testing
