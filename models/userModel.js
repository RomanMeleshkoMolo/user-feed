const mongoose = require('../src/db');

const userSchema = new mongoose.Schema({
  chatId: { type: String, index: true, unique: true, sparse: true },
  confirmationCode: { type: String, index: true, unique: true, sparse: true },
  name: { type: String, index: true, unique: true, sparse: true },
  email: { type: String, index: true, unique: true, sparse: true },
  interests: { type: [String], default: [] },
  education: { type: String, default: '' },
  lookingFor: {
    id: { type: String },
    title: { type: String },
    icon: { type: String, default: '' },
  },
  about: { type: String, default: '' },
  work: { type: String, default: '' },
  googleId: { type: String, index: true, unique: true, sparse: true },
  age: { type: Number },
  userBirthday: { type: String },
  gender: { type: String, enum: ['male', 'female', 'other'] },
  wishUser: { type: String, enum: ['male', 'female', 'all'] },
  userPhoto: [{ type: String }],
  userPhotoUrls: [{ type: String }],
  tabIconUserProfile: { type: String },
  userLocation: { type: String, index: true },
  userSex: { type: String, enum: ['heterosexual', 'gay', 'lesbian', 'bisexual', 'asexual'] },
  zodiac: { type: String, default: '' },
  languages: { type: [String], default: [] },
  children: { type: String, default: '' },
  pets: { type: [String], default: [] },
  smoking: { type: String, default: '' },
  alcohol: { type: String, default: '' },
  relationship: { type: String, default: '' },

  // Онлайн статус
  isOnline: { type: Boolean, default: false },
  lastSeen: { type: Date, default: null },
});

const User = mongoose.models.User || mongoose.model('User', userSchema);

module.exports = User;