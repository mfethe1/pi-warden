"""Experimental owned-handler boundary. Not protection for Hermes built-ins."""
import json
from contextlib import contextmanager
from threading import Lock


class Denied(RuntimeError):
    pass


def snapshot(args):
    # Reject non-JSON objects instead of invoking user-defined copy/equality code.
    def plain(value):
        if type(value) in (str, bool, int, type(None)):
            return
        if type(value) is dict and all(type(key) is str for key in value):
            for item in value.values():
                plain(item)
            return
        if type(value) is list:
            for item in value:
                plain(item)
            return
        raise Denied('unsupported input')
    plain(args)
    return json.dumps(args, sort_keys=True, separators=(',', ':'))


class OwnedScope:
    """Identity must be supplied by a trusted owner, never tool arguments.

    An owner wraps dispatch, a pre-hook calls approve, and an owned executor
    calls consume. No durable operation identity or approval UI is provided.
    """
    def __init__(self):
        self._lock = Lock()
        self._active = {}
        self._claimed = set()
        self._permits = {}

    @contextmanager
    def dispatch(self, identity):
        if (type(identity) is not tuple or len(identity) != 2 or
                not all(type(part) is str and part for part in identity)):
            raise Denied('missing owner identity')
        token = object()
        with self._lock:
            if identity in self._active or identity in self._claimed:
                raise Denied('identity already used')
            self._active[identity] = token
        try:
            yield
        finally:
            with self._lock:
                self._active.pop(identity, None)
                self._permits.pop(identity, None)
                self._claimed.add(identity)

    def approve(self, identity, args, approver):
        with self._lock:
            token = self._active.get(identity)
            if token is None or identity in self._claimed:
                raise Denied('inactive or consumed scope')
            self._claimed.add(identity)
        encoded = snapshot(args)
        if approver(json.loads(encoded)) is not True:
            raise Denied('approval unavailable or declined')
        with self._lock:
            if self._active.get(identity) is not token:
                raise Denied('scope closed before assent')
            self._permits[identity] = encoded

    def consume(self, identity, args):
        with self._lock:
            encoded = self._permits.pop(identity, None)
            active = identity in self._active
        if not active or encoded is None or encoded != snapshot(args):
            raise Denied('unapproved final executor input')
        return json.loads(encoded)
