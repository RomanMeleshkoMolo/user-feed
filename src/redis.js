const Redis = require('ioredis');

const client = new Redis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: 1,
  // При недоступности Redis — не падаем, просто логируем
  retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
});

client.on('connect', () => console.log('[Redis] Connected'));
client.on('error', (err) => console.error('[Redis] Error:', err.message));

module.exports = client;
