import { Buffer } from 'node:buffer';
import { createTruncateFormatter } from '../truncate-formatter.js';

describe('createTruncateFormatter', () => {
  it('truncates long strings', () => {
    const formatter = createTruncateFormatter({ maxStringLength: 10 });
    expect(formatter('x'.repeat(20))).toBe('[String truncated - 20 chars]');
  });

  it('truncates long arrays', () => {
    const formatter = createTruncateFormatter({ maxArrayLength: 3 });
    expect(formatter([1, 2, 3, 4])).toBe('[Array truncated - 4 items]');
  });

  it('truncates large object properties by JSON byte size', () => {
    const formatter = createTruncateFormatter({ maxPropertyBytes: 64 });
    const large = { blob: 'x'.repeat(200) };
    const formatted = formatter(large) as Record<string, unknown>;
    expect(formatted.blob).toMatch(/^\[Value truncated - /);
  });

  it('skips truncation when showFullData is true', () => {
    const value = { blob: 'x'.repeat(200) };
    const formatter = createTruncateFormatter({
      maxPropertyBytes: 64,
      showFullData: true,
    });
    expect(formatter(value)).toEqual(value);
  });

  it('supports showFullData as a callback', () => {
    let showFull = false;
    const value = { blob: 'x'.repeat(200) };
    const formatter = createTruncateFormatter({
      maxPropertyBytes: 64,
      showFullData: () => showFull,
    });

    const truncated = formatter(value) as Record<string, unknown>;
    expect(truncated.blob).toMatch(/^\[Value truncated - /);

    showFull = true;
    expect(formatter(value)).toEqual(value);
  });
});

describe('truncate byte length helper', () => {
  it('uses UTF-8 byte length for property limits', () => {
    const formatter = createTruncateFormatter({ maxPropertyBytes: 10 });
    const value = { text: 'é'.repeat(20) };
    const byteLength = Buffer.byteLength(JSON.stringify(value.text), 'utf8');
    expect(byteLength).toBeGreaterThan(10);
    expect((formatter(value) as Record<string, unknown>).text).toMatch(/^\[Value truncated - /);
  });
});
