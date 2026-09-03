import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../bridge/logger.mjs';

const at = () => new Date(2026, 8, 3, 14, 5, 6, 789);

test('formats all operational levels in the shared log style', () => {
  const lines = [];
  const log = createLogger({ level: 'debug', colour: 'never', now: at, write: (line) => lines.push(line) });

  log.debug('job', 'dispatch');
  log.info('bridge', 'listening');
  log.warn('models', 'refresh failed');
  log.error('http', 'request failed');

  assert.deepEqual(lines, [
    '2026-09-03 14:05:06.789 DEBUG job                dispatch',
    '2026-09-03 14:05:06.789  INFO bridge             listening',
    '2026-09-03 14:05:06.789  WARN models             refresh failed',
    '2026-09-03 14:05:06.789 ERROR http               request failed',
  ]);
});

test('filters levels and can use ANSI colour', () => {
  const lines = [];
  const log = createLogger({ level: 'info', colour: 'always', now: at, write: (line) => lines.push(line) });

  log.debug('job', 'hidden');
  log.info('bridge', 'visible');

  assert.equal(lines.length, 1);
  assert.match(lines[0], /\x1b\[32m INFO\x1b\[0m/);
  assert.match(lines[0], /bridge/);
});
