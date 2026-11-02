import { Settings } from 'luxon';
import { describe, expect, it } from 'vitest';
import { eventTimestamp, latestResultTime, resultTimezone } from './result.js';

describe('consumer result time interpretation', () => {
  it('keeps explicit offsets and applies a declared zone only to local clocks', () => {
    expect(eventTimestamp('2026-07-01T12:00:00+08:00', 'Europe/Zurich')).toBe('2026-07-01T04:00:00Z');
    expect(eventTimestamp('2026-07-01 12:00:00', 'Europe/Zurich')).toBe('2026-07-01T10:00:00Z');
    expect(eventTimestamp('2026-02-30T12:00:00')).toBeNull();
  });
  it('stores a wall time the clocks repeat at the same instant in every season', () => {
    const now = Settings.now;
    try {
      for (const season of [Date.UTC(2026, 0, 15), Date.UTC(2026, 6, 15)]) {
        Settings.now = () => season;
        expect(eventTimestamp('2025-10-26T02:30:00', 'Europe/Paris')).toBe('2025-10-26T00:30:00Z');
        expect(eventTimestamp('26.10.2025 02:30', 'Europe/Zurich')).toBe('2025-10-26T00:30:00Z');
      }
    } finally {
      Settings.now = now;
    }
  });
  it('falls back from invalid zones to the carrier catalog and unknown carriers to UTC', () => {
    expect(resultTimezone('swiss-post', { timezone: 'Invalid/Zone' })).toBe('Europe/Zurich');
    expect(resultTimezone('not-a-carrier', {})).toBe('UTC');
    expect(resultTimezone('swiss-post', { timezone: 'Asia/Shanghai' })).toBe('Asia/Shanghai');
  });
  it('compares summaries and scans under the same policy without inventing missing times', () => {
    expect(latestResultTime({ timezone: 'Asia/Shanghai', last_update: '2026-07-01 12:00:00',
      events: [{ time: '2026-07-01T05:00:00Z' }, { local_time: '2026-07-01T13:00:00' }] }, 'swiss-post'))
      .toBe(Date.parse('2026-07-01T05:00:00Z'));
    expect(latestResultTime({ events: [{ provider_time_text: 'invalid clock' }] }, 'swiss-post')).toBe(0);
  });
});
