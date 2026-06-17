const jwt = require('jsonwebtoken');

exports.verifyVendorToken = (req, res, next) => {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
        return res.status(401).json({ success: false, message: 'Access denied. No token provided.' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // Enforce strict check to prevent customers from making vendor changes
        if (decoded.role !== 'vendor') {
            return res.status(403).json({ success: false, message: 'Access denied. Action restricted to vendors.' });
        }
        
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(400).json({ success: false, message: 'Invalid or expired token execution parameter.' });
    }
};