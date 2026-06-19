const jwt = require('jsonwebtoken');
const Seller = require('../models/Seller');

const sellerAuth = async (req, res, next) => {
  try {
    // Get token from header
    const token = req.header('Authorization')?.replace('Bearer ', '');
    console.log(req.header);
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'No authentication token found'
      });
    }

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET_SELLER);
    
    // Check if it's a seller token
    if (decoded.type !== 'seller') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token type'
      });
    }

    // Find seller
    const seller = await Seller.findById(decoded.id).select('-password');
    if (!seller) {
      return res.status(401).json({
        success: false,
        message: 'Seller not found'
      });
    }

    // Add seller to request
    req.seller = seller;
    next();
  } catch (error) {
    // Handle specific JWT errors
    if (error.name === 'TokenExpiredError') {
      console.error('Token expired at:', error.expiredAt);
      return res.status(401).json({
        success: false,
        message: 'Your session has expired. Please log in again.',
        error: 'TOKEN_EXPIRED'
      });
    }
    
    if (error.name === 'JsonWebTokenError') {
      console.error('Invalid token:', error.message);
      return res.status(401).json({
        success: false,
        message: 'Invalid authentication token. Please log in again.',
        error: 'INVALID_TOKEN'
      });
    }
    
    console.error('Seller authentication error:', error);
    res.status(401).json({
      success: false,
      message: 'Authentication failed. Please log in again.'
    });
  }
};

module.exports = sellerAuth; 