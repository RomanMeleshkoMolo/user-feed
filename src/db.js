const mongoose = require('mongoose');

mongoose.connect('mongodb://localhost:27017/users')
  .then(() => console.log('[DB] Connected to MongoDB'))
  .catch(err => console.error('[DB] MongoDB connection error:', err));

mongoose.connection.on('error', err => {
  console.error('[DB] MongoDB error:', err);
});

module.exports = mongoose;