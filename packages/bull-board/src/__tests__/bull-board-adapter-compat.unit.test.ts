import {
  bullBoardAdapterCapabilities,
  queueSupportsGlobalRateLimit,
  readActiveRateLimitTtl,
} from '../bull-board-adapter-compat.js';

describe('bullBoardAdapterCapabilities', () => {
  it('reports installed Bull Board adapter capabilities', () => {
    expect(bullBoardAdapterCapabilities).toMatchObject({
      activeRateLimitTtl: expect.any(Boolean),
      configuredRateLimit: expect.any(Boolean),
      setConfiguredRateLimit: expect.any(Boolean),
      removeConfiguredRateLimit: expect.any(Boolean),
      releaseActiveRateLimit: expect.any(Boolean),
      supportsGlobalRateLimitGetter: expect.any(Boolean),
    });
  });
});

describe('readActiveRateLimitTtl', () => {
  it('returns zero when the queue has no rate-limit API', async () => {
    await expect(readActiveRateLimitTtl({ name: 'test' } as any)).resolves.toBe(0);
  });
});

describe('queueSupportsGlobalRateLimit', () => {
  it('detects BullMQ global rate-limit support on the queue', () => {
    expect(queueSupportsGlobalRateLimit({ name: 'test' } as any)).toBe(false);
    expect(queueSupportsGlobalRateLimit({
      name: 'test',
      setGlobalRateLimit: async () => {},
    } as any)).toBe(true);
  });
});
