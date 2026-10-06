const { createClient } = require('redis');

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

const redisClient = createClient({
  url: redisUrl,
  socket: {
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        console.error('[REDIS] Exceeded max reconnect attempts');
        return new Error('Redis connection failed');
      }
      return Math.min(retries * 100, 3000);
    }
  },
  RESP: 2, // Forces RESP2 protocol instead of RESP3
  legacyMode: false
});

redisClient.on('error', (err) => console.error('[REDIS ERROR]', err.message));
redisClient.on('connect', () => console.log('Redis client connected'));

module.exports = redisClient;