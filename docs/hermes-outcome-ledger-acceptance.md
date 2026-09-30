# Experimental owned permit → durable outcome slice

`experimental/hermes/outcome_ledger.py` composes the reviewed owned scope with SQLite: consume the exact approved input once, commit an `outcome-unknown` reservation before invoking the effect, then commit `completed` after a normal return. Exceptions, worker exits and outcome-recording failures do not release the hold. All existing reservations, including completed ones, deny new calls. No retry/release/reconciliation API is implemented.

The operation tuple `(host, resource, owner_operation)` is passed separately by the isolated owner, not obtained from model arguments. This is an assumed owner identity, **not authenticated ingress or a trustworthy production operation-key producer**. Different owner keys can duplicate an effect; intentional repeats and key reconciliation remain unresolved. ContextVars carry identity but do not authenticate it.

## Evidence

- Canonical fixture `tests/fixtures/hermes-outcome-ledger.py`: six cases covering completion/new-call repeat denial, post-effect exception with actual retained bytes, rejected input/no reservation, storage connection failure/no effect, missing operation/no effect, and process exit24 after fsynced effect with durable hold denying fresh-process retry.
- Node wrapper runs Python `-I -B` despite inherited `PYTHONOPTIMIZE=2` and has a bounded timeout.
- Updated standalone `verify_dispatch.py` uses actual Hermes registered-tool dispatch. Seven checks passed: approved write, completed repeat denial, post-effect exception/unknown hold/fresh retry denial, decline, later mutation, executor-only unscoped denial, deterministic late-assent rejection. Host checkout `a7c2df3846f7d6040dd81b7573bd962da546222e`, Python3.11.15; isolated HERMES_HOME and owned scratch effects only.
- Canonical full gate recorded separately; do not equate standalone host checks with canonical-suite coverage or installed enforcement.

## Limits

No portable preflight wiring, authenticated owner/operation key, real approval UI, Hermes built-in protection, actual host-timeout proof, cross-session same-call suppression fix, or other harness enforcement. SQLite process-crash acceptance is not power-loss/distributed durability. Effect and outcome commit are not atomic. Reservation storage must be owned/protected; no hostile filesystem/symlink protection is claimed. No automatic retry after an unknown outcome. Earlier owned-scope acceptance documents describe the prior no-ledger revision; this document extends only the isolated owned executor path.
