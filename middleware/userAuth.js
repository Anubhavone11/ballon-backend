const jwt = require('jsonwebtoken');

const userAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ 
        success: false, 
        message: 'Authentication failed. No token provided.' 
      });
    }

    // Use your regular Customer/User JWT Secret here
    const jwtSecret = process.env.JWT_SECRET || 'your-secret-key';
    
    jwt.verify(token, jwtSecret, (err, decoded) => {
      if (err) {
        if (err.name === 'TokenExpiredError') {
          return res.status(401).json({ 
            success: false, 
            message: 'Your session has expired. Please log in again.' 
          });
        }
        return res.status(401).json({ 
          success: false, 
          message: 'Invalid authentication token.' 
        });
      }

      
      req.user = decoded; 
      
      next();
    });

  } catch (error) {
    console.error('User authentication middleware error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Internal server error during authentication.' 
    });
  }
};

module.exports = userAuth;