import http from 'http';
import { bracketInit, roundAdvance } from './bracket.js';
import { closeRedis } from './events.js';
import { pool, query } from './db.js';
import { logger } from './logger.js';
import { redis } from './redis.js';
import { executeSubmission } from './matchProcessor.js';

const PORT = parseInt(process.env.PORT || '3002', 10);
const startTime = Date.now();
let running = true;

// ─── Execution Worker ─────────────────────────────────────────────────────────
// Reads submission jobs from Redis queue and runs them through the sandbox.
async function runExecutionWorker(): Promise<void> {
  logger.info({ message: 'Execution worker started' });
  const QUEUE_NAME = 'execution-queue';

  while (running) {
    try {
      const result = await redis.brpop(QUEUE_NAME, 5); // blocks up to 5s
      if (!result) continue;

      const [_queue, data] = result;
      const job = JSON.parse(data);

      logger.info({ message: 'Processing execution job', submissionId: job.submissionId });

      const execResult = await executeSubmission(
        job.submissionId,
        job.code,
        job.language,
        job.testCasesS3Key,
        job.challengeId
      );

      await query(
        `INSERT INTO execution_results
           (submission_id, runtime_ms, peak_memory_bytes, test_cases_passed, test_cases_total, exit_code, timed_out)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (submission_id) DO NOTHING`,
        [
          job.submissionId,
          execResult.runtimeMs,
          execResult.peakMemoryBytes,
          execResult.testCasesPassed,
          execResult.testCasesTotal,
          execResult.exitCode,
          execResult.timedOut,
        ]
      );

      logger.info({ message: 'Execution result saved', submissionId: job.submissionId });
    } catch (err) {
      if (running) {
        logger.error({ message: 'Execution worker error', error: String(err) });
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}

// ─── Scheduler Tick ───────────────────────────────────────────────────────────
// Called on startup and on every GET /tick — bracket init every 5 min,
// round advance every 1 min.
let bracketInitLastRun = 0;
let roundAdvanceLastRun = 0;

async function schedulerTick(): Promise<{ bracketInit: boolean; roundAdvance: boolean }> {
  const now = Date.now();
  let didBracketInit = false;
  let didRoundAdvance = false;

  if (now - bracketInitLastRun >= 5 * 60 * 1000) {
    await bracketInit();
    bracketInitLastRun = now;
    didBracketInit = true;
  }

  if (now - roundAdvanceLastRun >= 60 * 1000) {
    await roundAdvance();
    roundAdvanceLastRun = now;
    didRoundAdvance = true;
  }

  return { bracketInit: didBracketInit, roundAdvance: didRoundAdvance };
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────
// Render.com requires an HTTP server to keep the instance alive (free tier).
// UptimeRobot pings GET /tick every 5 minutes to drive the scheduler.
const server = http.createServer(async (req, res) => {
  const url = req.url ?? '/';

  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: Math.floor((Date.now() - startTime) / 1000) }));
    return;
  }

  if (url === '/tick' && req.method === 'GET') {
    try {
      const result = await schedulerTick();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (err) {
      logger.error({ message: 'Tick error', error: String(err) });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(err) }));
    }
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  logger.info({ message: `Ladder-scheduler HTTP server listening on port ${PORT}` });
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
const shutdown = async () => {
  logger.info({ message: 'Shutting down...' });
  running = false;
  server.close();
  await closeRedis();
  await redis.quit();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ─── Start ────────────────────────────────────────────────────────────────────
// Run initial tick immediately on startup, then spin the execution worker.
schedulerTick().catch((err) =>
  logger.error({ message: 'Initial tick error', error: String(err) })
);

runExecutionWorker().catch((err) => {
  logger.error({ message: 'Fatal error in execution worker', error: String(err) });
  process.exit(1);
});
