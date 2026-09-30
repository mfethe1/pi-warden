"""Isolated SQLite acceptance fixture, not a production authorization ledger."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile


def worker(root, operation, phase):
    with sqlite3.connect(root / 'outcomes.sqlite', timeout=5) as db:
        db.execute('CREATE TABLE IF NOT EXISTS outcomes (operation TEXT PRIMARY KEY, state TEXT NOT NULL)')
        try:
            db.execute('INSERT INTO outcomes VALUES (?, ?)', (operation, 'outcome-unknown'))
            db.commit()
        except sqlite3.IntegrityError:
            db.rollback()
            print(json.dumps({'blocked': True}), flush=True)
            return
    if phase == 'held':
        print('reserved', flush=True)
        assert sys.stdin.readline() == 'release\n'
    if phase == 'before':
        os._exit(23)
    with (root / f'{operation}.txt').open('a') as output:
        output.write('APPROVED-EFFECT\n')
        output.flush()
        os.fsync(output.fileno())
    os._exit(24)


def command(root, operation, phase):
    return [sys.executable, __file__, str(root), operation, phase]


def blocked(root, operation):
    retry = subprocess.run(command(root, operation, 'after'), capture_output=True, text=True, timeout=10)
    assert retry.returncode == 0 and not retry.stderr, retry
    assert json.loads(retry.stdout) == {'blocked': True}, retry.stdout


def retained(root, operation):
    with sqlite3.connect(root / 'outcomes.sqlite') as db:
        assert db.execute('SELECT state FROM outcomes WHERE operation=?', (operation,)).fetchone() == ('outcome-unknown',)


def verify():
    with tempfile.TemporaryDirectory(prefix='warden-durable-', dir=os.environ.get('TMPDIR')) as home:
        root = Path(home)
        for phase, code in [('before', 23), ('after', 24)]:
            result = subprocess.run(command(root, phase, phase), capture_output=True, text=True, timeout=10)
            assert result.returncode == code and not result.stderr, result
            retained(root, phase)
            blocked(root, phase)
            target = root / f'{phase}.txt'
            assert target.read_text() == 'APPROVED-EFFECT\n' if phase == 'after' else not target.exists()
            print(f'PASS: {phase}-effect exit retained reservation and blocked fresh retry')
        # Hold the winner after its durable reservation: prove overlap before any effect.
        first = subprocess.Popen(command(root, 'race', 'held'), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            assert first.stdout is not None
            assert first.stdout.readline() == 'reserved\n'
            assert not (root / 'race.txt').exists()
            blocked(root, 'race')
            assert first.poll() is None and not (root / 'race.txt').exists()
            _, errors = first.communicate('release\n', timeout=10)
            assert first.returncode == 24 and not errors, errors
            retained(root, 'race')
            blocked(root, 'race')
            assert (root / 'race.txt').read_text() == 'APPROVED-EFFECT\n'
            print('PASS: held reservation blocked overlapping process and restart retry with one effect')
        finally:
            if first.poll() is None:
                first.kill()
            first.communicate(timeout=10)


if __name__ == '__main__':
    if len(sys.argv) == 4:
        worker(Path(sys.argv[1]), sys.argv[2], sys.argv[3])
    else:
        verify()
