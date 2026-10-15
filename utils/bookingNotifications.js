// backend/utils/bookingNotifications.js
//
// Watches the Booking model and calls emit() when something changes, so you do
// NOT have to edit every booking controller. Attach it once in your Booking
// model file, BEFORE mongoose.model('Booking', BookingSchema):
//
//   const attachBookingNotifications = require('../utils/bookingNotifications');
//   attachBookingNotifications(BookingSchema);
//
// The message text lives in notifications/events.js.

const { emit } = require('../notifications');

module.exports = function attachBookingNotifications(schema) {
  /* ---- booking.save() ---- */
  schema.pre('save', function (next) {
    this.$locals.statusChanged = this.isModified('status');
    this.$locals.queueChanged =
      this.isNew || this.isModified('currentRoutingIndex') || this.isModified('routingQueue');
    next();
  });

  schema.post('save', function (doc) {
    if (doc.$locals.statusChanged) emit('booking.status', { booking: doc, status: doc.status });
    if (doc.$locals.queueChanged) emit('booking.offer', { booking: doc });
  });

  /* ---- Booking.findOneAndUpdate / findByIdAndUpdate (use { new: true }) ---- */
  schema.pre('findOneAndUpdate', function (next) {
    const u = this.getUpdate() || {};
    this._newStatus = u.status || (u.$set && u.$set.status) || null;
    this._queueTouched = !!(
      u.currentRoutingIndex !== undefined ||
      u.routingQueue ||
      (u.$set && (u.$set.currentRoutingIndex !== undefined || u.$set.routingQueue))
    );
    next();
  });

  schema.post('findOneAndUpdate', function (doc) {
    if (!doc) return;
    if (this._newStatus) emit('booking.status', { booking: doc, status: this._newStatus });
    if (this._queueTouched) emit('booking.offer', { booking: doc });
  });
};

// Not covered: Booking.updateOne / updateMany return no document, so call
// emit('booking.status', { booking, status }) from that controller instead.