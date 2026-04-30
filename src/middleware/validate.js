// src/middleware/validate.js
const { validationResult } = require('express-validator');
const { sendError } = require('../utils/response');

/**
 * Express middleware to handle validation results from express-validator.
 * It formats errors and sends a 422 Unprocessable Entity response if validation fails.
 */
const validate = (req, res, next) => {
  const errors = validationResult(req);
  
  if (!errors.isEmpty()) {
    // Formatting errors into a more readable array of objects
    const formattedErrors = errors.array().map(err => ({
      field: err.path, // Kaunse field mein error hai (e.g., email, password)
      message: err.msg // Error message kya hai
    }));

    return sendError(res, 422, 'Validation failed', formattedErrors);
  }
  
  next();
};

module.exports = validate;