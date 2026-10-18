// backend/notifications/events.js
//
// THE ONLY FILE YOU EDIT TO ADD OR CHANGE A NOTIFICATION.
//
// Each event is a function that receives the data you pass to emit(...)
// and returns a list of messages:
//   { to: 'customer' | 'seller', id, title, body, route, channelId, categoryId, priority, sound, data }

const { customerIdForOrder } = require('./recipients');

/* ---------- small helpers ---------- */
const money = (n) => `₹${Number(n || 0).toFixed(0)}`;
const when = (d) =>
  d
    ? ' for ' +
      new Date(d).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : '';

// userId / sellerId can be a plain ObjectId or a populated document
const idOf = (v) => (v && v._id ? v._id : v) || null;

/* ---------- message text lives here ---------- */
const ORDER_STATUS_TEXT = {
  confirmed: 'confirmed',
  processing: 'being prepared',
  shipped: 'on the way',
  out_for_delivery: 'out for delivery',
  delivered: 'delivered',
  completed: 'completed',
  cancelled: 'cancelled',
};

const BOOKING_CUSTOMER = {
  seller_assigned: (seller) => ({
    title: 'Decorator confirmed 🎉',
    body: `${seller?.name || 'A decorator'} accepted your booking. Tap to see the details.`,
  }),
  vendor_assigned: (seller) => ({
    title: 'Decorator confirmed 🎉',
    body: `${seller?.name || 'A decorator'} accepted your booking. Tap to see the details.`,
  }),
  in_transit: () => ({
    title: 'Your decorator is on the way',
    body: 'They have set off and will reach you shortly.',
  }),
  completed: () => ({
    title: 'Your decoration is ready ✅',
    body: 'All done! Tap to see your booking.',
  }),
  cancelled: (seller, cancelledBy) =>
    cancelledBy === 'seller'
      ? {
          title: 'Booking cancelled by decorator',
          body: 'Your decorator had to cancel. Please book again and we will find you another one.',
        }
      : {
          title: 'Booking cancelled',
          body: 'Your booking was cancelled.',
        },
  allocation_failed: () => ({
    title: "We couldn't find a decorator yet",
    body: 'Tap to try another time or chat with us.',
  }),
};

/* ---------- the events ---------- */
module.exports = {
  // emit('order.created', { order, req, seller, commission })
  'order.created': async ({ order, req, seller, commission }) => {
    const out = [];

    const customerId = await customerIdForOrder(order, req);
    if (customerId) {
      out.push({
        to: 'customer',
        id: customerId,
        title: 'Order placed',
        body: `Your order #${order.customOrderId} (${money(order.totalAmount)}) is confirmed${when(order.scheduledDelivery)}.`,
        route: '/account',
        channelId: 'default',
        priority: 'high',
        sound: 'default',
      });
    }

    if (seller) {
      out.push({
        to: 'seller',
        id: seller._id,
        title: 'New order from your link',
        body: `Order #${order.customOrderId} placed${commission ? `. You earn ${money(commission)} commission` : ''}.`,
        route: '/account',
        channelId: 'default',
        priority: 'high',
        sound: 'default',
      });
    }

    return out;
  },

  // emit('order.paid', { order, req })
  'order.paid': async ({ order, req }) => {
    const customerId = await customerIdForOrder(order, req);
    if (!customerId) return [];
    return [
      {
        to: 'customer',
        id: customerId,
        title: 'Payment received',
        body: `We received your payment for order #${order.customOrderId}. Thank you!`,
        route: '/account',
        channelId: 'default',
        priority: 'high',
        sound: 'default',
      },
    ];
  },

  // emit('order.status', { order, status, req })
  'order.status': async ({ order, status, req }) => {
    const customerId = await customerIdForOrder(order, req);
    if (!customerId) return [];
    const text = ORDER_STATUS_TEXT[status] || String(status).replace(/_/g, ' ');
    return [
      {
        to: 'customer',
        id: customerId,
        title: 'Order update',
        body: `Your order #${order.customOrderId} is ${text}.`,
        route: '/account',
        channelId: 'default',
        priority: 'high',
        sound: 'default',
      },
    ];
  },

  // emit('booking.created', { booking, req })
  'booking.created': async ({ booking }) => {
    const userId = idOf(booking?.userId);
    if (!userId) return [];
    return [
      {
        to: 'customer',
        id: userId,
        title: 'Booking received',
        body: 'Finding the best decorator near you…',
        route: '/account',
        channelId: 'default',
        priority: 'high',
        sound: 'default',
      },
    ];
  },

  // emit('booking.status', { booking, status, seller?, cancelledBy? })
  'booking.status': async ({ booking, status, seller, cancelledBy }) => {
    const userId = idOf(booking?.userId);
    if (!userId) return [];

    if (status === 'cancelled' && cancelledBy === 'customer') return [];

    const build = BOOKING_CUSTOMER[status];
    if (!build) return [];

    return [
      {
        to: 'customer',
        id: userId,
        ...build(seller, cancelledBy),
        route: '/account',
        channelId: 'default',
        priority: 'high',
        sound: 'default',
      },
    ];
  },

  // emit('booking.offer', { booking, seller })
  // UBER/OLA STYLE DISPATCH: Rings device with MAX priority, custom vibration, and native Accept/Decline action buttons
  'booking.offer': async ({ booking, seller }) => {
    const sellerId = idOf(seller);
    if (!sellerId) return [];

    const product = booking?.selectedProductId || {};
    const priceText = product.price || booking?.estimatedPrice ? money(product.price || booking.estimatedPrice) : 'Job';
    const location = booking?.pickupLocation?.city || booking?.pickupLocation?.address || 'Nearby';

    return [
      {
        to: 'seller',
        id: sellerId,
        title: `🚨 NEW BOOKING OFFER (${priceText})`,
        body: `${location} - Tap or choose an option to accept this request.`,
        route: `/account?tab=jobs&bookingId=${booking._id}`,
        channelId: 'booking_offers',
        categoryId: 'booking_offer_actions',
        priority: 'high',
        sound: 'default',
        data: {
          bookingId: String(booking._id),
          sellerId: String(sellerId),
          type: 'BOOKING_OFFER',
          route: `/account?tab=jobs&bookingId=${booking._id}`,
        },
      },
    ];
  },

  // emit('booking.seller_cancelled', { booking, sellerId })
  'booking.seller_cancelled': async ({ booking, sellerId }) => {
    const id = idOf(sellerId);
    if (!id) return [];
    return [
      {
        to: 'seller',
        id,
        title: 'Booking cancelled by customer',
        body: 'The customer cancelled this job. You are available for new requests again.',
        route: '/account',
        channelId: 'default',
        priority: 'high',
        sound: 'default',
      },
    ];
  },

  // emit('chat.message', { chat, bookingId, senderType, senderName, text })
  'chat.message': async ({ chat, bookingId, senderType, senderName, text }) => {
    const toSeller = senderType === 'user';
    const id = idOf(toSeller ? chat?.sellerId : chat?.userId);
    if (!id) return [];

    const clean = String(text || '').trim();
    const preview = clean.length > 120 ? clean.slice(0, 117) + '…' : clean;

    return [
      {
        to: toSeller ? 'seller' : 'customer',
        id,
        title: senderName || (toSeller ? 'Customer' : 'Your decorator'),
        body: preview || 'Sent you a message',
        route: `/account?tab=${toSeller ? 'jobs' : 'bookings'}&chat=${bookingId}`,
        channelId: 'messages',
        priority: 'high',
        sound: 'default',
        data: {
          bookingId: String(bookingId),
          route: `/account?tab=${toSeller ? 'jobs' : 'bookings'}&chat=${bookingId}`,
        },
      },
    ];
  },

  // emit('custom', { to, id, title, body, route })
  custom: async ({ to, id, title, body, route = '/account' }) => [
    {
      to,
      id,
      title,
      body,
      route,
      channelId: 'default',
      priority: 'high',
      sound: 'default',
    },
  ],
};