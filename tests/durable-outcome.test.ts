import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function verifyStalledCleanup(fixture: string): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), 'warden-cleanup-observer-'));
  let pid: number | undefined;
  try {
    const result = spawnSync('python3', ['-I', fixture, '--stalled-handshake'], {
      encoding: 'utf8',
      timeout: 35_000,
      env: { ...process.env, TMPDIR: scratch },
    });
    const line = result.stdout?.split('\n').find((entry) => entry.startsWith('OBSERVED: '));
    assert.ok(line, 'fixture must expose its held worker before waiting');
    const observed: { pid: number; root: string } = JSON.parse(line.slice('OBSERVED: '.length));
    assert.equal(resolve(dirname(observed.root)), resolve(scratch));
    assert.ok(Number.isSafeInteger(observed.pid) && observed.pid > 0);
    pid = observed.pid;
    assert.ifError(result.error);
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stderr, '');
    assert.equal(isRunning(pid), false, 'held worker is still alive');
    assert.equal(existsSync(observed.root), false, 'fixture temporary root remains');
  } finally {
    // Also clean the deliberately broken fixture used by the mutation test.
    if (pid !== undefined && isRunning(pid)) {
      process.kill(pid, 'SIGKILL');
      for (let attempt = 0; attempt < 40 && isRunning(pid); attempt++) {
        await new Promise((done) => setTimeout(done, 50));
      }
      assert.equal(isRunning(pid), false, 'mutation worker cleanup failed');
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

test('stalled durable worker is reaped and its temporary root removed', async () => {
  await verifyStalledCleanup(fileURLToPath(new URL('./fixtures/durable-outcome.py', import.meta.url)));
});

test('cleanup observation rejects a fixture with worker cleanup removed', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'warden-cleanup-mutant-'));
  try {
    const fixture = fileURLToPath(new URL('./fixtures/durable-outcome.py', import.meta.url));
    const source = readFileSync(fixture, 'utf8');
    const cleanup = '            if first.poll() is None:\n                first.kill()\n            first.communicate(timeout=3)';
    assert.ok(source.includes(cleanup), 'cleanup mutation must apply');
    const mutant = join(scratch, 'durable-outcome.py');
    writeFileSync(mutant, source.replace(cleanup, '            pass'));
    await assert.rejects(verifyStalledCleanup(mutant), /held worker is still alive/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
