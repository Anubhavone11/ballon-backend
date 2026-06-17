const mongoose = require('mongoose');

// --- VENDOR SCHEMA ---
const VendorSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    phone: { type: String, required: true },
    rating: { type: Number, default: 5.0 },
    totalJobs: { type: Number, default: 0 },
    specialties: [{ type: String }], 
    operatingCity: { type: String, required: true },
    isOnline: { type: Boolean, default: false }, 
    isAllocated: { type: Boolean, default: false },
    location: {
        type: { type: String, enum: ['Point'], default: 'Point' },
        coordinates: { type: [Number], required: true } // [Longitude, Latitude]
    }
}, { timestamps: true });

VendorSchema.index({ location: '2dsphere' });

// --- DECOR BOOKING PIPELINE SCHEMA ---
const BookingSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', default: null },
    bookingType: { type: String, enum: ['instant', 'scheduled'], required: true },
    status: { 
        type: String, 
        enum: ['pending_allocation', 'vendor_assigned', 'in_transit', 'completed', 'cancelled', 'allocation_failed'], 
        default: 'pending_allocation' 
    },
    serviceDetails: {
        decorType: { type: String, required: true },
        note: { type: String }
    },
    scheduledTime: { type: Date, default: null }, 
    routingQueue: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Vendor' }],
    currentRoutingIndex: { type: Number, default: 0 },
    pickupLocation: {
        address: { type: String, required: true },
        coordinates: { type: [Number], required: true } // [Longitude, Latitude]
    }
}, { timestamps: true });

module.exports = {
    Vendor: mongoose.model('Vendor', VendorSchema),
    Booking: mongoose.model('Booking', BookingSchema)
};