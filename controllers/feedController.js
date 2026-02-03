// controllers/feedController.js
const mongoose = require('mongoose');
const User = require('../models/userModel');

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

// Получить userId из запроса
function getReqUserId(req) {
  return (
    req.user?._id ||
    req.user?.id ||
    req.auth?.userId ||
    req.regUserId ||
    req.userId
  );
}

// Генерация presigned URL для S3
async function getGetObjectUrl(key, expiresInSec = PRESIGNED_TTL_SEC) {
  if (!key) return null;
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(s3, cmd, { expiresIn: expiresInSec });
}

// Преобразование пользователя в безопасный формат для отправки
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
  };
}

// Добавить presigned URLs к фотографиям пользователя
async function enrichUserWithPhotos(user) {
  const feedUser = toFeedUser(user);

  // userPhoto может быть:
  // 1. Массив объектов { key, bucket, status, ... }
  // 2. Массив строк (S3 keys или URLs)
  if (feedUser.userPhoto && feedUser.userPhoto.length > 0) {
    // Фильтруем только approved фото (если есть статус)
    const approvedPhotos = feedUser.userPhoto.filter(
      (p) => !p.status || p.status === 'approved'
    );

    feedUser.photoUrls = await Promise.all(
      approvedPhotos.map(async (photo) => {
        // Если это объект с key
        if (photo && typeof photo === 'object' && photo.key) {
          return await getGetObjectUrl(photo.key);
        }
        // Если это строка (S3 key или URL)
        if (typeof photo === 'string' && photo.length > 0) {
          // Если уже URL - возвращаем как есть
          if (photo.startsWith('http')) {
            return photo;
          }
          // Иначе это S3 key
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

// GET /feed - получить ленту пользователей
async function getFeed(req, res) {
  try {
    const currentUserId = getReqUserId(req);
    console.log('[feed GET] currentUserId:', currentUserId);

    if (!currentUserId || !mongoose.Types.ObjectId.isValid(String(currentUserId))) {
      return res.status(401).json({ message: 'Unauthorized: user id not found' });
    }

    // Пагинация
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
    const skip = (page - 1) * limit;

    // Получаем текущего пользователя для фильтрации по предпочтениям
    const currentUser = await User.findById(currentUserId).lean();
    console.log('[feed GET] currentUser:', currentUser?.name, 'wishUser:', currentUser?.wishUser);

    if (!currentUser) {
      return res.status(404).json({ message: 'Current user not found' });
    }

    // Строим фильтр для поиска пользователей
    // Конвертируем в ObjectId для корректного сравнения
    const currentUserObjectId = new mongoose.Types.ObjectId(currentUserId);

    const filter = {
      _id: { $ne: currentUserObjectId },
    };

    // TODO: Раскомментировать после отладки
    // Фильтр по полу (wishUser текущего пользователя)
    // if (currentUser.wishUser && currentUser.wishUser !== 'all') {
    //   filter.$or = [
    //     { gender: currentUser.wishUser },
    //     { 'gender.title': currentUser.wishUser },
    //   ];
    // }

    console.log('[feed GET] filter:', JSON.stringify(filter));

    // Получаем пользователей
    const users = await User.find(filter)
      .skip(skip)
      .limit(limit + 1) // +1 для проверки hasMore
      .lean();

    console.log('[feed GET] found users:', users.length, users.map(u => u.name));

    // Проверяем, есть ли ещё пользователи
    const hasMore = users.length > limit;
    const usersToReturn = hasMore ? users.slice(0, limit) : users;

    // Обогащаем пользователей presigned URLs для фотографий
    const enrichedUsers = await Promise.all(
      usersToReturn.map(enrichUserWithPhotos)
    );

    console.log(`[feed GET] page=${page}, limit=${limit}, found=${enrichedUsers.length}, hasMore=${hasMore}`);

    return res.json({
      users: enrichedUsers,
      page,
      hasMore,
    });
  } catch (e) {
    console.error('[feed GET] error:', e);
    return res.status(500).json({ message: 'Server error' });
  }
}

// GET /feed/:userId - получить профиль конкретного пользователя
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

    const user = await User.findById(userId).lean();
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const enrichedUser = await enrichUserWithPhotos(user);

    return res.json({ user: enrichedUser });
  } catch (e) {
    console.error('[feed GET user] error:', e);
    return res.status(500).json({ message: 'Server error' });
  }
}

// POST /feed/:userId/like - лайкнуть пользователя
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

    // Проверяем, что целевой пользователь существует
    const targetUser = await User.findById(userId).lean();
    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    // TODO: Здесь нужно добавить логику сохранения лайка в отдельную коллекцию
    // Например, создать модель Like { fromUser, toUser, createdAt }
    // И проверять взаимные лайки для определения матча

    console.log(`[feed LIKE] user ${currentUserId} liked user ${userId}`);

    // Временно возвращаем успех без проверки матча
    // В будущем нужно добавить коллекцию лайков и проверку взаимности
    return res.json({
      success: true,
      userId,
      isMatch: false, // TODO: проверить взаимный лайк
      match: null,
    });
  } catch (e) {
    console.error('[feed LIKE] error:', e);
    return res.status(500).json({ message: 'Server error' });
  }
}

// POST /feed/:userId/pass - пропустить пользователя
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

    // TODO: Сохранить пропуск в отдельную коллекцию, чтобы не показывать этого пользователя снова
    // Например, создать модель Pass { fromUser, toUser, createdAt }

    console.log(`[feed PASS] user ${currentUserId} passed user ${userId}`);

    return res.json({
      success: true,
      userId,
    });
  } catch (e) {
    console.error('[feed PASS] error:', e);
    return res.status(500).json({ message: 'Server error' });
  }
}

// GET /feed/matches - получить список матчей
async function getMatches(req, res) {
  try {
    const currentUserId = getReqUserId(req);

    if (!currentUserId || !mongoose.Types.ObjectId.isValid(String(currentUserId))) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // TODO: Реализовать получение матчей из коллекции лайков
    // Матч = когда оба пользователя лайкнули друг друга

    console.log(`[feed MATCHES] getting matches for user ${currentUserId}`);

    // Временно возвращаем пустой массив
    return res.json({
      matches: [],
    });
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
};