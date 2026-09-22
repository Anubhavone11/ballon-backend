// middleware/identifyUser.js
//
// Product pages, home, categories, etc. are public - a visitor doesn't have
// to be logged in to view them. This middleware tries to attach req.user
// from a token if one is present (so we know WHO viewed the product when
// they're logged in), but never blocks the request if there isn't one.
//
// Same idea as the `softAuth` added to routes/auth.js's /logout route -
// pulled out here so it can be reused across product/checkout routes too.
// If you'd rather not duplicate it, you can delete the softAuth function
// in routes/auth.js and import this instead.

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET; // must match the secret used in routes/auth.js

module.exports = function identifyUser(req, res, next) {
  let token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) token = req.cookies?.token;
  if (!token) return next(); // guest - just continue, req.user stays undefined

  try {
    req.user = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    // expired/invalid token - treat as guest, don't block the page
  }
  next();
};