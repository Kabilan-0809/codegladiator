import { Redis } from 'ioredis';
import { logger } from './logger.js';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

export const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
});

redis.on('error', (err) => {
  logger.error({ message: 'Redis connection error', error: err.message });
});

redis.on('connect', () => {
  logger.info({ message: 'Connected to Redis' });
});
