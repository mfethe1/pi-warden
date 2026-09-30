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

## Current gate blocker

On 2026-09-30, candidate `npm run check` returned exit 1: 1,320 tests,
1,290 pass / 30 fail. The new test passed. Unchanged parent d91b023 returned
exit 1: 1,319 tests, 1,289 pass / 30 fail, with exactly the same failing names.
Both typechecks passed; build was not reached because the check chain stopped.
Full logs: `/Users/mfethe/pi-warden-program/durable-outcome-check.log` and
`/Users/mfethe/pi-warden-program/durable-outcome-baseline.log`.

BLOCKER WARDEN-CANONICAL-SCRATCH: owner this thread's Hermes implementation
agent. TMPDIR is required to live in Hermes scratch under the real home, but
inherited extension tests require temporary data outside the real home and
show additional rules-fixture failures in this environment. Diagnose the
loader/fixture path assumptions and make tests safely location-independent
without weakening production rules. Do not push or merge this slice until
canonical gates are green and independent review is complete.

NEXT: resolve that attributed baseline gate, then establish a repository-owned
executor boundary through real isolated Hermes dispatch using this durability
coverage. All cross-harness installation claims remain unproven.
