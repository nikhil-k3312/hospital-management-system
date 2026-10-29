const Joi = require('joi');

/**
 * validate({ body, query, params }) — validates the parts of the request it is
 * given against Joi schemas. Unknown fields are rejected, defaults applied,
 * strings trimmed, and the cleaned values replace the originals. On failure
 * every problem is returned at once with 400.
 */
const validate = (schemas) => (req, res, next) => {
  const errors = [];
  for (const part of ['params', 'query', 'body']) {
    if (!schemas[part]) continue;
    const { error, value } = schemas[part].validate(req[part] || {}, {
      abortEarly: false, stripUnknown: false, convert: true,
    });
    if (error) {
      errors.push(...error.details.map((d) => d.message.replace(/"/g, '')));
    } else if (part === 'query') {
      Object.defineProperty(req, 'query', { value, writable: true, configurable: true });
    } else {
      req[part] = value;
    }
  }
  if (errors.length) {
    return res.status(400).json({ success: false, message: 'Validation failed', errors });
  }
  return next();
};

const objectId = () => Joi.string().pattern(/^[a-f\d]{24}$/i).message('must be a valid id');

const password = () => Joi.string()
  .min(8)
  .max(128)
  .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#^()\-_=+]).+$/)
  .messages({
    'string.min': 'Password must be at least 8 characters long',
    'string.pattern.base': 'Password must include upper case, lower case, a number and a special character',
  });

module.exports = { validate, objectId, password, Joi };
