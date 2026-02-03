const mongoose = require('../src/db');

const userSchema = new mongoose.Schema({
  chatId: { type: String, index: true, unique: true, sparse: true },
  confirmationCode: { type: String, index: true, unique: true, sparse: true },
  name: { type: String, index: true, unique: true, sparse: true },
  email: { type: String, index: true, unique: true, sparse: true },
  interests: { type: [String], default: [] },
  googleId: { type: String, index: true, unique: true, sparse: true },
  age: { type: Number },
  userBirthday: { type: String },
  gender: { type: String, enum: ['male', 'female', 'other'] },
  wishUser: { type: String, enum: ['male', 'female', 'all'] },
  userPhoto: [{ type: String }],
  userPhotoUrls: [{ type: String }],
  tabIconUserProfile: { type: String },
  userLocation: { type: String, index: true },
  userSex: { type: String, enum: ['heterosexual', 'gay', 'lesbian', 'bisexual', 'asexual'] }
});

const User = mongoose.models.User || mongoose.model('User', userSchema);

module.exports = User;