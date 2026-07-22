import { describe, expect, it } from 'vitest';
import { certifyClaudeSessionResetAt } from '../../packages/shared/src/llm/errors.js';

describe('Claude session reset certification', () => {
  it.each([
    {
      hint: '7pm (Africa/Cairo)',
      observedAt: '2026-07-19T10:00:02.000Z',
      expected: '2026-07-19T16:00:00.000Z',
    },
    {
      hint: 'tomorrow 8pm (Africa/Cairo)',
      observedAt: '2026-07-19T10:00:02.000Z',
      expected: '2026-07-20T17:00:00.000Z',
    },
  ])('certifies the complete provider hint $hint against its durable observation', ({
    hint,
    observedAt,
    expected,
  }) => {
    expect(certifyClaudeSessionResetAt(hint, observedAt)).toBe(expected);
  });

  it('keeps an observed overnight hint informational without an explicit day', () => {
    expect(certifyClaudeSessionResetAt(
      '4:30am (Africa/Cairo)',
      '2026-07-12T20:41:10.938Z',
    )).toBeNull();
  });

  it('does not roll a reset minute that just passed into the next day', () => {
    expect(certifyClaudeSessionResetAt(
      '7pm (Africa/Cairo)',
      '2026-07-19T16:00:30.000Z',
    )).toBeNull();
  });

  it('does not reinterpret an older unqualified reset time as tomorrow', () => {
    expect(certifyClaudeSessionResetAt(
      '7pm (Africa/Cairo)',
      '2026-07-19T16:06:00.000Z',
    )).toBeNull();
  });

  it.each([
    '6:40pm',
    '6:40pm (Afr',
    '6:40pm (Africa/Cairo)”',
    '2:40am (Africa/Cairo)**',
    'tomorrow evening (Africa/Cairo)',
    '7pm (Not/A_Time_Zone)',
    '7pm\n(Africa/Cairo)',
    'tomorrow\t8pm (Africa/Cairo)',
    '7PM (Africa/Cairo)',
    '7pm  (Africa/Cairo)',
    '7pm (africa/cairo)',
  ])('keeps incomplete or decorated evidence informational: %s', (hint) => {
    expect(certifyClaudeSessionResetAt(hint, '2026-07-19T10:00:02.000Z')).toBeNull();
  });

  it('rejects DST gaps and overlaps instead of guessing an instant', () => {
    expect(certifyClaudeSessionResetAt(
      '2:30am (America/New_York)',
      '2026-03-08T05:00:00.000Z',
    )).toBeNull();
    expect(certifyClaudeSessionResetAt(
      '1:30am (America/New_York)',
      '2026-11-01T04:00:00.000Z',
    )).toBeNull();
  });

  it('rejects a non-timestamp observation', () => {
    expect(certifyClaudeSessionResetAt(
      '7pm (Africa/Cairo)',
      'not-a-timestamp',
    )).toBeNull();
  });
});
