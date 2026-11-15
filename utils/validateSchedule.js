// utils/validateSchedule.js
// Server-side check of the booking time. The server is the final authority:
// it never trusts the customer's device clock or timezone.
//
// Usage (in createOrder AND the PhonePe initiate handler, right after auth):
//
//   const validateSchedule = require('../utils/validateSchedule');
//   const scheduleError = validateSchedule(req.body.scheduledDelivery);
//   if (scheduleError) {
//     return res.status(400).json({ success: false, message: scheduleError });
//   }

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MAX_DAYS_AHEAD = 190; // about 6 months

module.exports = function validateSchedule(scheduledDelivery) {
  const when = new Date(scheduledDelivery);

  if (!scheduledDelivery || isNaN(when.getTime())) {
    return 'Please choose a valid date and time slot.';
  }

  if (when.getTime() <= Date.now()) {
    return 'That time slot has already passed. Please pick a later slot.';
  }

  // Shift to IST, then read the hour with the UTC getters
  const ist = new Date(when.getTime() + IST_OFFSET_MS);
  const hour = ist.getUTCHours();
  const minute = ist.getUTCMinutes();

  if (hour < 9 || hour > 21 || (hour === 21 && minute > 0)) {
    return 'Setup slots are available between 9 AM and 9 PM.';
  }

  if (when.getTime() > Date.now() + MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000) {
    return 'Please choose a date within the next 6 months.';
  }

  return null;
};