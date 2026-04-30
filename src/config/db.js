//src/config/db.js
const sql = require('mssql');
require('dotenv').config();

const config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_HOST, // e.g., 'yourserver.database.windows.net'
  database: process.env.DB_NAME,
  port: parseInt(process.env.DB_PORT) || 1433,
  options: {
    encrypt: true, // Azure SQL ke liye mandatory hai
    trustServerCertificate: false, // Production mein false hi rakhein
    enableArithAbort: true
  },
  pool: {
    max: 20,
    min: 0,
    idleTimeoutMillis: 30000
  }
};

// Singleton pool instance
const poolPromise = new sql.ConnectionPool(config)
  .connect()
  .then(pool => {
    console.log('✅ Azure SQL (whatsapp schema) connected successfully');
    return pool;
  })
  .catch(err => {
    console.error('❌ Azure SQL connection failed:', err.message);
    process.exit(1);
  });

module.exports = {
  sql,
  poolPromise
};