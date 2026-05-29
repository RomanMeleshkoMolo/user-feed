const mongoose = require('mongoose');
require('dotenv').config();

const LIKES_MONGO_URI = process.env.LIKES_MONGO_URI || 'mongodb://localhost:27017/molo_likes';

const likesConn = mongoose.createConnection(LIKES_MONGO_URI, {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
});

likesConn.on('connected', () => console.log('[user-feed] likesConn connected → molo_likes'));
likesConn.on('error',     (err) => console.error('[user-feed] likesConn error:', err));

module.exports = likesConn;
