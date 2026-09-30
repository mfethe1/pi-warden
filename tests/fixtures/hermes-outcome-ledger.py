"""Canonical owned permit/ledger acceptance; writes only in disposable roots."""
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'experimental/hermes'))
from owned_scope import Denied, OwnedScope
from outcome_ledger import OutcomeLedger


def run_effect(ledger, call, operation, target, fail=False):
    scope = OwnedScope()
    identity = ('test-session', call)
    args = {'path': str(target), 'content': 'APPROVED\n'}
    def effect(approved):
        with Path(approved['path']).open('a') as output:
            output.write(approved['content'])
            output.flush()
            os.fsync(output.fileno())
        if fail:
            raise RuntimeError('after effect')
        return 'written'
    with scope.dispatch(identity):
        scope.approve(identity, args, lambda approved: True)
        return ledger.execute(scope, identity, operation, args, effect)


class Acceptance(unittest.TestCase):
    def test_completion_and_fresh_call_repeat_denied(self):
        with tempfile.TemporaryDirectory(prefix='warden-outcome-') as home:
            root = Path(home)
            op = ('hermes', 'resource', 'owner-operation')
            ledger = OutcomeLedger(root / 'outcomes.db')
            self.assertEqual(run_effect(ledger, 'one', op, root / 'effect'), 'written')
            self.assertEqual(ledger.state(op), 'completed')
            with self.assertRaises(Denied):
                run_effect(OutcomeLedger(ledger.path), 'two', op, root / 'effect')
            self.assertEqual((root / 'effect').read_text(), 'APPROVED\n')

    def test_post_effect_error_retains_unknown(self):
        with tempfile.TemporaryDirectory(prefix='warden-outcome-') as home:
            root = Path(home)
            op = ('hermes', 'resource', 'unknown')
            ledger = OutcomeLedger(root / 'outcomes.db')
            with self.assertRaisesRegex(RuntimeError, 'after effect'):
                run_effect(ledger, 'one', op, root / 'effect', fail=True)
            self.assertEqual(ledger.state(op), 'outcome-unknown')
            with self.assertRaises(Denied):
                run_effect(OutcomeLedger(ledger.path), 'two', op, root / 'effect')
            self.assertEqual((root / 'effect').read_text(), 'APPROVED\n')

    def test_unapproved_input_never_reserves(self):
        with tempfile.TemporaryDirectory(prefix='warden-outcome-') as home:
            ledger = OutcomeLedger(Path(home) / 'outcomes.db')
            scope, identity, op = OwnedScope(), ('s', 'c'), ('h', 'r', 'o')
            with scope.dispatch(identity):
                scope.approve(identity, {'content': 'yes'}, lambda approved: True)
                with self.assertRaises(Denied):
                    ledger.execute(scope, identity, op, {'content': 'no'}, lambda approved: self.fail('effect'))
            self.assertIsNone(ledger.state(op))

    def test_storage_failure_never_invokes_effect(self):
        with tempfile.TemporaryDirectory(prefix='warden-outcome-') as home:
            root = Path(home)
            ledger = OutcomeLedger(root / 'outcomes.db')
            ledger.path = root / 'missing-directory' / 'outcomes.db'
            with self.assertRaises(sqlite3.OperationalError):
                run_effect(ledger, 'one', ('h', 'r', 'o'), root / 'effect')
            self.assertFalse((root / 'effect').exists())

    def test_missing_operation_never_invokes_effect(self):
        with tempfile.TemporaryDirectory(prefix='warden-outcome-') as home:
            root = Path(home)
            ledger = OutcomeLedger(root / 'outcomes.db')
            with self.assertRaises(Denied):
                run_effect(ledger, 'one', None, root / 'effect')
            self.assertFalse((root / 'effect').exists())

    def test_process_exit_after_effect_retains_hold(self):
        with tempfile.TemporaryDirectory(prefix='warden-outcome-') as home:
            root = Path(home)
            result = subprocess.run([sys.executable, '-I', '-B', __file__, '--crash', home],
                                    capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 24, result.stderr)
            ledger = OutcomeLedger(root / 'outcomes.db')
            op = ('hermes', 'resource', 'crash')
            self.assertEqual(ledger.state(op), 'outcome-unknown')
            with self.assertRaises(Denied):
                run_effect(ledger, 'retry', op, root / 'effect')
            self.assertEqual((root / 'effect').read_text(), 'APPROVED\n')


if __name__ == '__main__':
    if not __debug__:
        raise RuntimeError('assertions required')
    if '--crash' in sys.argv:
        root = Path(sys.argv[-1])
        ledger, scope = OutcomeLedger(root / 'outcomes.db'), OwnedScope()
        args, identity = {'content': 'APPROVED\n'}, ('s', 'c')
        def crash(approved):
            with (root / 'effect').open('w') as output:
                output.write(approved['content'])
                output.flush()
                os.fsync(output.fileno())
            os._exit(24)
        with scope.dispatch(identity):
            scope.approve(identity, args, lambda approved: True)
            ledger.execute(scope, identity, ('hermes', 'resource', 'crash'), args, crash)
    else:
        unittest.main()
