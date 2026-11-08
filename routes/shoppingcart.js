'use strict';
const express = require('express');
const userAuth = require('../middleware/userAuth');
const attachUserId = require('../middleware/attachUserId');
const cart = require('../controllers/shoppingcartcontroller');

const router = express.Router();
router.use(userAuth, attachUserId);

router.get('/', cart.getCart);
router.post('/items', cart.addItem);
router.put('/items/:productId', cart.updateItem);
router.delete('/items/:productId', cart.removeItem);
router.delete('/', cart.clearCart);
router.post('/merge', cart.mergeItems);

module.exports = router;