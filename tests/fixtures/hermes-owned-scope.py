"""Filesystem-free, deterministic owned-boundary regressions."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'experimental/hermes'))
from owned_scope import Denied, OwnedScope, snapshot

if not __debug__:
    raise RuntimeError('assertions required')


class ScopeTests(unittest.TestCase):
    def test_serialization_uses_detached_validated_data(self):
        invoked = []
        class Unsafe(dict):
            def items(self):
                invoked.append(True)
                return super().items()
        args = {'nested': {'content': 'approved'}}
        def trace(frame, event, arg):
            if frame.f_code is json.dumps.__code__ and event == 'call':
                args['nested'] = Unsafe(content='changed')
            return trace
        sys.settrace(trace)
        try:
            encoded = snapshot(args)
        finally:
            sys.settrace(None)
        self.assertEqual(invoked, [])
        self.assertEqual(json.loads(encoded), {'nested': {'content': 'approved'}})

    def test_close_during_final_validation_denies_consumption(self):
        scope, identity = OwnedScope(), ('session', 'close')
        owner = scope.dispatch(identity)
        owner.__enter__()
        scope.approve(identity, {'content': 'yes'}, lambda args: True)
        def trace(frame, event, arg):
            if frame.f_code is snapshot.__code__ and event == 'return':
                owner.__exit__(None, None, None)
            return trace
        sys.settrace(trace)
        try:
            with self.assertRaises(Denied):
                scope.consume(identity, {'content': 'yes'})
        finally:
            sys.settrace(None)
            owner.__exit__(None, None, None)

    def test_positive_consumption_detachment_and_replay(self):
        scope, identity = OwnedScope(), ('session', 'positive')
        args = {'nested': [{'content': 'yes'}]}
        with scope.dispatch(identity):
            def approve(view):
                view['nested'][0]['content'] = 'approver mutation'
                return True
            scope.approve(identity, args, approve)
            result = scope.consume(identity, args)
            args['nested'][0]['content'] = 'caller mutation'
            self.assertEqual(result, {'nested': [{'content': 'yes'}]})
            with self.assertRaises(Denied):
                scope.consume(identity, {'nested': [{'content': 'yes'}]})

    def test_decline_and_unavailable_approvers(self):
        for n, approver in enumerate([lambda args: False, lambda args: 1, None]):
            scope, identity = OwnedScope(), ('session', str(n))
            with scope.dispatch(identity):
                with self.assertRaises((Denied, TypeError)):
                    scope.approve(identity, {}, approver)
                with self.assertRaises(Denied):
                    scope.consume(identity, {})
        scope, identity = OwnedScope(), ('session', 'throw')
        with scope.dispatch(identity):
            def fail(args):
                raise RuntimeError('approver failure')
            with self.assertRaises(RuntimeError):
                scope.approve(identity, {}, fail)
            with self.assertRaises(Denied):
                scope.consume(identity, {})

    def test_close_revokes_unused_permit_and_late_assent(self):
        scope, identity = OwnedScope(), ('session', 'unused')
        with scope.dispatch(identity):
            scope.approve(identity, {}, lambda args: True)
        self.assertEqual(scope._permits, {})
        with self.assertRaises(Denied):
            scope.consume(identity, {})
        late = ('session', 'late')
        owner = scope.dispatch(late)
        owner.__enter__()
        def close(args):
            owner.__exit__(None, None, None)
            return True
        with self.assertRaises(Denied):
            scope.approve(late, {}, close)
        self.assertEqual(scope._permits, {})

    def test_same_call_different_sessions_do_not_share_permits(self):
        scope = OwnedScope()
        first, second = ('first', 'call'), ('second', 'call')
        with scope.dispatch(first), scope.dispatch(second):
            scope.approve(first, {'content': 'one'}, lambda args: True)
            with self.assertRaises(Denied):
                scope.consume(second, {'content': 'one'})
            self.assertEqual(scope.consume(first, {'content': 'one'}), {'content': 'one'})


if __name__ == '__main__':
    unittest.main()
