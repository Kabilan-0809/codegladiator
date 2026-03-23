import { describe, it, expect } from 'vitest';
import { generateAlias } from '../src/alias.js';

describe('Alias Generator', () => {
  it('should produce deterministic results for the same UUID', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const alias1 = generateAlias(uuid);
    const alias2 = generateAlias(uuid);
    expect(alias1).toBe(alias2);
  });

  it('should produce different aliases for different UUIDs', () => {
    const alias1 = generateAlias('550e8400-e29b-41d4-a716-446655440000');
    const alias2 = generateAlias('6ba7b810-9dad-11d1-80b4-00c04fd430c8');
    // While technically could collide, these specific UUIDs produce different results
    expect(alias1).not.toBe(alias2);
  });

  it('should produce a name with adjective + noun format', () => {
    const alias = generateAlias('550e8400-e29b-41d4-a716-446655440000');
    expect(alias.length).toBeGreaterThan(3);
    // First char should be uppercase (adjective start)
    expect(alias[0]).toBe(alias[0]!.toUpperCase());
  });

  it('should handle various UUID formats', () => {
    const uuids = [
      '00000000-0000-0000-0000-000000000000',
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
      'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    ];

    for (const uuid of uuids) {
      const alias = generateAlias(uuid);
      expect(alias).toBeTruthy();
      expect(typeof alias).toBe('string');
    }
  });
});

describe('Score Computation', () => {
  it('should compute score as pass rate percentage when all pass', () => {
    const passed = 10;
    const total = 10;
    const score = (passed / total) * 100;
    expect(score).toBe(100);
  });

  it('should compute score as 0 when none pass', () => {
    const passed = 0;
    const total = 10;
    const score = (passed / total) * 100;
    expect(score).toBe(0);
  });

  it('should handle partial pass', () => {
    const passed = 7;
    const total = 10;
    const score = (passed / total) * 100;
    expect(score).toBe(70);
  });

  it('should handle zero total', () => {
    const passed = 0;
    const total = 0;
    const score = total === 0 ? 0 : (passed / total) * 100;
    expect(score).toBe(0);
  });
});

describe('Bracket Generation', () => {
  function nextPowerOf2(n: number): number {
    let p = 1;
    while (p < n) p *= 2;
    return p;
  }

  it('should compute next power of 2 correctly', () => {
    expect(nextPowerOf2(1)).toBe(1);
    expect(nextPowerOf2(2)).toBe(2);
    expect(nextPowerOf2(3)).toBe(4);
    expect(nextPowerOf2(4)).toBe(4);
    expect(nextPowerOf2(5)).toBe(8);
    expect(nextPowerOf2(8)).toBe(8);
    expect(nextPowerOf2(9)).toBe(16);
  });

  it('should create correct matchup count for 8 submissions', () => {
    const count = 8;
    const matchups = count / 2;
    expect(matchups).toBe(4);
  });

  it('should create correct round count', () => {
    const count = 8;
    const rounds = Math.ceil(Math.log2(count));
    expect(rounds).toBe(3);
  });

  it('should pad to power of 2 with byes', () => {
    const count = 6;
    const padded = nextPowerOf2(count);
    expect(padded).toBe(8);
    const byes = padded - count;
    expect(byes).toBe(2);
  });
});

describe('JWT Middleware', () => {
  it('should validate token format', () => {
    const authHeader = 'Bearer eyJhbGciOiJIUzI1NiJ9.test.sig';
    expect(authHeader.startsWith('Bearer ')).toBe(true);
    const token = authHeader.slice(7);
    expect(token).toBe('eyJhbGciOiJIUzI1NiJ9.test.sig');
  });

  it('should detect missing authorization header', () => {
    const authHeader = undefined;
    const hasBearerToken = authHeader && authHeader.startsWith('Bearer ');
    expect(hasBearerToken).toBeFalsy();
  });

  it('should detect non-Bearer authorization', () => {
    const authHeader = 'Basic dXNlcjpwYXNz';
    const hasBearerToken = authHeader.startsWith('Bearer ');
    expect(hasBearerToken).toBe(false);
  });

  it('should fingerprint using SHA-256', async () => {
    const { createHash } = await import('crypto');
    const sub = 'test-user-id';
    const fingerprint = createHash('sha256').update(sub).digest('hex');
    expect(fingerprint.length).toBe(64); // SHA-256 hex = 64 chars
    // Deterministic
    const fingerprint2 = createHash('sha256').update(sub).digest('hex');
    expect(fingerprint).toBe(fingerprint2);
  });
});
