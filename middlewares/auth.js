// middlewares/auth.js
const jwt = require('jsonwebtoken');

function auth({ optional = false } = {}) {
  return function (req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      if (optional) {
        req.user = null;
        return next();
      }
      return res.status(401).json({ message: 'Unauthorized' });
    }

    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      const hasSub = payload && (typeof payload.sub === 'string' || typeof payload.sub === 'number');
      if (!hasSub) {
        return res.status(401).json({ message: 'Invalid token: missing user id' });
      }

      req.user = {
        id: payload.sub,   // user id
        scope: payload.scope || 'user',
      };

      return next();
    } catch (e) {
      return res.status(401).json({ message: 'Invalid token' });
    }
  };
}

module.exports = { auth };