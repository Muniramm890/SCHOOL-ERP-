// src/config/db.js
const sql = require('mssql');
const logger = require('../utils/logger');

const config = {
  server: process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  port: parseInt(process.env.DB_PORT) || 1433,
  options: {
    encrypt: true,            // Required for Azure SQL
    trustServerCertificate: false,
    enableArithAbort: true,
    connectTimeout: 30000,
    requestTimeout: 30000,
  },
  pool: {
    max: 20,
    min: 2,
    idleTimeoutMillis: 30000,
  },
};

let pool = null;

const getPool = async () => {
  if (pool && pool.connected) return pool;
  try {
    pool = await sql.connect(config);
    logger.info('✅ Azure SQL Pool Connected');
    pool.on('error', (err) => {
      logger.error('SQL Pool Error:', err);
      pool = null;
    });
    return pool;
  } catch (err) {
    logger.error('❌ DB Connection Failed:', err.message);
    throw err;
  }
};

// Helper: run a parameterized query safely
const query = async (queryString, params = {}) => {
  const p = await getPool();
  const req = p.request();
  for (const [key, { type, value }] of Object.entries(params)) {
    req.input(key, type, value);
  }
  return req.query(queryString);
};

// Helper: get single row
const queryOne = async (queryString, params = {}) => {
  const result = await query(queryString, params);
  return result.recordset[0] || null;
};

// Helper: transaction wrapper
const withTransaction = async (fn) => {
  const p = await getPool();
  const transaction = new sql.Transaction(p);
  await transaction.begin();
  try {
    const result = await fn(transaction);
    await transaction.commit();
    return result;
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
};

module.exports = { sql, getPool, query, queryOne, withTransaction };
