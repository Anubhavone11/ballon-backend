const Booking = require('../models/Booking');
const Seller = require('../models/Seller');

// =========================================================================
// FETCH ALL BOOKINGS WITH OPERATIONAL ADVANCED FILTERS
// =========================================================================
exports.getAllBookingsAdmin = async (req, res) => {
  try {
    const { type, status } = req.query;
    let queryFilter = {};

    if (type && type !== 'all') queryFilter.bookingType = type;
    if (status && status !== 'all') queryFilter.status = status;

    const bookings = await Booking.find(queryFilter)
      .populate('userId', 'name email phone')
      .populate('sellerId', 'businessName phone email completedBookings isAllocated')
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: bookings.length,
      bookings
    });
  } catch (error) {
    console.error("Admin global allocation query failure:", error);
    return res.status(500).json({ 
      success: false, 
      message: "Internal master database ledger query exception." 
    });
  }
};

// =========================================================================
// GEOSPATIAL PROXIMITY ENGINE FOR RADIAL ASSIGNMENTS
// =========================================================================
exports.getEligibleVendorsForJob = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const booking = await Booking.findById(bookingId);
    
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking record target token empty." });
    }

    if (!booking.pickupLocation?.coordinates || booking.pickupLocation.coordinates[0] === 0) {
      return res.status(400).json({ success: false, message: "Target booking coordinates unresolved or zero point vector." });
    }

    const [lon, lat] = booking.pickupLocation.coordinates;

    // Spatial lookup finding non-blocked, online, unallocated candidate studios within 15KM
    const eligibleSellers = await Seller.find({
      location: {
        $near: {
          $geometry: { type: "Point", coordinates: [lon, lat] },
          $maxDistance: 15000 // 15 KM Limit Radius Threshold
        }
      },
      approved: true,
      blocked: false,
      isOnline: true,
      isAllocated: false
    }).select('-password');

    return res.status(200).json({
      success: true,
      centerLocation: booking.pickupLocation.address,
      sellers: eligibleSellers
    });
  } catch (error) {
    console.error("Proximity aggregation selector engine crash:", error);
    return res.status(500).json({ 
      success: false, 
      message: "Critical geometric tracking intersection exception." 
    });
  }
};

// =========================================================================
// DISPATCH SELLER AND BIND TASK PIPELINE TRANSACTION
// =========================================================================
exports.assignVendorToBooking = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { sellerId } = req.body;

    const [booking, seller] = await Promise.all([
      Booking.findById(bookingId),
      Seller.findById(sellerId)
    ]);

    if (!booking || !seller) {
      return res.status(404).json({ success: false, message: "Document mapping resolution targeted null pointers." });
    }

    if (seller.isAllocated || seller.blocked || !seller.approved) {
      return res.status(400).json({ 
        success: false, 
        message: "Selected studio target node is unavailable, suspended, or unapproved." 
      });
    }

    // Bind document metrics across tables
    booking.sellerId = sellerId;
    booking.status = 'seller_assigned';
    await booking.save();

    // Flip allocation availability parameters to true (Engaged)
    seller.isAllocated = true;
    await seller.save();

    return res.status(200).json({
      success: true,
      message: `Reservation workflow securely dispatched to ${seller.businessName}.`
    });
  } catch (error) {
    console.error("Manual matching dispatcher transaction abort:", error);
    return res.status(500).json({ 
      success: false, 
      message: "Data transaction isolation block breakdown." 
    });
  }
};
exports.updateSellerStatusAdmin = async (req, res) => {
  try {
    // 🛠️ FIX 1: Support both dynamic params and standalone individual route params
    const sellerId = req.params.sellerId || req.params.id;
    const actionType = req.params.actionType || 'approve'; 
    
    // 🛠️ FIX 2: Intercept payload variations gracefully (handles both .value and .approved)
    let value = req.body.value;
    if (value === undefined && req.body.approved !== undefined) value = req.body.approved;
    if (value === undefined && req.body.blocked !== undefined) value = req.body.blocked;
    if (value === undefined && req.body.verified !== undefined) value = req.body.verified;

    if (typeof value !== 'boolean') {
      return res.status(400).json({ 
        success: false, 
        message: "Validation Error: Target status value parameter must be a boolean." 
      });
    }

    let updateQuery = {};
    let successMessage = "";

    switch (actionType) {
      case 'approve':
      case 'approved':
        // 🔒 ATOMIC TRANSACTION STEP: Both values forced true or false together
        updateQuery.approved = value;
        updateQuery.verified = value; 
        
        successMessage = value 
          ? "Studio successfully approved and granted marketplace verification status." 
          : "Studio approval and verification metrics retracted.";
        break;

      case 'block':
      case 'blocked':
        updateQuery.blocked = value;
        successMessage = value 
          ? "Studio node restricted and blocked from matchmaking operations." 
          : "Studio operational restrictions lifted safely.";
        break;

      case 'verify':
      case 'verified':
        updateQuery.verified = value;
        successMessage = value ? "Studio verified status set to TRUE." : "Studio verified status revoked.";
        break;

      default:
        return res.status(400).json({ 
          success: false, 
          message: "Router Misconfiguration: Invalid seller action type parameter." 
        });
    }

    // Execute atomic document patch matrix mutations
    const updatedSeller = await Seller.findByIdAndUpdate(
      sellerId,
      { $set: updateQuery },
      { new: true, runValidators: true }
    ).select('-password');

    if (!updatedSeller) {
      return res.status(404).json({ 
        success: false, 
        message: "Studio record entity not found under provided identifier." 
      });
    }

    // 🚀 Return the newly modified document structure back to React
    return res.status(200).json({
      success: true,
      message: successMessage,
      seller: updatedSeller
    });

  } catch (error) {
    console.error("Critical failure altering vendor state matrices:", error);
    return res.status(500).json({ 
      success: false, 
      message: "Internal server error applying permission modifications." 
    });
  }
};