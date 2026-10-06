const redisClient = require('../config/redisClient');

/**
 * Cache middleware for Express GET routes
 * @param {number} durationInSeconds - Cache TTL in seconds (default: 300s / 5 mins)
 */
const cache = (durationInSeconds = 300) => {
  return async (req, res, next) => {
    // Only cache GET requests
    if (req.method !== 'GET') {
      return next();
    }

    const key = `cache:${req.originalUrl || req.url}`;

    try {
      const cachedResponse = await redisClient.get(key);
      if (cachedResponse) {
        return res.status(200).json(JSON.parse(cachedResponse));
      }

      // Override res.json to capture response payload before sending
      const originalJson = res.json.bind(res);
      res.json = (body) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          redisClient.setEx(key, durationInSeconds, JSON.stringify(body)).catch((err) => {
            console.error('[REDIS CACHE SET ERROR]', err.message);
          });
        }
        return originalJson(body);
      };

      next();
    } catch (err) {
      console.error('[REDIS CACHE ERROR]', err.message);
      next(); // Fail open: continue without caching if Redis encounters an issue
    }
  };
};

/**
 * Helper to purge cache by pattern (e.g., 'cache:/api/categories*')
 */
const clearCachePattern = async (pattern) => {
  try {
    const keys = await redisClient.keys(pattern);
    if (keys.length > 0) {
      await redisClient.del(keys);
    }
  } catch (err) {
    console.error('[REDIS CACHE PURGE ERROR]', err.message);
  }
};

module.exports = { cache, clearCachePattern };