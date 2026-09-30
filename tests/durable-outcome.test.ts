import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// Separate-process fixture only: no host authorization or power-loss claim.
test('durable unknown outcomes block crash retries and overlapping processes', () => {
  const fixture = fileURLToPath(new URL('./fixtures/durable-outcome.py', import.meta.url));
  const result = spawnSync('python3', ['-I', fixture], {
    encoding: 'utf8',
    timeout: 45_000,
    env: { ...process.env, PYTHONOPTIMIZE: '2' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.match(/^PASS:/gm)?.length, 3, result.stdout);
});

test('stalled durable worker is reaped before the outer runner timeout', () => {
  const fixture = fileURLToPath(new URL('./fixtures/durable-outcome.py', import.meta.url));
  const result = spawnSync('python3', ['-I', fixture, '--stalled-handshake'], {
    encoding: 'utf8',
    timeout: 35_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /CLEANED: stalled worker reaped and temporary root removed/);
});
