const mongoose = require("mongoose");

const bookingSchema = new mongoose.Schema(
  {
    // User who created booking
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },

    // Assigned Seller
    sellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      default: null
    },

    // Seller currently holding an open offer (NEW — used by the matchmaking sweep)
    notifiedSellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      default: null
    },

    // When the current offer to notifiedSellerId expires (NEW)
    offerExpiresAt: {
      type: Date,
      default: null
    },

    // Instant or Scheduled
    bookingType: {
      type: String,
      enum: ["instant", "scheduled"],
      default: "instant"
    },

    // Booking Status
    status: {
      type: String,
      enum: [
        "pending_allocation",
        "seller_assigned",
        "accepted",
        "rejected",
        "completed",
        "cancelled",
        "allocation_failed"
      ],
      default: "pending_allocation"
    },

    // Service Details
    serviceDetails: {
      decorType: {
        type: String,
        required: true
      },

      note: {
        type: String,
        default: ""
      },

      eventType: {
        type: String,
        default: ""
      },

      guestCount: {
        type: Number,
        default: 0
      }
    },

    // Event / Pickup Location
    pickupLocation: {
      address: {
        type: String,
        required: true
      },

      coordinates: {
        type: [Number], // [lng, lat]
        required: true,
        default: [0, 0]
      }
    },

    // Matchmaking Queue
    routingQueue: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Seller"
      }
    ],

    currentRoutingIndex: {
      type: Number,
      default: 0
    },

    // Scheduled Booking Date
    scheduledTime: {
      type: Date,
      default: null
    },

    // Pricing
    estimatedPrice: {
      type: Number,
      default: 0
    },

    finalPrice: {
      type: Number,
      default: 0
    },

    // Payment
    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "failed", "refunded"],
      default: "pending"
    },

    paymentMethod: {
      type: String,
      default: ""
    },

    transactionId: {
      type: String,
      default: ""
    },

    // Timestamps
    acceptedAt: {
      type: Date,
      default: null
    },

    completedAt: {
      type: Date,
      default: null
    },

    cancelledAt: {
      type: Date,
      default: null
    },

    cancellationReason: {
      type: String,
      default: ""
    },

    // Seller Feedback
    sellerFeedback: {
      type: String,
      default: ""
    },

    // Customer Feedback
    customerFeedback: {
      type: String,
      default: ""
    },

    customerRating: {
      type: Number,
      min: 1,
      max: 5,
      default: null
    }
  },
  {
    timestamps: true
  }
);

// Indexes
bookingSchema.index({ userId: 1 });
bookingSchema.index({ sellerId: 1 });
bookingSchema.index({ status: 1 });
bookingSchema.index({ bookingType: 1 });
bookingSchema.index({ createdAt: -1 });
bookingSchema.index({ scheduledTime: 1 });
// NEW — lets the matchmaking sweep job find expired offers without a collection scan
bookingSchema.index({ status: 1, offerExpiresAt: 1 });

module.exports = mongoose.model("Booking", bookingSchema);
