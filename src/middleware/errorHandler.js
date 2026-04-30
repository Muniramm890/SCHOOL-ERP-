// src/middleware/errorHandler.js
const logger = require('../config/logger');

const errorHandler = (err, req, res, next) => {
  // Log full error detail
  logger.error({
    message: err.message,
    stack:   err.stack,
    path:    req.path,
    method:  req.method,
  });

  /**
   * Azure SQL (MSSQL) Error Handling
   * 2627: Unique constraint error (Duplicate)
   * 2601: Unique index duplicate error
   * 547: Foreign key constraint error
   */

  // MSSQL Duplicate Key / Unique Constraint
  if (err.number === 2627 || err.number === 2601) {
    return res.status(409).json({ 
      success: false, 
      message: 'Duplicate entry — resource already exists' 
    });
  }

  // MSSQL Foreign Key Violation
  if (err.number === 547) {
    return res.status(400).json({ 
      success: false, 
      message: 'Referenced resource does not exist or is being used' 
    });
  }

  // General Status Handling
  const status  = err.statusCode || err.status || 500;
  
  // Production security: Don't leak raw 500 errors to client
  const message = process.env.NODE_ENV === 'production' && status === 500
    ? 'Internal server error'
    : err.message;

  return res.status(status).json({ 
    success: false, 
    message 
  });
};

module.exports = errorHandler;