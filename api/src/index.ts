import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { v4 as uuidv4 } from 'uuid';
import { typeDefs } from './schema.js';
import { resolvers } from './resolvers.js';
import { authMiddleware, type AuthContext } from './auth.js';
import { pool, runMigrations } from './db.js';
import { logger } from './logger.js';

const PORT = parseInt(process.env.PORT || '4000', 10);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';
const startTime = Date.now();

interface GraphQLContext {
  auth: AuthContext;
  requestId: string;
  adminSecret?: string;
}

async function start(): Promise<void> {
  // Run database migrations
  try {
    await runMigrations();
  } catch (err) {
    logger.error({ message: 'Failed to run migrations', error: String(err) });
    // Continue anyway - migrations may already be applied
  }

  const app = express();

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({
    origin: FRONTEND_ORIGIN,
    exposedHeaders: ['X-Auth-Token'],
  }));

  // Rate limiting for API
  const apiLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, // 10 minutes
    max: 3,
    message: { error: 'Too many submissions, please try again later' },
    keyGenerator: (req) => req.ip || 'unknown',
    skip: (req) => !req.body?.query?.includes('submitCode'),
  });

  app.use('/graphql', apiLimiter);

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: Math.floor((Date.now() - startTime) / 1000) });
  });

  const server = new ApolloServer<GraphQLContext>({
    typeDefs,
    resolvers,
  });

  await server.start();

  app.use(
    '/graphql',
    express.json({ limit: '1mb' }),
    expressMiddleware(server, {
      context: async ({ req, res }): Promise<GraphQLContext> => {
        const requestId = uuidv4();
        const auth = authMiddleware(req, res);
        const adminSecret = req.headers['x-admin-secret'] as string | undefined;

        return { auth, requestId, adminSecret };
      },
    })
  );

  const httpServer = app.listen(PORT, () => {
    logger.info({ message: `API server listening on port ${PORT}` });
    logger.info({ message: `GraphQL endpoint: http://localhost:${PORT}/graphql` });
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info({ message: 'Shutting down gracefully...' });
    httpServer.close();
    await server.stop();
    await pool.end();
    logger.info({ message: 'Server closed' });
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((err) => {
  logger.error({ message: 'Failed to start server', error: String(err) });
  process.exit(1);
});
