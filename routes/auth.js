// routes/auth.js
// Customer auth is now OTP-only (delivered via WhatsApp). Google login is
// untouched. Vendor/seller login is a separate concern and is NOT in this
// file — nothing here should affect it.

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const axios = require('axios');
const User = require('../models/User');
const TempUser = require('../models/TempUser');

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');

// --- WhatsApp Cloud API config ---
// Set these in your .env file. Get them from Meta Business Manager > WhatsApp > API Setup.
const WHATSAPP_TOKEN = process.env.WA_ACCESS_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WHATSAPP_OTP_TEMPLATE = process.env.WHATSAPP_OTP_TEMPLATE || 'decoryy_login_otp';

/**
 * Sends the OTP to a phone number via a WhatsApp template message.
 * `phone` must include country code with no leading + or spaces, e.g. "919876543210".
 */
async function sendOTPWhatsApp(phone, otp) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error('WhatsApp API is not configured (missing WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID)');
  }

  const url = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: 'decoryy_login_otp',
      language: { code: 'en' },
      components: [
        {
          type: 'body',
          parameters: [{ type: 'text', text: otp }],
        },
        // If your approved template has a "Copy Code" quick-reply button
        // (standard for WhatsApp auth templates), keep this block.
        // If it doesn't, delete it — an extra button component will
        // cause the send to fail.
        {
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [{ type: 'text', text: otp }],
        },
      ],
    },
  };

  try {
    await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
    console.log(`OTP sent via WhatsApp to ${phone}`);
  } catch (err) {
    console.error('Error sending WhatsApp OTP:', err.response?.data || err.message);
    throw err;
  }
}

// Middleware to protect routes
const auth = (req, res, next) => {
  let token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) token = req.cookies?.token;
  if (!token) return res.status(401).json({ message: 'No token, authorization denied' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    console.error('Token verification error:', err);
    return res.status(401).json({ message: 'Invalid token' });
  }
};

// GET /me
router.get('/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.status(401).json({ message: 'Invalid user' });
    res.json({ user });
  } catch (err) {
    console.error('Error in /me route:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/validate-token', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.status(401).json({ message: 'Invalid user' });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ==================================================================
// CUSTOMER AUTH — OTP ONLY (via WhatsApp)
// One flow handles both signup and login: if the phone number already
// belongs to a user, we log them in; otherwise we create the account.
// ==================================================================

// POST /send-otp
// body: { phone, name? }  -- name only needed for a brand-new phone number
router.post('/send-otp', async (req, res) => {
  const { phone, name } = req.body;

  if (!phone || !/^91[6-9][0-9]{9}$/.test(phone)) {
    return res.status(400).json({ message: 'A valid 10-digit Indian mobile number is required' });
  }

  try {
    const existingUser = await User.findOne({ phone });
    if (!existingUser && !name) {
      // Brand-new number and no name given yet — ask the frontend to collect it first.
      return res.status(400).json({ message: 'Name is required for new accounts', isNewUser: true });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    await TempUser.findOneAndUpdate(
      { phone },
      { phone, name: name || undefined, otp, otpExpires: expiresAt },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await sendOTPWhatsApp(phone, otp);

    return res.json({
      message: 'OTP sent via WhatsApp',
      isNewUser: !existingUser,
    });
  } catch (err) {
    console.error('send-otp error:', err.message);
    return res.status(500).json({ message: 'Failed to send OTP. Please try again.' });
  }
});

// POST /verify-otp
// body: { phone, otp }
router.post('/verify-otp', async (req, res) => {
  const { phone, otp } = req.body;

  if (!phone || !otp) {
    return res.status(400).json({ message: 'Phone and OTP are required' });
  }

  try {
    const temp = await TempUser.findOne({ phone });
    if (!temp || temp.otp !== otp || !temp.otpExpires || temp.otpExpires < new Date()) {
      return res.status(400).json({ message: 'Invalid or expired OTP' });
    }

    let user = await User.findOne({ phone });
    let isNewUser = false;

    if (!user) {
      user = new User({
        name: temp.name || 'Customer',
        phone,
        isVerified: true,
      });
      await user.save();
      isNewUser = true;
    } else if (!user.isVerified) {
      user.isVerified = true;
      await user.save();
    }

    await TempUser.deleteOne({ phone });

    const token = jwt.sign({ id: user._id, phone: user.phone }, JWT_SECRET, { expiresIn: '24h' });

    return res.json({
      message: isNewUser ? 'Account created and logged in.' : 'Logged in successfully.',
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email || null,
        phone: user.phone,
      },
    });
  } catch (err) {
    console.error('verify-otp error:', err);
    return res.status(500).json({ message: 'Server error verifying OTP' });
  }
});

// ==================================================================
// Google OAuth Route (unchanged — still the default alt. login path)
// ==================================================================
router.post('/google', async (req, res) => {
  const { access_token } = req.body;

  if (!access_token) {
    return res.status(400).json({ message: 'Google access token is required.' });
  }

  try {
    const googleResponse = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    const { email, name, picture } = googleResponse.data;

    if (!email) {
      return res.status(400).json({ message: 'Email not provided by Google.' });
    }

    let user = await User.findOne({ email });

    if (!user) {
      // Google users still need *some* phone value to satisfy the schema.
      // Frontend should prompt for phone right after first Google login
      // if user.phone comes back empty, then PUT /update-profile to set it.
      user = new User({
        name,
        email,
        profilePicture: picture,
        isVerified: true,
        phone: `pending-${crypto.randomBytes(6).toString('hex')}`, // placeholder, replace via update-profile
      });
      await user.save();
    }

    const token = jwt.sign({ id: user._id, email: user.email }, JWT_SECRET, { expiresIn: '24h' });

    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone.startsWith('pending-') ? null : user.phone,
      },
    });
  } catch (err) {
    console.error('Error in Google OAuth route:', err.response ? err.response.data : err.message);
    res.status(500).json({ message: 'Server error during Google authentication.' });
  }
});

// POST /logout
router.post('/logout', async (req, res) => {
  try {
    res.clearCookie('token', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
    });
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    console.error('Error in logout:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /update-profile (Protected) — name/email only now; no password for customers
router.put('/update-profile', auth, async (req, res) => {
  const { name, email } = req.body;
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (name) user.name = name;
    if (email) user.email = email;
    await user.save();

    return res.json({ message: 'Profile updated', user: { id: user._id, name: user.name, email: user.email, phone: user.phone } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error updating profile' });
  }
});

module.exports = router;