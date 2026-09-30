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

Next criterion: connect portable preflight to this owned handler, then durable
reservation/outcome recording; prove host-owned ingress before broadening.
