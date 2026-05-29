const mongoose = require('mongoose');
const User = require('../models/userModel');
const Like = require('../models/likeModel');
const { get, set, del, delByPattern, hashQuery, TTL } = require('../src/cache');

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { buildLocationPattern } = require('../src/locationParser');

const REGION = process.env.AWS_REGION || 'eu-central-1';
const BUCKET = process.env.S3_BUCKET || 'molo-user-photos';
const PRESIGNED_TTL_SEC = Number(process.env.S3_GET_TTL_SEC || 3600);

const s3 = new S3Client({
  region: REGION,
  credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
    ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
    : undefined,
});

function getReqUserId(req) {
  return req.user?._id || req.user?.id || req.auth?.userId || req.regUserId || req.userId;
}

// Presigned URL — кешируем 55 минут
async function getGetObjectUrl(key, expiresInSec = PRESIGNED_TTL_SEC) {
  if (!key) return null;
  const cacheKey = `s3_url:${key}`;
  const cached = await get(cacheKey);
  if (cached) return cached;
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  const url = await getSignedUrl(s3, cmd, { expiresIn: expiresInSec });
  await set(cacheKey, url, TTL.S3_URL);
  return url;
}

function toFeedUser(user) {
  return {
    _id:          user._id,
    id:           user._id,
    name:         user.name,
    age:          user.age,
    gender:       user.gender,
    interests:    user.interests || [],
    userLocation: user.userLocation,
    userPhoto:    user.userPhoto || [],
    userPhotoUrls: user.userPhotoUrls || [],
    wishUser:     user.wishUser,
    userSex:      user.userSex,
    isOnline:     user.isOnline || false,
    lastSeen:     user.lastSeen || null,
    lookingFor:   user.lookingFor || null,
    about:        user.about || null,
    work:         user.work || null,
    education:    user.education || null,
    zodiac:       user.zodiac || null,
    languages:    user.languages || [],
    children:     user.children || null,
    pets:         user.pets || null,
    smoking:      user.smoking || null,
    alcohol:      user.alcohol || null,
    relationship: user.relationship || null,
  };
}

async function enrichUserWithPhotos(user) {
  const feedUser = toFeedUser(user);
  if (feedUser.userPhoto?.length > 0) {
    const approved = feedUser.userPhoto.filter(p => !p.status || p.status === 'approved');
    feedUser.photoUrls = (await Promise.all(approved.map(async (photo) => {
      if (photo?.key) return getGetObjectUrl(photo.key);
      if (photo?.url?.startsWith('http')) return photo.url;
      if (typeof photo === 'string') return photo.startsWith('http') ? photo : getGetObjectUrl(photo);
      return null;
    }))).filter(Boolean);
  } else {
    feedUser.photoUrls = feedUser.userPhotoUrls || [];
  }
  return feedUser;
}

// ─── Scoring ──────────────────────────────────────────────────────────────────
// +100  user liked me (pending)
// +40   online now
// +20   last seen < 1h
// +10   last seen < 24h
// +3    last seen < 7d
// 0–20  profile completeness
function scoreUser(user, likedMeSet) {
  let score = 0;

  if (likedMeSet.has(String(user._id))) score += 100;

  if (user.isOnline) {
    score += 40;
  } else if (user.lastSeen) {
    const ageMs = Date.now() - new Date(user.lastSeen).getTime();
    if      (ageMs < 3_600_000)   score += 20;
    else if (ageMs < 86_400_000)  score += 10;
    else if (ageMs < 604_800_000) score += 3;
  }

  let cp = 0;
  const approved = (user.userPhoto || []).filter(p => !p.status || p.status === 'approved');
  if (approved.length >= 1) cp += 5;
  if (approved.length >= 3) cp += 3;
  if (user.about)                          cp += 4;
  if (user.work)                           cp += 2;
  if (user.education)                      cp += 2;
  if ((user.interests?.length || 0) >= 2)  cp += 2;
  if (user.lookingFor?.id)                 cp += 2;
  score += Math.min(20, cp);

  return score;
}

// ─── Build feed data (used by controller + cacheWarmer) ──────────────────────
async function buildFeedData(userId, q = {}) {
  const page  = Math.max(1, parseInt(q.page) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(q.limit) || 50));
  const skip  = (page - 1) * limit;

  let currentUser = await get(`cur_user:${userId}`);
  if (!currentUser) {
    currentUser = await User.findById(userId).lean();
    if (currentUser) await set(`cur_user:${userId}`, currentUser, TTL.CURRENT_USER);
  }
  if (!currentUser) return null;

  const currentUserObjectId = new mongoose.Types.ObjectId(userId);
  const filter = { _id: { $ne: currentUserObjectId } };

  if (q.lookingFor && q.lookingFor !== 'any') filter['gender.id'] = q.lookingFor;
  if (q.ageMin || q.ageMax) {
    filter.age = {};
    if (q.ageMin) filter.age.$gte = Number(q.ageMin);
    if (q.ageMax) filter.age.$lte = Number(q.ageMax);
  }
  if (q.online === 'true') filter.isOnline = true;
  if (q.orientation) filter.userSex = q.orientation;
  if (q.goals) {
    const goals = q.goals.split(',').filter(Boolean);
    if (goals.length) filter['lookingFor.id'] = { $in: goals };
  }
  if (q.zodiac) filter.zodiac = q.zodiac;
  if (q.languages) {
    const langs = q.languages.split(',').filter(Boolean);
    if (langs.length) filter.languages = { $in: langs };
  }
  if (q.children)     filter.children = q.children;
  if (q.pets) {
    const pets = q.pets.split(',').filter(Boolean);
    if (pets.length) filter.pets = { $in: pets };
  }
  if (q.interests) {
    const ints = q.interests.split(',').filter(Boolean);
    if (ints.length) filter.interests = { $in: ints };
  }
  if (q.smoking)      filter.smoking = q.smoking;
  if (q.alcohol)      filter.alcohol = q.alcohol;
  if (q.relationship) filter.relationship = q.relationship;
  if (q.education)    filter.education = q.education;

  const expansionLevel = parseInt(q.expansionLevel) || 0;
  if (q.location) {
    const pattern = buildLocationPattern(q.location, expansionLevel);
    if (pattern) filter.userLocation = { $regex: pattern, $options: 'i' };
  }

  // Fetch pool (extra for scoring; respect original skip for pagination)
  const rawUsers = await User.find(filter).skip(skip).limit(limit + 1).lean();
  const hasMore = rawUsers.length > limit;
  const pool    = hasMore ? rawUsers.slice(0, limit) : rawUsers;

  // Who liked me — boost their score
  let likedMeSet = new Set();
  try {
    const likesForMe = await Like.find({
      toUser: currentUserObjectId,
      status: 'pending',
    }).select('fromUser').lean();
    likesForMe.forEach(l => likedMeSet.add(String(l.fromUser)));
  } catch (e) {
    console.warn('[feed] Could not fetch likes:', e.message);
  }

  // Score and sort
  const scored = pool.map(u => ({ user: u, score: scoreUser(u, likedMeSet) }));
  scored.sort((a, b) => b.score - a.score);
  const sorted = scored.map(s => s.user);

  const enrichedUsers = await Promise.all(sorted.map(enrichUserWithPhotos));

  return { users: enrichedUsers, page, hasMore, expansionLevel };
}

// Overlay свежего isOnline поверх любого ответа
async function overlayOnlineStatus(users) {
  if (!users?.length) return;
  try {
    const ids   = users.map(u => u._id);
    const fresh = await User.find({ _id: { $in: ids } }, { isOnline: 1 }).lean();
    const map   = {};
    fresh.forEach(u => { map[String(u._id)] = u.isOnline; });
    users.forEach(u => { u.isOnline = map[String(u._id)] ?? false; });
  } catch (e) {
    console.error('[overlayOnlineStatus] error:', e.message);
  }
}

// GET /feed
async function getFeed(req, res) {
  try {
    const currentUserId = getReqUserId(req);
    if (!currentUserId || !mongoose.Types.ObjectId.isValid(String(currentUserId))) {
      return res.status(401).json({ message: 'Unauthorized: user id not found' });
    }

    const filterHash = hashQuery({
      ...req.query,
      page:  String(req.query.page  || 1),
      limit: String(req.query.limit || 50),
    });
    const feedCacheKey = `feed:${currentUserId}:${filterHash}`;

    let result = await get(feedCacheKey);
    if (result) {
      console.log(`[feed GET] cache HIT — key=${feedCacheKey}`);
    } else {
      console.log(`[feed GET] cache MISS — key=${feedCacheKey}`);
      result = await buildFeedData(String(currentUserId), req.query);
      if (!result) return res.status(404).json({ message: 'Current user not found' });
      await set(feedCacheKey, result, TTL.FEED);
      console.log(`[feed GET] cache SET — key=${feedCacheKey}, users=${result.users.length}`);
    }

    await overlayOnlineStatus(result.users);
    return res.json(result);
  } catch (e) {
    console.error('[feed GET] error:', e);
    return res.status(500).json({ message: 'Server error' });
  }
}

// GET /feed/:userId
async function getUserProfile(req, res) {
  try {
    const currentUserId = getReqUserId(req);
    const { userId } = req.params;

    if (!currentUserId || !mongoose.Types.ObjectId.isValid(String(currentUserId))) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) {
      return res.status(400).json({ message: 'Invalid user id' });
    }

    const profileCacheKey = `profile:${userId}`;
    let enrichedUser = await get(profileCacheKey);
    if (enrichedUser) {
      console.log(`[profile GET] cache HIT — userId=${userId}`);
    } else {
      const user = await User.findById(userId).lean();
      if (!user) return res.status(404).json({ message: 'User not found' });
      enrichedUser = await enrichUserWithPhotos(user);
      await set(profileCacheKey, enrichedUser, TTL.PROFILE);
    }

    await overlayOnlineStatus([enrichedUser]);
    return res.json({ user: enrichedUser });
  } catch (e) {
    console.error('[feed GET user] error:', e);
    return res.status(500).json({ message: 'Server error' });
  }
}

async function invalidateUserCache(userId) {
  await del(`profile:${userId}`);
  await del(`cur_user:${userId}`);
  await delByPattern('feed:*');
  console.log(`[cache] Invalidated for userId=${userId}`);
}

async function invalidateCacheHandler(req, res) {
  const { userId } = req.params;
  if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) {
    return res.status(400).json({ message: 'Invalid userId' });
  }
  await invalidateUserCache(userId);
  return res.json({ ok: true });
}

// POST /feed/:userId/like
async function likeUser(req, res) {
  try {
    const currentUserId = getReqUserId(req);
    const { userId } = req.params;
    if (!currentUserId || !mongoose.Types.ObjectId.isValid(String(currentUserId))) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) {
      return res.status(400).json({ message: 'Invalid user id' });
    }
    const targetUser = await User.findById(userId).lean();
    if (!targetUser) return res.status(404).json({ message: 'User not found' });
    return res.json({ success: true, userId, isMatch: false, match: null });
  } catch (e) {
    console.error('[feed LIKE] error:', e);
    return res.status(500).json({ message: 'Server error' });
  }
}

// POST /feed/:userId/pass
async function passUser(req, res) {
  try {
    const currentUserId = getReqUserId(req);
    const { userId } = req.params;
    if (!currentUserId || !mongoose.Types.ObjectId.isValid(String(currentUserId))) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) {
      return res.status(400).json({ message: 'Invalid user id' });
    }
    return res.json({ success: true, userId });
  } catch (e) {
    console.error('[feed PASS] error:', e);
    return res.status(500).json({ message: 'Server error' });
  }
}

// GET /feed/matches
async function getMatches(req, res) {
  try {
    const currentUserId = getReqUserId(req);
    if (!currentUserId || !mongoose.Types.ObjectId.isValid(String(currentUserId))) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    return res.json({ matches: [] });
  } catch (e) {
    console.error('[feed MATCHES] error:', e);
    return res.status(500).json({ message: 'Server error' });
  }
}

module.exports = {
  getFeed,
  getUserProfile,
  likeUser,
  passUser,
  getMatches,
  invalidateUserCache,
  invalidateCacheHandler,
  buildFeedData,
};
