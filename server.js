// File: admin/backend/server.js
require('dotenv').config();
const http = require('http');
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
const cookieParser = require("cookie-parser");
const shopRoutes = require("./routes/shop");
const productRoutes = require("./routes/products");
const orderRoutes = require("./routes/orders");
const authRoutes = require('./routes/auth'); // Assuming your auth routes are here
const adminAuthRoutes = require('./routes/adminAuth'); // Admin authentication routes
const lovedRoutes = require('./routes/loved'); // Assuming your loved routes are here
const categoryRoutes = require('./routes/category');
const featuredProductRoutes = require('./routes/featuredProduct');
const bestSellerRoutes = require('./routes/bestSeller');
const bookingRoutes = require("./routes/bookingRoutes");
const cartRoutes = require('./routes/cart');
const fs = require('fs');
const heroCarouselRoutes = require('./routes/heroCarousel');
const sellerRoutes = require('./routes/seller');
const couponRoutes = require('./routes/coupon');
const crypto = require('crypto');
const settingsController = require('./controllers/settingsController');
const { initSocket } = require('./socket'); // Socket.io setup (replaces Pusher)
const { startMatchmakingSweep } = require('./controllers/matchmakingSweep'); // Expires stale seller offers
const app = express();
const subCategoryRoutes = require('./routes/subCategoryRoutes'); // Adjust path if needed
const blogRoutes = require('./routes/blog');
const videoRoutes = require('./routes/video');
const adminBookingRoutes = require('./routes/adminBookingRoutes');

// Generate a random JWT secret for seller authentication if not provided
if (!process.env.JWT_SECRET_SELLER) {
  process.env.JWT_SECRET_SELLER = crypto.randomBytes(64).toString('hex');
  console.log('Generated random JWT_SECRET_SELLER');
}

// CORS configuration - Allow specific origins for production
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',

  'http://localhost:5175', // Backend port (for testing)
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
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
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

// Ensure data directories exist
const dataDir = path.join(__dirname, 'data');
const userProductDir = path.join(dataDir, 'userproduct');

// Create directories if they don't exist
[dataDir, userProductDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log('Created directory:', dir);
  }
});

// Serve static files with proper MIME types
app.use('/decoryy/data', (req, res, next) => {
  const filePath = path.join(__dirname, 'data', req.path);
  const ext = path.extname(filePath).toLowerCase();

  // Set proper content type for videos and images
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

// MongoDB Connection URL — must come from the environment. No hardcoded
// fallback: a real credential should never live in source control.
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('MONGODB_URI is not set. Refusing to start without a database connection string.');
  process.exit(1);
}

// API Routes - Define routes (but don't start server yet)
app.use("/api/shop", shopRoutes);
app.use("/api/products", productRoutes);
app.use("/api/orders", orderRoutes);
app.use('/api/bestseller', bestSellerRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/admin/auth', adminAuthRoutes); // Admin authentication routes\
app.use('/api/admin/bookings', adminBookingRoutes);
app.use('/api/loved', lovedRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/featured-products', featuredProductRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/hero-carousel', heroCarouselRoutes);
app.use('/api/seller', sellerRoutes);
app.use('/api/coupons', couponRoutes);
app.use('/api/data-page', require('./routes/dataPage'));
// Register city routes
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
// This handles requests like GET /api/categories/:id/subcategories
app.use('/api/categories', subCategoryRoutes);
app.use("/api/bookings", bookingRoutes);
// This handles requests like PUT /api/subcategories/:id
app.use('/api', subCategoryRoutes); // A bit broad, but will work.
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
  console.error('Error:', err);
  console.error('Stack:', err.stack);
  res.status(500).json({
    message: 'Something went wrong!',
    error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
  });
});

// Port from environment variable
const PORT = process.env.PORT || 5175;

// Wrap Express in a plain http.Server so Socket.io can attach to the same
// port (no separate process or paid real-time service needed).
const httpServer = http.createServer(app);
initSocket(httpServer);
mongoose.set('autoIndex', true);
// Async function to start server after MongoDB connection
async function startServer() {
  try {
    // Connect to MongoDB first and wait for connection
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 15000, // Increase timeout to 15 seconds
      socketTimeoutMS: 45000,
    });
    console.log("MongoDB connected successfully");

    // Initialize default settings after DB connection
    try {
      await settingsController.initializeDefaultSettings();
      console.log('Default settings initialized successfully');
    } catch (error) {
      console.error('Failed to initialize default settings:', error);
    }

    // Start the background job that expires stale seller offers
    // (instant-booking matchmaking — see jobs/matchmakingSweep.js)
    startMatchmakingSweep();
    console.log('Matchmaking sweep job started');

    // Now start the server (http server, not app — Socket.io needs this)
    httpServer.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
      console.log('Server is ready to accept requests');
    });
  } catch (error) {
    console.error("Failed to connect to MongoDB:", error);
    console.error("Server cannot start without database connection");
    process.exit(1); // Exit if cannot connect to database
  }
}

// Start the server
startServer();
