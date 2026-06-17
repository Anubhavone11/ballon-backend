const { Vendor } = require('../models/schemas');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// 1. VENDOR REGISTRATION (SIGNUP)
exports.vendorSignup = async (req, res) => {
    try {
        const { name, email, password, phone, operatingCity, specialties, lng, lat } = req.body;

        // Check if vendor already exists
        const existingVendor = await Vendor.findOne({ email });
        if (existingVendor) {
            return res.status(400).json({ success: false, message: 'Email is already registered as a partner.' });
        }

        // Hash the incoming password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Create the vendor document matching your GeoJSON format
        const newVendor = await Vendor.create({
            name,
            email,
            password: hashedPassword,
            phone,
            operatingCity,
            specialties: specialties || [],
            location: {
                type: 'Point',
                coordinates: [parseFloat(lng), parseFloat(lat)] // [Longitude, Latitude]
            }
        });

        // Generate an architecture token
        const token = jwt.sign({ id: newVendor._id, role: 'vendor' }, process.env.JWT_SECRET, { expiresIn: '7d' });

        return res.status(201).json({
            success: true,
            token,
            vendor: {
                id: newVendor._id,
                name: newVendor.name,
                email: newVendor.email,
                operatingCity: newVendor.operatingCity
            }
        });
    } catch (error) {
        console.error('Vendor Signup Error:', error);
        return res.status(500).json({ success: false, message: 'Internal server registration error.' });
    }
};

// 2. VENDOR AUTHENTICATION (LOGIN)
exports.vendorLogin = async (req, res) => {
    try {
        const { email, password } = req.body;

        // Locate vendor profile verification
        const vendor = await Vendor.findOne({ email });
        if (!vendor) {
            return res.status(400).json({ success: false, message: 'Invalid email or password credentials.' });
        }

        // Compare password hash
        const isMatch = await bcrypt.compare(password, vendor.password);
        if (!isMatch) {
            return res.status(400).json({ success: false, message: 'Invalid email or password credentials.' });
        }

        // Sign token access parameter
        const token = jwt.sign({ id: vendor._id, role: 'vendor' }, process.env.JWT_SECRET, { expiresIn: '7d' });

        return res.status(200).json({
            success: true,
            token,
            vendor: {
                id: vendor._id,
                name: vendor.name,
                email: vendor.email,
                isOnline: vendor.isOnline,
                isAllocated: vendor.isAllocated
            }
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Internal server login error.' });
    }
};

// 3. TOGGLE ONLINE STATUS (Critical for Instant Tracking Matching Engine)
exports.toggleStatus = async (req, res) => {
    try {
        const vendorId = req.user.id; // Pulled from your auth verification token middleware
        const { isOnline, lng, lat } = req.body;

        const updateData = { isOnline };

        // If going online, optionally refresh their coordinates
        if (isOnline && lng && lat) {
            updateData.location = {
                type: 'Point',
                coordinates: [parseFloat(lng), parseFloat(lat)]
            };
        }

        const updatedVendor = await Vendor.findByIdAndUpdate(
            vendorId,
            updateData,
            { new: true }
        ).select('-password');

        return res.status(200).json({
            success: true,
            message: `You are now ${updatedVendor.isOnline ? 'ONLINE' : 'OFFLINE'}.`,
            vendor: updatedVendor
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Failed to update system presence status.' });
    }
};