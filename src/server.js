require('dotenv').config();

const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const morgan       = require('morgan');
const compression  = require('compression');
const fs           = require('fs');
const path         = require('path');

const routes       = require('./routes/index');
const errorHandler = require('./middleware/errorHandler');
const { generalLimiter } = require('./middleware/rateLimiter');
const logger       = require('./config/logger');
const { poolPromise } = require('./config/db'); // Added DB pool check

// ── Ensure logs dir exists ────────────────────────────────────
const logsDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);

const app  = express();
const PORT = process.env.PORT || 8080;

// ── Trust Azure proxy ─────────────────────────────────────────
// Azure Web Apps use a reverse proxy. This ensures req.ip and rate limiters work correctly.
app.set('trust proxy', 1);

// ── Security & Compression ────────────────────────────────────
app.use(helmet());
app.use(compression());
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? [process.env.APP_URL] // Restrict to your frontend domain in production
    : '*',
  credentials: true,
}));

// ── Request logging ───────────────────────────────────────────
app.use(morgan('combined', {
  stream: { write: (msg) => logger.info(msg.trim()) }
}));

// ── Body parsers ──────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Rate limiter (global) ─────────────────────────────────────
app.use('/api/', generalLimiter);

// ── Health check (Azure requires this) ───────────────────────
app.get('/health', async (req, res) => {
  try {
    const pool = await poolPromise;
    await pool.request().query('SELECT 1'); // Simple DB ping
    res.status(200).json({
      status:    'ok',
      database:  'connected',
      timestamp: new Date().toISOString(),
      uptime:    process.uptime(),
    });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', error: err.message });
  }
});

// ── API Routes ────────────────────────────────────────────────
app.use('/api/v1', routes);

// ── 404 Handler ───────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// ── Global Error Handler ──────────────────────────────────────
app.use(errorHandler);

// ── Start Server with DB Warm-up ──────────────────────────────
const startServer = async () => {
  try {
    // Ensure DB is reachable before accepting requests
    await poolPromise;
    logger.info('✅ Azure SQL Connection established');

    app.listen(PORT, () => {
      logger.info(`🚀 Server running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
    });
  } catch (err) {
    logger.error('❌ Failed to connect to database:', err);
    process.exit(1);
  }
};

startServer();

// ── Graceful shutdown ─────────────────────────────────────────
process.on('SIGTERM', () => {
  logger.info('SIGTERM received — shutting down gracefully');
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
});

module.exports = app;