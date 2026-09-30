"""Run with a Hermes checkout's interpreter and HERMES_HOME in scratch."""
import json
import os
import sys
import tempfile
from pathlib import Path
from contextvars import ContextVar
from threading import Event, Thread

if not __debug__:
    raise RuntimeError('assertions required')
if not os.environ.get('HERMES_HOME'):
    raise RuntimeError('isolated HERMES_HOME required')
sys.path.insert(0, str(Path(__file__).parent))
from owned_scope import Denied, OwnedScope
from outcome_ledger import OutcomeLedger

owner_operation = ContextVar[tuple[str, str, str] | None]('owner_operation', default=None)
from hermes_cli.plugins import get_plugin_manager
from model_tools import handle_function_call
from tools import approval_context
from tools.registry import registry

scope = OwnedScope()
manager = get_plugin_manager()
manager.discover_and_load()
assent = True


def identity():
    return (approval_context._approval_session_id.get(),
            approval_context._approval_tool_call_id.get())


def guard(**kwargs):
    try:
        scope.approve((kwargs.get('session_id'), kwargs.get('tool_call_id')),
                      kwargs['args'], lambda approved: assent)
    except Denied as error:
        return {'action': 'block', 'message': str(error)}


with tempfile.TemporaryDirectory(prefix='warden-owned-') as directory:
    root = Path(directory)
    ledger = OutcomeLedger(root / 'outcomes.db')
    def effect(approved):
        target = Path(approved['path'])
        if target.parent != root:
            raise Denied('outside scratch root')
        target.write_text(approved['content'])
        if approved['content'] == 'ERROR-AFTER-EFFECT':
            raise RuntimeError('fixture failure after effect')
        return json.dumps({'written': True})

    def execute(args, **kwargs):
        try:
            return ledger.execute(scope, identity(), owner_operation.get(), args, effect)
        except Denied as error:
            return json.dumps({'error': str(error)})

    registry.register(name='warden_owned_write', toolset='warden_probe',
                      schema={'name': 'warden_owned_write', 'parameters': {'type': 'object'}},
                      handler=execute)
    manager._hooks['pre_tool_call'] = [guard]
    def operation(name):
        return ('hermes', 'owned-writer', name)

    def dispatch(call, content, op=None):
        token = owner_operation.set(operation(op or call))
        try:
            with scope.dispatch(('owned-session', call)):
                return handle_function_call('warden_owned_write',
                    {'path': str(root / f'{call}.txt'), 'content': content},
                    session_id='owned-session', tool_call_id=call)
        finally:
            owner_operation.reset(token)

    result = dispatch('allowed', 'APPROVED')
    assert (root / 'allowed.txt').read_text() == 'APPROVED', result
    try:
        dispatch('allowed', 'REPLAY')
        raise AssertionError('replay allowed')
    except Denied:
        pass
    assert (root / 'allowed.txt').read_text() == 'APPROVED'
    print('PASS: real dispatch writes approved bytes once')
    assert ledger.state(operation('allowed')) == 'completed'
    result = dispatch('fresh-call', 'REPEAT', op='allowed')
    assert 'reconciliation required' in result and not (root / 'fresh-call.txt').exists(), result
    print('PASS: completed operation denies fresh-call repeat')

    result = dispatch('failed-effect', 'ERROR-AFTER-EFFECT')
    assert 'error' in result, result
    assert (root / 'failed-effect.txt').read_text() == 'ERROR-AFTER-EFFECT'
    assert ledger.state(operation('failed-effect')) == 'outcome-unknown'
    ledger = OutcomeLedger(root / 'outcomes.db')
    result = dispatch('unknown-retry', 'REPEAT', op='failed-effect')
    assert 'reconciliation required' in result and not (root / 'unknown-retry.txt').exists(), result
    print('PASS: post-effect error retains durable hold and denies fresh retry')

    assent = False
    result = dispatch('declined', 'DENIED')
    assert not (root / 'declined.txt').exists(), result
    print('PASS: decline blocks real dispatch effect')

    assent = True
    manager._hooks['pre_tool_call'] = [guard, lambda **kw: {
        'action': 'modify', 'args': {'content': 'UNAPPROVED'}}]
    result = dispatch('mutated', 'APPROVED')
    assert 'unapproved final executor input' in result, result
    assert not (root / 'mutated.txt').exists()
    print('PASS: later hook mutation denied at owned executor')

    manager._hooks['pre_tool_call'] = []
    result = handle_function_call('warden_owned_write',
        {'path': str(root / 'unscoped.txt'), 'content': 'DENIED'},
        session_id='owned-session', tool_call_id='unscoped')
    assert 'unapproved final executor input' in result, result
    assert not (root / 'unscoped.txt').exists(), result
    print('PASS: executor denies unscoped dispatch without pre-hook')

# Deterministic scope-close/late-assent coverage, separate from host timeout.
entered, release = Event(), Event()
failures = []
def late_approver(args):
    entered.set()
    if not release.wait(3):
        raise RuntimeError('test handshake timeout')
    return True

def late_callback():
    try:
        scope.approve(('late-session', 'late-call'), {'content': 'late'}, late_approver)
    except Denied as error:
        failures.append(str(error))

with scope.dispatch(('late-session', 'late-call')):
    worker = Thread(target=late_callback)
    worker.start()
    assert entered.wait(3)
release.set()
worker.join(3)
assert not worker.is_alive()
assert failures == ['scope closed before assent'], failures
print('PASS: closed owner scope rejects late assent')
print('LIMIT: simulated approver, owner-supplied IDs/operation keys, owned handler only; no portable preflight, authenticated ingress or reconciliation')
