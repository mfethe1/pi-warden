# Durable outcome acceptance fixture

`tests/durable-outcome.test.ts` runs a Python 3 / SQLite subprocess fixture through
`npm run check`. Missing Python is a test failure, not a silent skip. No Python
packages, credentials, live host installation, or external effects are needed.

The fixture commits a unique `outcome-unknown` reservation before an effect.
Actual worker exit before or after an append leaves the reservation intact;
fresh workers are denied. A pipe handshake holds the winner after commit and
before the effect, proving that a separate overlapping worker is denied while
the winner is still running. Release produces exactly one append; a subsequent
fresh-process retry is denied. Temporary databases/effects are removed.

This is an acceptance model, NOT a production ledger or installed adapter.
Operation IDs are test constants. It proves neither authenticated identities,
human assent, safe intentional repeats, trusted reconciliation, power-loss
survival, nor atomicity between the database and filesystem effect.

## Gate recovery

The initial candidate and unchanged parent reproduced the same 30 failures.
Root cause: temporary projects under Hermes scratch discovered an unrelated
ancestor Git repository and inherited its ignore rules. A blanket test
assertion also rejected safe disposable database paths under the user's home.

The fixture preload now sets `GIT_CEILING_DIRECTORIES` to `tmpdir()`, preventing
ancestor repository discovery while preserving fixtures' own Git repositories.
The database test requires the exact disposable test-agent database path rather
than assuming all home-contained temporary directories are unsafe. Production
policy code is unchanged; no assertions were removed or tests skipped.

Canonical recovery run: `TMPDIR=/Users/mfethe/.hermes/cache/scratch npm run check`
returned exit 0: typecheck passed, 1,320 tests passed / 0 failed / 0 skipped,
and build passed. Evidence:
`/Users/mfethe/pi-warden-program/durable-outcome-ceiling-check.log`.

Independent review of 8df81d5 requested changes: optimization could remove
assertions, an outer timeout could orphan a held worker, and SQLite contexts
did not explicitly close connections. The fixture now uses isolated Python
(`-I`) with a fail-loud `__debug__` guard, explicit connection closing, and a
bounded handshake wait plus kill/reap cleanup. Regression coverage runs with
`PYTHONOPTIMIZE=2` in the environment and deliberately stalls the handshake.
The latter returns only after worker reaping and temporary-root cleanup.
This bounds tested stalls, not arbitrary forced termination of the fixture.

Post-review canonical run passed typecheck, 1,321 tests / 0 failed / 0 skipped,
and build; log: `/Users/mfethe/pi-warden-program/durable-outcome-review-fixes.log`.
Re-review is required before merge.

BLOCKER WARDEN-CANONICAL-SCRATCH: resolved by the test-only isolation change.
Independent review is still required before merge. This does not establish
production authorization or host enforcement.

NEXT: obtain independent review, then establish a repository-owned executor
boundary through real isolated Hermes dispatch using this durability coverage.
All cross-harness installation claims remain unproven.
