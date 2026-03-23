import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { logger } from './logger.js';
import { ExecuteRequestSchema, TestCasesSchema } from './schemas.js';
import { executeSubmission } from './executor.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = parseInt(process.env.PORT || '3001', 10);
const startTime = Date.now();

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  endpoint: process.env.AWS_ENDPOINT,
  forcePathStyle: true,
});

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

    // Download test cases from S3
    let testCasesRaw: string;
    try {
      const s3Response = await s3.send(
        new GetObjectCommand({
          Bucket: S3_BUCKET,
          Key: request.testCasesS3Key,
        })
      );
      testCasesRaw = await s3Response.Body!.transformToString('utf-8');
    } catch (err) {
      log.error({ message: 'Failed to fetch test cases from S3', error: String(err) });
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
