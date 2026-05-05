// src/cacheWarmer.js
// Прогревает Redis-кеш для активных пользователей до того, как они откроют ленту
const User = require('../models/userModel');
const { get, set, hashQuery, TTL } = require('./cache');
const { buildFeedData } = require('../controllers/feedController');

// Прогреваем только страницу 1 без фильтров — покрывает ~80% реальных запросов
const DEFAULT_QUERY = { page: '1', limit: '50' };
const WARM_INTERVAL_MS = 4 * 60 * 1000; // 4 минуты (TTL ленты = 5 мин)
const BATCH_SIZE = 5;                    // сколько юзеров прогреваем параллельно
const ACTIVE_WINDOW_MS = 30 * 60 * 1000; // считаем "активными" тех, кто был онлайн <= 30 мин назад

async function getActiveUserIds() {
  const since = new Date(Date.now() - ACTIVE_WINDOW_MS);
  const users = await User.find(
    {
      $or: [
        { isOnline: true },
        { lastSeen: { $gte: since } },
      ],
    },
    { _id: 1 }
  ).lean();
  return users.map((u) => String(u._id));
}

async function warmUser(userId) {
  const filterHash = hashQuery(DEFAULT_QUERY);
  const feedCacheKey = `feed:${userId}:${filterHash}`;

  // Если кеш ещё свежий — не трогаем
  const existing = await get(feedCacheKey);
  if (existing) return 'skip';

  const result = await buildFeedData(userId, DEFAULT_QUERY);
  if (!result) return 'no_user';

  await set(feedCacheKey, result, TTL.FEED);
  return 'warmed';
}

async function runWarmCycle() {
  const start = Date.now();
  let warmed = 0, skipped = 0, errors = 0;

  try {
    const userIds = await getActiveUserIds();
    if (userIds.length === 0) {
      console.log('[Warmer] No active users, skipping');
      return;
    }

    // Обрабатываем батчами чтобы не перегружать MongoDB и S3
    for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
      const batch = userIds.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(batch.map(warmUser));

      for (const r of results) {
        if (r.status === 'fulfilled') {
          if (r.value === 'warmed') warmed++;
          else skipped++;
        } else {
          errors++;
        }
      }
    }

    const elapsed = Date.now() - start;
    console.log(
      `[Warmer] Done in ${elapsed}ms — active=${userIds.length}, warmed=${warmed}, skipped=${skipped}, errors=${errors}`
    );
  } catch (e) {
    console.error('[Warmer] Cycle error:', e.message);
  }
}

function start() {
  console.log('[Warmer] Starting — interval=4min, batch=5, active_window=30min');

  // Первый прогрев через 10 секунд после старта (даём время подключиться к БД и Redis)
  setTimeout(() => {
    runWarmCycle();
    setInterval(runWarmCycle, WARM_INTERVAL_MS);
  }, 10_000);
}

module.exports = { start, runWarmCycle, warmUser };
