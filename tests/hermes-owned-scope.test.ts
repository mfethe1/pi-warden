import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('owned scope rejects mutation, replay, and non-JSON input', () => {
  const module = fileURLToPath(new URL('../experimental/hermes', import.meta.url));
  const result = spawnSync('python3', ['-I', '-B', '-c', `
import sys
sys.path.insert(0, sys.argv[1])
from owned_scope import Denied, OwnedScope
s = OwnedScope()
with s.dispatch(('session', 'call')):
    s.approve(('session', 'call'), {'content': 'yes'}, lambda args: True)
    try:
        s.consume(('session', 'call'), {'content': 'no'})
        raise AssertionError('mutation accepted')
    except Denied:
        pass
    try:
        s.consume(('session', 'call'), {'content': 'yes'})
        raise AssertionError('consumed permit reopened')
    except Denied:
        pass
try:
    with s.dispatch(('session', 'call')):
        raise AssertionError('identity reopened')
except Denied:
    pass
with s.dispatch(('session', 'other')):
    try:
        s.approve(('session', 'other'), {'bad': object()}, lambda args: True)
        raise AssertionError('non-JSON accepted')
    except Denied:
        pass
print('PASS: owned scope regression')
`, module], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /PASS: owned scope regression/);
});
