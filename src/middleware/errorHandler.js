// src/middleware/errorHandler.js
const logger = require('../utils/logger');
const { error } = require('../utils/response');

const errorHandler = (err, req, res, next) => {
  logger.error(`${req.method} ${req.originalUrl}`, {
    error: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    user: req.user?.userId,
    school: req.user?.schoolId,
  });

  // SQL errors
  if (err.code === 'EREQUEST' || err.code === 'ECONNREFUSED') {
    return error(res, 'Database error', 503);
  }
  if (err.number === 2627 || err.number === 2601) {
    return error(res, 'Duplicate record — entry already exists', 409);
  }
  if (err.number === 547) {
    return error(res, 'Cannot delete — record has dependent data', 409);
  }

  const status = err.status || err.statusCode || 500;
  return error(res, err.message || 'Internal Server Error', status);
};

module.exports = errorHandler;
