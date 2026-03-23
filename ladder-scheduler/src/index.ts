import { bracketInit, roundAdvance } from './bracket.js';
import { closeRedis } from './events.js';
import { pool } from './db.js';
import { logger } from './logger.js';

const BRACKET_INIT_INTERVAL = 5 * 60 * 1000; // 5 minutes
const ROUND_ADVANCE_INTERVAL = 60 * 1000; // 1 minute

let running = true;

async function runLoop(): Promise<void> {
  logger.info({ message: 'Ladder scheduler started (local dev polling mode)' });

  let bracketInitLastRun = 0;
  let roundAdvanceLastRun = 0;

  while (running) {
    const now = Date.now();

    try {
      if (now - bracketInitLastRun >= BRACKET_INIT_INTERVAL) {
        await bracketInit();
        bracketInitLastRun = now;
      }

      if (now - roundAdvanceLastRun >= ROUND_ADVANCE_INTERVAL) {
        await roundAdvance();
        roundAdvanceLastRun = now;
      }
    } catch (err) {
      logger.error({ message: 'Scheduler loop error', error: String(err) });
    }

    // Sleep for 10 seconds between checks
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

// Lambda handler (for production)
export const handler = async (event: { trigger: string }): Promise<{ statusCode: number }> => {
  try {
    if (event.trigger === 'BRACKET_INIT') {
      await bracketInit();
    } else if (event.trigger === 'ROUND_ADVANCE') {
      await roundAdvance();
    }
    return { statusCode: 200 };
  } catch (err) {
    logger.error({ message: 'Lambda handler error', error: String(err) });
    return { statusCode: 500 };
  }
};

// Graceful shutdown
const shutdown = async () => {
  logger.info({ message: 'Shutting down...' });
  running = false;
  await closeRedis();
  await pool.end();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start in local dev mode
runLoop().catch((err) => {
  logger.error({ message: 'Fatal error', error: String(err) });
  process.exit(1);
});
