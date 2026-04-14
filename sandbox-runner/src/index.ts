import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { createClient } from '@supabase/supabase-js';
import { logger } from './logger.js';
import { ExecuteRequestSchema, TestCasesSchema } from './schemas.js';
import { executeSubmission } from './executor.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = parseInt(process.env.PORT || '3001', 10);
const startTime = Date.now();

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

const S3_BUCKET = process.env.S3_BUCKET || 'codegladiator-submissions';

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: Math.floor((Date.now() - startTime) / 1000) });
});

// Execute endpoint
app.post('/execute', async (req, res) => {
  const requestId = uuidv4();
  const log = logger.child({ requestId });

  try {
    // Validate input
    const parsed = ExecuteRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      log.warn({ message: 'Invalid request', errors: parsed.error.flatten() });
      res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten(), requestId });
      return;
    }

    const request = parsed.data;
    log.info({ message: 'Execute request received', submissionId: request.submissionId, language: request.language });

    // Download test cases from Supabase Storage
    let testCasesRaw: string;
    try {
      const { data, error } = await supabase.storage
        .from(S3_BUCKET)
        .download(request.testCasesS3Key);

      if (error) throw error;
      testCasesRaw = await data.text();
    } catch (err) {
      log.error({ message: 'Failed to fetch test cases from Supabase Storage', error: String(err) });
      res.status(500).json({ error: 'Failed to fetch test cases', requestId });
      return;
    }

    // Parse test cases
    let testCases;
    try {
      testCases = TestCasesSchema.parse(JSON.parse(testCasesRaw));
    } catch (err) {
      log.error({ message: 'Invalid test cases format', error: String(err) });
      res.status(500).json({ error: 'Invalid test cases format', requestId });
      return;
    }

    // Execute
    const result = await executeSubmission(request, testCases);
    res.json({ ...result, requestId });
  } catch (err) {
    log.error({ message: 'Unhandled execution error', error: String(err) });
    res.status(500).json({ error: 'Internal server error', requestId });
  }
});

// Graceful shutdown
const server = app.listen(PORT, () => {
  logger.info({ message: `Sandbox runner listening on port ${PORT}` });
});

const shutdown = () => {
  logger.info({ message: 'Shutting down gracefully...' });
  server.close(() => {
    logger.info({ message: 'Server closed' });
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
