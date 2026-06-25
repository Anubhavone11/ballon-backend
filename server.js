require('dotenv').config();
const http = require('http');
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
const cookieParser = require("cookie-parser");
const fs = require('fs');
const crypto = require('crypto');
 
// Route Imports
const shopRoutes = require("./routes/shop");
const productRoutes = require("./routes/products");
const orderRoutes = require("./routes/orders");
const authRoutes = require('./routes/auth'); 
const adminAuthRoutes = require('./routes/adminAuth'); 
const lovedRoutes = require('./routes/loved'); 
const categoryRoutes = require('./routes/category');
const featuredProductRoutes = require('./routes/featuredProduct');
const bestSellerRoutes = require('./routes/bestSeller');
const bookingRoutes = require("./routes/bookingRoutes");
const cartRoutes = require('./routes/cart');
const heroCarouselRoutes = require('./routes/heroCarousel');
const sellerRoutes = require('./routes/seller');
const couponRoutes = require('./routes/coupon');
const subCategoryRoutes = require('./routes/subCategoryRoutes'); 
const blogRoutes = require('./routes/blog');
const videoRoutes = require('./routes/video');
const adminBookingRoutes = require('./routes/adminBookingRoutes');
const voiceRoutes = require('./routes/voiceRoutes');
const chatRoutes = require('./routes/chatRoutes'); // ◄ NEW
 
// Controllers & Global Services
const settingsController = require('./controllers/settingsController');
const { initSocket } = require('./socket/socketSetup'); 
const { startMatchmakingSweep } = require('./controllers/MatchmakingSweep'); 
 
const app = express();
 
// Generate a random JWT secret for seller authentication if not provided
if (!process.env.JWT_SECRET_SELLER) {
  process.env.JWT_SECRET_SELLER = crypto.randomBytes(64).toString('hex');
  console.log('Generated random JWT_SECRET_SELLER');
}
 
// CORS configuration - Allow specific origins for production
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175', 
  'https://www.decoryy.com',
  'https://ballon-frontend.vercel.app',
  'https://ballon-admin-beta.vercel.app',
  'https://admin.decoryy.com'
];
 
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) {
      console.log('No origin header, allowing request');
      return callback(null, true);
    }
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.log('CORS blocked origin:', origin);
      console.log('Allowed origins:', allowedOrigins);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', "DELETE", 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'Access-Control-Allow-Origin', 'Content-Length'],
  exposedHeaders: ['Content-Length', 'X-Requested-With'],
  preflightContinue: false,
  optionsSuccessStatus: 204
}));
 
// Additional CORS headers for all routes
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Content-Length');
  res.header('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});
 
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cookieParser());
 
// Error handling for payload too large
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      success: false,
      message: 'Payload too large. Please reduce the size of your request.'
    });
  }
  next(err);
});
 
// Ensure data directories exist explicitly
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
 
// Static Media Delivery Pipeline Configuration
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
  console.error('MONGODB_URI is not set. Refusing to start without a database connection string.');
  process.exit(1);
}
 
// =========================================================================
// ROUTING ARCHITECTURE (Specific matches prioritize early, catch-alls sit last)
// =========================================================================
 
// Product & Inventory Router Targets (High-priority routes)
app.use("/api/shop", productRoutes); 
app.use("/api/products", productRoutes);
 
app.use("/api/orders", orderRoutes);
app.use('/api/bestseller', bestSellerRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/admin/auth', adminAuthRoutes); 
app.use('/api/admin/bookings', adminBookingRoutes);
app.use('/api/loved', lovedRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/featured-products', featuredProductRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/hero-carousel', heroCarouselRoutes);
app.use('/api/seller', sellerRoutes);
app.use('/api/coupons', couponRoutes);
app.use('/api/data-page', require('./routes/dataPage'));
 
// Core Operational Modules
app.use('/api/cities', require('./routes/city'));
app.use('/api/payment', require('./routes/payment'));
app.use('/api/withdrawal', require('./routes/withdrawal'));
app.use('/api/commission', require('./routes/commission'));
app.use('/api/reviews', require('./routes/reviews'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/msg91', require('./routes/msg91'));
app.use('/api/pin-code-service-fees', require('./routes/pinCodeServiceFee'));
app.use('/api/blog', blogRoutes);
app.use('/api/addons', require('./routes/addon'));
app.use('/api/videos', require('./routes/video'));
app.use("/api/bookings", bookingRoutes);
app.use('/api/voice-gateway', voiceRoutes);
app.use('/api/chat', chatRoutes); // ◄ NEW — must be before the subCategory catch-all below
 
// Specific Sub-categories Route
app.use('/api/categories', subCategoryRoutes);
 
// Wildcard catch-all route placed safely at the very bottom
app.use('/api', subCategoryRoutes); 
 
// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    message: 'Server is running',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development'
  });
});
 
// Test endpoint for CORS
app.get('/test-cors', (req, res) => {
  res.status(200).json({
    message: 'CORS is working correctly',
    origin: req.headers.origin,
    timestamp: new Date().toISOString()
  });
});
 
// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(500).json({
    message: 'Something went wrong!',
    error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
  });
});
 
const PORT = process.env.PORT || 5175;
 
// Initialize Server and extract Socket connection layer
const httpServer = http.createServer(app);
const io = initSocket(httpServer); // ◄ your existing socket/index.js — see note below
app.set('io', io);                 // ◄ NEW: expose io on app so chatController can emit
 
mongoose.set('autoIndex', true);
 
async function startServer() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 15000, 
      socketTimeoutMS: 45000,
    });
    console.log("MongoDB connected successfully");
 
    try {
      await settingsController.initializeDefaultSettings();
      console.log('Default settings initialized successfully');
    } catch (error) {
      console.error('Failed to initialize default settings:', error);
    }
 
    startMatchmakingSweep();
    console.log('Matchmaking sweep job started');
 
    httpServer.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
      console.log('Server is ready to accept requests');
    });
  } catch (error) {
    console.error("Failed to connect to MongoDB:", error);
    process.exit(1); 
  }
}
 
startServer();
 