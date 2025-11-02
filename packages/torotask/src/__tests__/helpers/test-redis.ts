import { Redis } from 'ioredis';
import { RedisMemoryServer } from 'redis-memory-server';

export class TestRedisServer {
  private server: RedisMemoryServer | null = null;
  private redis: Redis | null = null;

  async start(): Promise<void> {
    this.server = new RedisMemoryServer({
      instance: {
        port: 0, // Random available port
      },
    });

    await this.server.start();
  }

  async stop(): Promise<void> {
    if (this.redis) {
      this.redis.disconnect();
      this.redis = null;
    }

    if (this.server) {
      await this.server.stop();
      this.server = null;
    }
  }

  async getRedisUrl(): Promise<string> {
    if (!this.server) {
      throw new Error('Redis server not started');
    }

    const host = await this.server.getHost();
    const port = await this.server.getPort();

    if (!host || !port) {
      throw new Error(`Redis server not properly initialized - host: ${host}, port: ${port}`);
    }

    return `redis://${host}:${port}`;
  }

  async getRedisClient(): Promise<Redis> {
    if (!this.redis) {
      const redisUrl = await this.getRedisUrl();
      this.redis = new Redis(redisUrl);
    }
    return this.redis;
  }

  async flushAll(): Promise<void> {
    const client = await this.getRedisClient();
    await client.flushall();
  }
}
