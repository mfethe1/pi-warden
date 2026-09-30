"""Experimental owner-keyed operation holds; no authenticated key producer or reconciliation."""
from contextlib import closing
import sqlite3

from owned_scope import Denied, snapshot


class OutcomeLedger:
    def __init__(self, path):
        self.path = path
        with closing(self.connect()) as db:
            db.execute('CREATE TABLE IF NOT EXISTS outcomes '
                       '(operation TEXT PRIMARY KEY, approved TEXT NOT NULL, state TEXT NOT NULL)')
            db.commit()

    def connect(self):
        return sqlite3.connect(self.path, timeout=1)

    def key(self, operation):
        if (type(operation) is not tuple or len(operation) != 3 or
                not all(type(part) is str and part for part in operation)):
            raise Denied('missing owner operation identity')
        return snapshot(list(operation))

    def reserve(self, operation, approved):
        key, encoded = self.key(operation), snapshot(approved)
        with closing(self.connect()) as db:
            try:
                db.execute('INSERT INTO outcomes VALUES (?, ?, ?)',
                           (key, encoded, 'outcome-unknown'))
                db.commit()  # Must complete before the effect is invoked.
            except sqlite3.IntegrityError as error:
                db.rollback()
                raise Denied('operation already reserved; reconciliation required') from error
        return key

    def state(self, operation):
        with closing(self.connect()) as db:
            row = db.execute('SELECT state FROM outcomes WHERE operation=?',
                             (self.key(operation),)).fetchone()
        return row[0] if row else None

    def execute(self, scope, identity, operation, args, effect):
        approved = scope.consume(identity, args)
        key = self.reserve(operation, approved)
        result = effect(approved)
        # Exceptions, process exits and completion-write errors retain the hold.
        # A completed effect cannot be rolled back by a subsequent DB failure.
        with closing(self.connect()) as db:
            changed = db.execute("UPDATE outcomes SET state='completed' "
                                 "WHERE operation=? AND state='outcome-unknown'", (key,))
            if changed.rowcount != 1:
                raise Denied('outcome recording failed; inspect actual effect')
            db.commit()
        return result
