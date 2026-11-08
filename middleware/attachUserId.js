'use strict';

// Runs after userAuth. Normalizes the user id from the decoded JWT.
module.exports = function attachUserId(req, res, next) {
  const u = req.user || {};
  const id = u.id || u._id || u.userId || u.sub;

  if (!id) {
    return res.status(401).json({
      success: false,
      message: 'Invalid token payload: user id missing.',
    });
  }

  req.userId = String(id);
  next();
};