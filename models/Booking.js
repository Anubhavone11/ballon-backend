const mongoose = require("mongoose");

const bookingSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },

    sellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      default: null
    },

    notifiedSellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      default: null
    },

    offerExpiresAt: {
      type: Date,
      default: null
    },

    bookingType: {
      type: String,
      enum: ["instant", "scheduled"],
      default: "instant"
    },

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

    serviceDetails: {
      // 🚀 ADDED: Explicit name field as requested
      name: {
        type: String,
        required: [true, "Customer name is required"],
        trim: true
      },

      decorType: {
        type: String,
        default: ""
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

    // 🚀 ADDED: customer's WhatsApp number so we can message them once a seller accepts
    customerPhone: {
      type: String,
      default: ""
    },

    // 🚀 ADDED: live GPS location of the assigned vendor, updated every few seconds
    vendorLocation: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
      updatedAt: { type: Date, default: null }
    },

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

    scheduledTime: {
      type: Date,
      default: null
    },

    estimatedPrice: {
      type: Number,
      default: 0
    },

    finalPrice: {
      type: Number,
      default: 0
    },

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

    sellerFeedback: {
      type: String,
      default: ""
    },

    customerFeedback: {
      type: String,
      default: ""
    },

    customerRating: {
      type: Number,
      min: 1,
      max: 5,
      default: null
    },

    selectedProductId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      default: null
    },
  },
  {
    timestamps: true
  }
);

bookingSchema.index({ userId: 1 });
bookingSchema.index({ sellerId: 1 });
bookingSchema.index({ status: 1 });
bookingSchema.index({ bookingType: 1 });
bookingSchema.index({ createdAt: -1 });
bookingSchema.index({ scheduledTime: 1 });
bookingSchema.index({ status: 1, offerExpiresAt: 1 });

module.exports = mongoose.model("Booking", bookingSchema);