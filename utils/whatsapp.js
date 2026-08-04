const axios = require('axios');

// Same WhatsApp Cloud API config your customer auth (routes/auth.js) already
// uses. Kept as a standalone util so both flows can share it without
// routes/auth.js having to export anything (per your note: customer auth
// should stay untouched).
const WHATSAPP_TOKEN = process.env.WA_ACCESS_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;

/**
 * Sends an OTP via a WhatsApp template message.
 * `phone` must include country code with no leading + or spaces, e.g. "919876543210".
 * `templateName` lets you use a different approved template for sellers vs
 * customers if you want distinct copy — defaults to the same one customers use.
 */
async function sendOTPWhatsApp(phone, otp, templateName = 'decoryy_login_otp') {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error('WhatsApp API is not configured (missing WA_ACCESS_TOKEN / WA_PHONE_NUMBER_ID)');
  }

  const url = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: 'en' },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: otp }] },
        // Remove this block if your approved template has no "Copy Code" button.
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: otp }] },
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

module.exports = { sendOTPWhatsApp };