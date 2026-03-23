import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { URL } from 'url';
import jwt from 'jsonwebtoken';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { logger } from './logger.js';

const PORT = parseInt(process.env.PORT || '4001', 10);
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-32-chars-min';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const startTime = Date.now();

interface JWTPayload {
  sub: string;
  alias: string;
}

interface ClientInfo {
  ws: WebSocket;
  challengeId: string;
  sessionId: string;
  alias: string;
}

// Room management
const rooms = new Map<string, Set<ClientInfo>>();

// Redis connections
const redisSub = new Redis(REDIS_URL);
const redisClient = new Redis(REDIS_URL);

redisSub.on('error', (err) => logger.error({ message: 'Redis sub error', error: err.message }));
redisClient.on('error', (err) => logger.error({ message: 'Redis client error', error: err.message }));

// HTTP server for health check
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: Math.floor((Date.now() - startTime) / 1000) }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

const wss = new WebSocketServer({ server: httpServer });

function verifyToken(token: string): JWTPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as JWTPayload;
  } catch {
    return null;
  }
}

function broadcastToRoom(challengeId: string, message: string): void {
  const room = rooms.get(challengeId);
  if (!room) return;

  for (const client of room) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(message);
    }
  }
}

async function getViewerCount(challengeId: string): Promise<number> {
  try {
    return await redisClient.scard(`challenge:${challengeId}:viewers`);
  } catch {
    return rooms.get(challengeId)?.size || 0;
  }
}

// WebSocket connection handler
wss.on('connection', async (ws, req) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const token = url.searchParams.get('token');
  const challengeId = url.searchParams.get('challengeId');

  if (!token || !challengeId) {
    ws.close(4001, 'Missing token or challengeId');
    return;
  }

  const payload = verifyToken(token);
  if (!payload) {
    ws.close(4002, 'Invalid token');
    return;
  }

  const sessionId = uuidv4();
  const clientInfo: ClientInfo = {
    ws,
    challengeId,
    sessionId,
    alias: payload.alias,
  };

  // Add to room
  if (!rooms.has(challengeId)) {
    rooms.set(challengeId, new Set());
  }
  rooms.get(challengeId)!.add(clientInfo);

  // Track in Redis
  try {
    await redisClient.sadd(`challenge:${challengeId}:viewers`, sessionId);
    await redisClient.expire(`challenge:${challengeId}:viewers`, 3600);
  } catch (err) {
    logger.error({ message: 'Redis viewer tracking error', error: String(err) });
  }

  // Send initial state
  const viewerCount = await getViewerCount(challengeId);
  ws.send(JSON.stringify({
    type: 'CONNECTED',
    viewerCount,
    gladiatorAlias: payload.alias,
    timestamp: new Date().toISOString(),
  }));

  logger.info({ message: 'Client connected', alias: payload.alias, challengeId, sessionId });

  // Handle disconnect
  ws.on('close', async () => {
    const room = rooms.get(challengeId);
    if (room) {
      room.delete(clientInfo);
      if (room.size === 0) {
        rooms.delete(challengeId);
      }
    }

    try {
      await redisClient.srem(`challenge:${challengeId}:viewers`, sessionId);
    } catch {
      // ignore
    }

    const newCount = await getViewerCount(challengeId);
    broadcastToRoom(challengeId, JSON.stringify({
      type: 'VIEWER_COUNT',
      count: newCount,
      timestamp: new Date().toISOString(),
    }));

    logger.info({ message: 'Client disconnected', alias: payload.alias, challengeId });
  });

  ws.on('error', (err) => {
    logger.error({ message: 'WebSocket error', error: err.message, sessionId });
  });
});

// Redis pub/sub subscriber
redisSub.psubscribe('challenge:*:events', (err) => {
  if (err) {
    logger.error({ message: 'Failed to subscribe to Redis events', error: err.message });
  } else {
    logger.info({ message: 'Subscribed to challenge:*:events' });
  }
});

redisSub.on('pmessage', (_pattern, channel, message) => {
  // Parse challengeId from channel: challenge:{challengeId}:events
  const parts = channel.split(':');
  const challengeId = parts[1];

  if (!challengeId) return;

  try {
    const event = JSON.parse(message) as Record<string, unknown>;
    // Add/update timestamp
    event.timestamp = new Date().toISOString();
    const enrichedMessage = JSON.stringify(event);

    broadcastToRoom(challengeId, enrichedMessage);
    logger.debug({ message: 'Broadcasted event', type: event.type, challengeId });
  } catch (err) {
    logger.error({ message: 'Failed to parse Redis message', error: String(err) });
  }
});

// Start server
httpServer.listen(PORT, () => {
  logger.info({ message: `WebSocket server listening on port ${PORT}` });
});

// Graceful shutdown
const shutdown = async () => {
  logger.info({ message: 'Shutting down...' });

  wss.close();
  httpServer.close();
  await redisSub.quit();
  await redisClient.quit();

  logger.info({ message: 'Server closed' });
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
