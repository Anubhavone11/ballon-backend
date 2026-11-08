'use strict';
const express = require('express');
const userAuth = require('../middleware/userAuth');
const attachUserId = require('../middleware/attachUserId');
const w = require('../controllers/Wishlistcontroller');

const router = express.Router();
router.use(userAuth, attachUserId);

router.get('/ids', w.getIds); // keep before '/:productId'
router.get('/', w.list);
router.post('/:productId', w.add);
router.delete('/:productId', w.remove);

module.exports = router;