import Redis from 'ioredis';
import { logger } from './logger.js';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(REDIS_URL);
    redis.on('error', (err) => {
      logger.error({ message: 'Redis connection error', error: err.message });
    });
  }
  return redis;
}

export async function publishEvent(
  challengeId: string,
  type: string,
  data: Record<string, unknown>
): Promise<void> {
  const channel = `challenge:${challengeId}:events`;
  const event = JSON.stringify({
    type,
    challengeId,
    timestamp: new Date().toISOString(),
    ...data,
  });

  try {
    await getRedis().publish(channel, event);
    logger.info({ message: 'Event published', type, challengeId });
  } catch (err) {
    logger.error({ message: 'Failed to publish event', error: String(err) });
  }
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}
