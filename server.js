require('dotenv').config();
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const { createClient } = require('redis');
const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');

// Route Imports
const shopRoutes = require('./routes/shop');
const productRoutes = require('./routes/products');
const orderRoutes = require('./routes/orders');
const authRoutes = require('./routes/auth');
const adminAuthRoutes = require('./routes/adminAuth');
const lovedRoutes = require('./routes/loved');
const categoryRoutes = require('./routes/category');
const featuredProductRoutes = require('./routes/featuredProduct');
const bestSellerRoutes = require('./routes/bestSeller');
const bookingRoutes = require('./routes/bookingRoutes');
const cartRoutes = require('./routes/cart');
const heroCarouselRoutes = require('./routes/heroCarousel');
const sellerRoutes = require('./routes/seller');
const couponRoutes = require('./routes/coupon');
const subCategoryRoutes = require('./routes/subCategoryRoutes');
const blogRoutes = require('./routes/blog');
const videoRoutes = require('./routes/video');
const adminBookingRoutes = require('./routes/adminBookingRoutes');
const voiceRoutes = require('./routes/voiceRoutes');
const chatRoutes = require('./routes/chatRoutes');
const bannerRoutes = require('./routes/bannerRoutes');
const addonRoutes = require('./routes/addon');

// Controllers & Global Services
const settingsController = require('./controllers/settingsController');
const { initSocket } = require('./socket/socketSetup');
const { startMatchmakingSweep } = require('./controllers/Matchmakingsweep');

const app = express();
app.set('trust proxy', 1);

// ─── Redis Setup (v5 compatible) ─────────────────────────────────────────────
const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  RESP: 2
});

redisClient.on('error', (err) => {
  console.error('[REDIS ERROR]', err.message);
});

redisClient.on('connect', () => {
  console.log('Redis connected successfully');
});

app.set('redisClient', redisClient);

// ─── Redis Cache Middleware with Detailed Logging ────────────────────────────
const cacheMiddleware = (durationInSeconds = 300) => {
  return async (req, res, next) => {
    if (req.method !== 'GET' || !redisClient.isReady) {
      return next();
    }

    const cacheKey = `cache:${req.originalUrl || req.url}`;

    try {
      const cachedData = await redisClient.get(cacheKey);

      if (cachedData) {
        console.log(`[REDIS CACHE HIT] Key: "${cacheKey}" served directly from Redis`);
        return res.status(200).json(JSON.parse(cachedData));
      }

      console.log(`[REDIS CACHE MISS] Key: "${cacheKey}" - Fetching fresh data from database...`);

      // Intercept res.json to log and store fresh data into Redis
      const sendJsonResponse = res.json.bind(res);
      res.json = (body) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const stringified = JSON.stringify(body);

          redisClient.setEx(cacheKey, durationInSeconds, stringified)
            .then(() => {
              const preview = stringified.length > 150
                ? stringified.substring(0, 150) + '... (truncated)'
                : stringified;

              console.log(`[REDIS STORED] Key: "${cacheKey}" | TTL: ${durationInSeconds}s | Size: ${stringified.length} bytes`);
              console.log(`[REDIS STORED DATA PREVIEW]: ${preview}`);
            })
            .catch((err) => {
              console.error('[REDIS SET ERROR]', err.message);
            });
        }
        return sendJsonResponse(body);
      };

      next();
    } catch (err) {
      console.error('[REDIS GET ERROR]', err.message);
      next();
    }
  };
};

// ─── JWT Secret Check ────────────────────────────────────────────────────────
if (!process.env.JWT_SECRET_SELLER) {
  console.error('[FATAL] JWT_SECRET_SELLER is not set in .env');
  console.error('Generate one with: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
  process.exit(1);
}

// ─── CORS Configuration ──────────────────────────────────────────────────────
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'https://www.decoryy.com',
  'https://ballon-frontend.vercel.app',
  'https://ballon-admin-beta.vercel.app',
  'https://admin.decoryy.com',
  'https://ballon-frontend-psi.vercel.app'
];

// cors() alone handles headers + preflight. The old duplicate manual
// header middleware has been removed.
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    console.log('CORS blocked origin:', origin);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'Content-Length'],
  exposedHeaders: ['Content-Length', 'X-Requested-With'],
  preflightContinue: false,
  optionsSuccessStatus: 204
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cookieParser());

// Payload size error handler
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      success: false,
      message: 'Payload too large. Please reduce the size of your request.'
    });
  }
  next(err);
});

// Ensure data directories exist
const dataDir = path.join(__dirname, 'data');
const userProductDir = path.join(dataDir, 'userproduct');
const productUploadsDir = path.join(dataDir, 'products');
const sellerProfilesDir = path.join(dataDir, 'seller-profiles');

[dataDir, userProductDir, productUploadsDir, sellerProfilesDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log('Created directory:', dir);
  }
});

// Static Media Delivery
app.use('/decoryy/data/products', express.static(productUploadsDir, { maxAge: '1h' }));
app.use('/data/seller-profiles', express.static(sellerProfilesDir, { maxAge: '1h' }));

app.use('/decoryy/data', (req, res, next) => {
  const filePath = path.join(__dirname, 'data', req.path);
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.mp4') {
    res.setHeader('Content-Type', 'video/mp4');
  } else if (ext === '.png') {
    res.setHeader('Content-Type', 'image/png');
  } else if (ext === '.jpg' || ext === '.jpeg') {
    res.setHeader('Content-Type', 'image/jpeg');
  } else if (ext === '.gif') {
    res.setHeader('Content-Type', 'image/gif');
  }
  next();
}, express.static(path.join(__dirname, 'data'), {
  fallthrough: true,
  maxAge: '1h'
}));

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('[ERROR] MONGODB_URI is not set. Refusing to start without a database connection string.');
  process.exit(1);
}

// ─── Health & Test Endpoints ─────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    message: 'Server is running',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    redis: redisClient.isReady ? 'connected' : 'disconnected',
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

app.get('/test-cors', (req, res) => {
  res.status(200).json({
    message: 'CORS is working correctly',
    origin: req.headers.origin,
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 5175;
const httpServer = http.createServer(app);
const io = initSocket(httpServer);
app.set('io', io);

mongoose.set('autoIndex', true);

// ─── Mount Routes & Start Server ─────────────────────────────────────────────
async function startServer() {
  try {
    // 1. Connect Redis FIRST so RateLimiter can initialize
    console.log('Connecting to Redis...');
    await redisClient.connect();

    // 2. Redis-backed Rate Limiters (lenient)
    const globalLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 1500,                       // was 300
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => req.method === 'OPTIONS',
      store: new RedisStore({
        sendCommand: (...args) => redisClient.sendCommand(args),
        prefix: 'rl:global:'
      }),
      handler: (req, res) => {
        console.warn(`[RATE LIMIT EXCEEDED] IP: ${req.ip} exceeded general limit on ${req.originalUrl}`);
        res.status(429).json({
          success: false,
          message: 'Too many requests. Please try again in a few minutes.'
        });
      }
    });

    const authLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 50,                         // was 10
      skipSuccessfulRequests: true,    // only failed attempts count
      standardHeaders: true,
      legacyHeaders: false,
      store: new RedisStore({
        sendCommand: (...args) => redisClient.sendCommand(args),
        prefix: 'rl:auth:'
      }),
      handler: (req, res) => {
        console.warn(`[AUTH LIMIT EXCEEDED] IP: ${req.ip} exceeded auth attempts on ${req.originalUrl}`);
        res.status(429).json({
          success: false,
          message: 'Too many failed attempts. Please try again in a few minutes.'
        });
      }
    });

    // 3. Attach Global Rate Limiter
    app.use('/api/', globalLimiter);

    // 4. Attach Routes
    app.use('/api/auth', authLimiter, authRoutes);
    app.use('/api/admin/auth', authLimiter, adminAuthRoutes);

    // High-Read Cached Routes
    app.use('/api/categories', cacheMiddleware(300), categoryRoutes);       // 5 mins
    // Original mount: serves /api/categories/:id/subcategories (cache above already wraps it)
    app.use('/api/categories', subCategoryRoutes);
    app.use('/api/subcategories', cacheMiddleware(300), subCategoryRoutes);
    app.use('/api/banners', cacheMiddleware(300), bannerRoutes);
    app.use('/api/hero-carousel', cacheMiddleware(300), heroCarouselRoutes);
    app.use('/api/bestseller', cacheMiddleware(180), bestSellerRoutes);      // 3 mins
    app.use('/api/featured-products', cacheMiddleware(180), featuredProductRoutes);
    app.use('/api/cities', cacheMiddleware(600), require('./routes/city')); // 10 mins
    app.use('/api/blog', cacheMiddleware(300), blogRoutes);

    // Dynamic & Non-cached Routes
    app.use('/api/activity-tracking', require('./routes/Activityroutes'));
    app.use('/api/shop', productRoutes);
    app.use('/api/products', productRoutes);
    app.use('/api/orders', orderRoutes);
    app.use('/api/admin/bookings', adminBookingRoutes);
    app.use('/api/loved', lovedRoutes);
    app.use('/api/cart', cartRoutes);
    app.use('/api/seller', sellerRoutes);
    app.use('/api/coupons', couponRoutes);
    app.use('/api/data-page', require('./routes/dataPage'));
    app.use('/api/payment', require('./routes/payment'));
    app.use('/api/withdrawal', require('./routes/withdrawal'));
    app.use('/api/commission', require('./routes/commission'));
    app.use('/api/reviews', require('./routes/reviews'));
    app.use('/api/settings', require('./routes/settings'));
    app.use('/api/msg91', require('./routes/msg91'));
    app.use('/api/pin-code-service-fees', require('./routes/pinCodeServiceFee'));
    app.use('/api/addons', addonRoutes);
    app.use('/api/videos', videoRoutes);
    app.use('/api/bookings', bookingRoutes);
    app.use('/api/voice-gateway', voiceRoutes);
    app.use('/api/chat', chatRoutes);

    // Original catch-all mount for subCategoryRoutes (must stay LAST among /api routes)
    app.use('/api', subCategoryRoutes);

    // Global error handler
    app.use((err, req, res, next) => {
      console.error('Error:', err.message);
      res.status(500).json({
        message: 'Something went wrong!',
        error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
      });
    });

    // 5. Connect MongoDB
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 15000,
      socketTimeoutMS: 45000,
    });
    console.log('MongoDB connected successfully');

    try {
      await settingsController.initializeDefaultSettings();
      console.log('Default settings initialized successfully');
    } catch (error) {
      console.error('Failed to initialize default settings:', error);
    }

    startMatchmakingSweep();
    console.log('Matchmaking sweep job started');

    // 6. Listen on HTTP Port
    httpServer.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
      console.log('Server is ready to accept requests');
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();