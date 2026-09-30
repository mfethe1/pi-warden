# Experimental Hermes owned scope — checkpoint

Owner: Hermes on Airy, Telegram thread 184395. Isolated branch:
`feature/hermes/owned-executor-scope`, based on reviewed PR #38 revision 1956ba5.
No active Hermes code/config was changed. This is not installed enforcement.

Repository-owned Python adapter: `experimental/hermes/owned_scope.py`.
Owner-created dispatch lifetime, identity tuple, private JSON snapshot,
lock-checked assent publication, final executor comparison, one-use consumption,
and finally cleanup. Rejects non-JSON objects and non-True approval.

Verification:
- Canonical `TMPDIR=/Users/mfethe/.hermes/cache/scratch npm run check`: exit 0,
  typecheck, 1,323 tests passed / 0 failed / 0 skipped, build.
  Log: `/Users/mfethe/pi-warden-program/hermes-owned-scope-canonical.log`.
- Separate isolated host acceptance script `experimental/hermes/verify_dispatch.py`
  ran using Hermes checkout a7c2df3846f7d6040dd81b7573bd962da546222e,
  Python 3.11.15, fresh scratch HERMES_HOME and credential-variable-scrubbed
  environment. Exit 0: four real registered-tool dispatch checks (approved
  bytes/replay, decline, later-hook mutation, missing scope), plus deterministic
  late-assent scope-close check. Log:
  `/Users/mfethe/pi-warden-program/hermes-owned-scope-check.log`.
  No worker remained; temporary home/effect directory cleaned.

Limits / separately owned blockers (owner: implementing Hermes):
- WARDEN-TRUSTED-INGRESS: identity is supplied by the test owner, not authenticated
  ingress. Unblock with host-owned identity/lifetime integration.
- WARDEN-PREFLIGHT-LEDGER: no portable preflight or durable operation ledger in
  this adapter. Unblock by connecting repository implementations and real
  dispatch outcome tests; never retry unknown outcomes automatically.
- WARDEN-HOST-COLLISION: call-ID-only callback gate remains unchanged. Same-ID
  cross-session collision and actual host-timeout callback acceptance unproven.
- WARDEN-HARNESS-COVERAGE: only the registered scratch writer is protected;
  built-ins, shipped Pi, Claude Code, Codex and owned MCP remain separate lanes.
- WARDEN-SCOPE-REVIEW: independent review required before merge/readiness.

Next criterion: obtain exact-revision review of the corrections below, then connect
portable preflight and durable reservation/outcome recording; prove host-owned
ingress before broadening.

## PR #39 review correction checkpoint

Independent review deleg_678de682 requested changes at 3b4a8c8. The implementing
owner reproduced both reported races with repository-owned deterministic trace
pauses: the six-case Python fixture initially failed two tests (subclass method
invocation during serialization and consumption succeeding after scope closure).

Corrections: validate and detach plain containers in one traversal; serialize only
the detached result. Final consumption validates before atomically checking live
scope and removing the permit. **Successful consumption commits authorization**;
closure after that commitment does not revoke already-returned data or roll back
an effect. No host-timeout or arbitrary malicious-plugin isolation is established.
Concurrent edits can still produce a mixed-time plain snapshot; the exact detached
representation is the approval/comparison input, not an atomic application snapshot.

The canonical test now runs six Python cases covering both races, positive
consumption/replay/nested detachment, decline/non-True/unavailable/throwing approval,
unused-permit cleanup/late assent, and same-call-ID interleaved owner sessions.
That last case tests this adapter, not the unchanged Hermes callback gate.
The isolated unscoped dispatch now bypasses all pre-hooks and checks the executor
error and absence of an effect directly.

Verification after corrections:
- Focused canonical: 2 passed, exit 0; Python 3.11.15 fixture: 6 passed.
- Full canonical check: exit 0, typecheck, 1,324 passed / 0 failed / 0 skipped,
  build. Log: `/Users/mfethe/pi-warden-program/hermes-owned-review-fixes-gate.log`.
- Isolated real dispatch: exit 0, five acceptance checks; log:
  `/Users/mfethe/pi-warden-program/hermes-owned-review-fixes-dispatch.log`.
- Supplemental in-memory mutation experiment (not canonical): four mutants
  rejected with unittest failures: ignored decline, ignored lifetime publication
  check, caller-mutable return, and omitted unused-permit cleanup. No mutant
  source or effects persisted.

WARDEN-SCOPE-REVIEW remains open: owner implementing Hermes; unblock through
independent exact-revision re-review. No merge, installation, or expanded coverage.
