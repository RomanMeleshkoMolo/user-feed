const mongoose = require('mongoose');
const likesConn = require('../src/likesDb');

// Read-only доступ к лайкам из molo_likes
const likeSchema = new mongoose.Schema({
  fromUser:  { type: mongoose.Schema.Types.ObjectId, index: true },
  toUser:    { type: mongoose.Schema.Types.ObjectId, index: true },
  status:    { type: String },
  createdAt: { type: Date },
});

const Like = likesConn.models.Like || likesConn.model('Like', likeSchema);

module.exports = Like;
