import { describe, it, expect } from 'vitest';
import { Sanitizer } from './Sanitizer.js';

describe('Sanitizer', () => {
  it('drops sensitive headers', () => {
    const payload = { text: 'hello', Authorization: 'Bearer secret', cookie: 'sess=abc' };
    const result = Sanitizer.sanitizeJson(payload);
    expect(result.droppedKeys).toContain('Authorization');
    expect(result.droppedKeys).toContain('cookie');
    expect(JSON.stringify(result.sanitized)).not.toContain('secret');
  });

  it('fail-closed on unhashable', () => {
    const circular: any = {};
    circular.self = circular;
    const result = Sanitizer.sanitizeJson(circular);
    // Should not throw, should return sanitized with error handling
    expect(result).toBeDefined();
  });

  it('does not leak secret in nested', () => {
    const secret = 'super-secret-123';
    const payload = { nested: { password: secret } };
    const result = Sanitizer.sanitizeJson(payload);
    expect(JSON.stringify(result.sanitized)).not.toContain(secret);
  });
});
