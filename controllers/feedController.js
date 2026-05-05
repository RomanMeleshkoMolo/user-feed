// controllers/feedController.js
const mongoose = require('mongoose');
const User = require('../models/userModel');
const { get, set, del, delByPattern, hashQuery, TTL } = require('../src/cache');

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const REGION = process.env.AWS_REGION || 'eu-central-1';
const BUCKET = process.env.S3_BUCKET || 'molo-user-photos';
const PRESIGNED_TTL_SEC = Number(process.env.S3_GET_TTL_SEC || 3600);

const s3 = new S3Client({
  region: REGION,
  credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
    ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      }
    : undefined,
});

function getReqUserId(req) {
  return (
    req.user?._id ||
    req.user?.id ||
    req.auth?.userId ||
    req.regUserId ||
    req.userId
  );
}

// Presigned URL — кешируем на 55 минут (сам URL живёт 60 мин)
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
    _id: user._id,
    id: user._id,
    name: user.name,
    age: user.age,
    gender: user.gender,
    interests: user.interests || [],
    userLocation: user.userLocation,
    userPhoto: user.userPhoto || [],
    userPhotoUrls: user.userPhotoUrls || [],
    wishUser: user.wishUser,
    userSex: user.userSex,
    isOnline: user.isOnline || false,
    lastSeen: user.lastSeen || null,
    lookingFor: user.lookingFor || null,
    about: user.about || null,
    work: user.work || null,
    education: user.education || null,
    zodiac: user.zodiac || null,
    languages: user.languages || [],
    children: user.children || null,
    pets: user.pets || null,
    smoking: user.smoking || null,
    alcohol: user.alcohol || null,
    relationship: user.relationship || null,
  };
}

async function enrichUserWithPhotos(user) {
  const feedUser = toFeedUser(user);

  if (feedUser.userPhoto && feedUser.userPhoto.length > 0) {
    const approvedPhotos = feedUser.userPhoto.filter(
      (p) => !p.status || p.status === 'approved'
    );
    feedUser.photoUrls = await Promise.all(
      approvedPhotos.map(async (photo) => {
        if (photo && typeof photo === 'object' && photo.key) return await getGetObjectUrl(photo.key);
        if (photo && typeof photo === 'object' && photo.url && photo.url.startsWith('http')) return photo.url;
        if (typeof photo === 'string' && photo.length > 0) {
          if (photo.startsWith('http')) return photo;
          return await getGetObjectUrl(photo);
        }
        return null;
      })
    );
    feedUser.photoUrls = feedUser.photoUrls.filter(Boolean);
  } else {
    feedUser.photoUrls = feedUser.userPhotoUrls || [];
  }

  return feedUser;
}

// ─── Ядро: построение ленты для userId + queryParams ───────────────────────
// Используется и контроллером (через req/res), и cacheWarmer напрямую
async function buildFeedData(userId, q = {}) {
  const page = Math.max(1, parseInt(q.page) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(q.limit) || 50));
  const skip = (page - 1) * limit;

  // Текущий пользователь — кешируем отдельно
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
    const goalsList = q.goals.split(',').filter(Boolean);
    if (goalsList.length > 0) filter['lookingFor.id'] = { $in: goalsList };
  }
  if (q.zodiac) filter.zodiac = q.zodiac;
  if (q.languages) {
    const langList = q.languages.split(',').filter(Boolean);
    if (langList.length > 0) filter.languages = { $in: langList };
  }
  if (q.children) filter.children = q.children;
  if (q.pets) {
    const petsList = q.pets.split(',').filter(Boolean);
    if (petsList.length > 0) filter.pets = { $in: petsList };
  }
  if (q.smoking) filter.smoking = q.smoking;
  if (q.alcohol) filter.alcohol = q.alcohol;
  if (q.relationship) filter.relationship = q.relationship;
  if (q.education) filter.education = q.education;

  let users = await User.find(filter).skip(skip).limit(limit + 1).lean();

  const hasActiveFilters = Object.keys(filter).length > 1;
  const isStrict = q.strict === 'true';
  if (users.length === 0 && hasActiveFilters && page === 1 && !isStrict) {
    users = await User.find({ _id: { $ne: currentUserObjectId } })
      .skip(skip).limit(limit + 1).lean();
  }

  const hasMore = users.length > limit;
  const usersToReturn = hasMore ? users.slice(0, limit) : users;
  const enrichedUsers = await Promise.all(usersToReturn.map(enrichUserWithPhotos));

  return { users: enrichedUsers, page, hasMore };
}

// GET /feed
async function getFeed(req, res) {
  try {
    const currentUserId = getReqUserId(req);
    if (!currentUserId || !mongoose.Types.ObjectId.isValid(String(currentUserId))) {
      return res.status(401).json({ message: 'Unauthorized: user id not found' });
    }

    const filterHash = hashQuery({ ...req.query, page: String(req.query.page || 1), limit: String(req.query.limit || 50) });
    const feedCacheKey = `feed:${currentUserId}:${filterHash}`;

    const cached = await get(feedCacheKey);
    if (cached) {
      console.log(`[feed GET] cache HIT — key=${feedCacheKey}`);
      return res.json(cached);
    }
    console.log(`[feed GET] cache MISS — key=${feedCacheKey}`);

    const result = await buildFeedData(String(currentUserId), req.query);
    if (!result) return res.status(404).json({ message: 'Current user not found' });

    await set(feedCacheKey, result, TTL.FEED);
    console.log(`[feed GET] cache SET — key=${feedCacheKey}, users=${result.users.length}`);

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
    const cached = await get(profileCacheKey);
    if (cached) {
      console.log(`[profile GET] cache HIT — userId=${userId}`);
      return res.json({ user: cached });
    }

    const user = await User.findById(userId).lean();
    if (!user) return res.status(404).json({ message: 'User not found' });

    const enrichedUser = await enrichUserWithPhotos(user);
    await set(profileCacheKey, enrichedUser, TTL.PROFILE);
    console.log(`[profile GET] cache SET — userId=${userId}`);

    return res.json({ user: enrichedUser });
  } catch (e) {
    console.error('[feed GET user] error:', e);
    return res.status(500).json({ message: 'Server error' });
  }
}

// Инвалидация кеша при обновлении профиля
async function invalidateUserCache(userId) {
  await del(`profile:${userId}`);
  await del(`cur_user:${userId}`);
  await delByPattern(`feed:*`);
  console.log(`[cache] Invalidated for userId=${userId}`);
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
  buildFeedData,
};
