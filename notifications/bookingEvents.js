// backend/notifications/bookingEvents.js
//
// Booking notification builders. Each one returns an array of messages in the
// shape emit() expects:  { to: 'customer' | 'seller', id, title, body, route }
//
// Merge into events.js (see bottom of this file).

// userId / sellerId can be an ObjectId or a populated document
const idOf = (v) => (v && v._id ? v._id : v) || null;

// ⚠️ Adjust these to the real routes in your Expo app
const CUSTOMER_ROUTE = (booking) => `/booking/${booking._id}`;
const SELLER_ROUTE = (booking) => `/seller/booking/${booking._id}`;

const CUSTOMER_STATUS_COPY = {
  seller_assigned: (b, seller) => ({
    title: 'Decorator confirmed 🎉',
    body: `${seller?.name || 'A decorator'} accepted your booking and will reach you soon.`,
  }),
  completed: () => ({
    title: 'Setup complete ✅',
    body: 'Your decoration setup is done. Enjoy your celebration!',
  }),
  allocation_failed: () => ({
    title: 'No decorator available',
    body: "We couldn't find a decorator right now. Please try again shortly.",
  }),
  cancelled: (b, seller, cancelledBy) =>
    cancelledBy === 'seller'
      ? {
          title: 'Booking cancelled by decorator',
          body: 'Your decorator had to cancel. Please book again and we will find you another one.',
        }
      : {
          title: 'Booking cancelled',
          body: 'Your booking has been cancelled.',
        },
};

module.exports = {
  // Customer: booking was received, matchmaking has started
  'booking.created': async ({ booking }) => {
    const userId = idOf(booking?.userId);
    if (!userId) return [];
    return [
      {
        to: 'customer',
        id: userId,
        title: 'Booking received',
        body: 'Finding the best decorator near you…',
        route: CUSTOMER_ROUTE(booking),
      },
    ];
  },

  // Customer: status changes (accepted / completed / cancelled / no vendor)
  'booking.status': async ({ booking, status, seller, cancelledBy }) => {
    const userId = idOf(booking?.userId);
    if (!userId) return [];

    // The customer cancelled it themselves, so no need to ping them about it
    if (status === 'cancelled' && cancelledBy === 'customer') return [];

    const build = CUSTOMER_STATUS_COPY[status];
    if (!build) return [];

    const copy = build(booking, seller, cancelledBy);
    return [{ to: 'customer', id: userId, ...copy, route: CUSTOMER_ROUTE(booking) }];
  },

  // Seller: a new job offer is waiting
  'booking.offer': async ({ booking, seller }) => {
    const sellerId = idOf(seller);
    if (!sellerId) return [];
    return [
      {
        to: 'seller',
        id: sellerId,
        title: 'New decoration request',
        body: booking?.pickupLocation?.address || 'Tap to view the request.',
        route: SELLER_ROUTE(booking),
      },
    ];
  },

  // Seller: the customer cancelled a job that was assigned to them
  'booking.seller_cancelled': async ({ booking, sellerId }) => {
    const id = idOf(sellerId);
    if (!id) return [];
    return [
      {
        to: 'seller',
        id,
        title: 'Booking cancelled by customer',
        body: 'The customer cancelled this job. You are available for new requests again.',
        route: SELLER_ROUTE(booking),
      },
    ];
  },
};

// ─── How to merge into events.js ──────────────────────────────────────────────
//
// If events.js ends with:   module.exports = { 'order.created': ..., 'order.status': ... };
// change it to:
//
//   module.exports = {
//     ...existingEvents,                  // whatever you export today
//     ...require('./bookingEvents'),
//   };
//
// or, if it uses `events['order.created'] = ...` style, add at the bottom:
//
//   Object.assign(module.exports, require('./bookingEvents'));