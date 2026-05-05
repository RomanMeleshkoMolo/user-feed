const redis = require('./redis');
const crypto = require('crypto');

const TTL = {
  FEED: 5 * 60,          // 5 минут — лента
  PROFILE: 30 * 60,      // 30 минут — профиль пользователя
  S3_URL: 55 * 60,       // 55 минут — presigned URL (действует 60 мин)
  CURRENT_USER: 10 * 60, // 10 минут — данные текущего юзера
};

async function get(key) {
  try {
    const val = await redis.get(key);
    return val ? JSON.parse(val) : null;
  } catch {
    return null;
  }
}

async function set(key, value, ttlSeconds) {
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch {
    // Redis недоступен — молча продолжаем без кеша
  }
}

async function del(key) {
  try {
    await redis.del(key);
  } catch {}
}

async function delByPattern(pattern) {
  try {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(...keys);
  } catch {}
}

// Хеш фильтров запроса → короткий ключ
function hashQuery(query) {
  const sorted = Object.keys(query)
    .sort()
    .reduce((acc, k) => { acc[k] = query[k]; return acc; }, {});
  return crypto.createHash('md5').update(JSON.stringify(sorted)).digest('hex').slice(0, 8);
}

module.exports = { get, set, del, delByPattern, hashQuery, TTL };
