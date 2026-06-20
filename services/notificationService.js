// services/notificationService.js
const Seller = require("../models/Seller");
const whatsappClient = require("../config/whatsapp");

// Sends a direct, targeted job offer text alert out to a specific vendor phone line context
const sendJobOfferToVendor = async (sellerId, bookingData) => {
  try {
    const seller = await Seller.findById(sellerId);
    if (!seller || !seller.phone || !seller.approved || seller.blocked) {
      console.log(`⚠️ Alert aborting: Target vendor profile ${sellerId} is invalid or disabled.`);
      return false;
    }

    let formattedPhone = seller.phone.trim().replace(/[\s\-()]/g, "");
    if (!formattedPhone.startsWith('+')) {
      formattedPhone = formattedPhone.startsWith('0') ? `91${formattedPhone.slice(1)}` : `91${formattedPhone}`;
    } else {
      formattedPhone = formattedPhone.replace('+', '');
    }

    const whatsappTargetId = `${formattedPhone}@c.us`;
    const domain = process.env.PRODUCTION_DOMAIN || "http://localhost:5175";
    
    const textBody = `🚨 *DIRECT JOB ASSIGNMENT ALERT!* 🚨\n\n` +
                     `• Order Type: *${bookingData.serviceDetails.decorType}*\n` +
                     `• Reference ID: ${bookingData._id}\n\n` +
                     `👉 REVIEW OFFERS PANEL: ${domain}/dashboard`;

    await whatsappClient.sendMessage(whatsappTargetId, textBody);
    console.log(`✉️ Single-channel WhatsApp alert pushed directly to: ${seller.businessName}`);
    return true;
  } catch (error) {
    console.error("sendJobOfferToVendor error:", error);
    return false;
  }
};

module.exports = { sendJobOfferToVendor };