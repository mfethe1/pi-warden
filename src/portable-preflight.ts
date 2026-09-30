import type { ActionGuardConfig } from "./config.js";
import { evaluatePortableAction } from "./portable-action.js";
import { plainData } from "./portable-plain-data.js";
import type { PortableAction, PortableDecision } from "./portable-action.js";

export type PortableApproval = (action: Readonly<PortableAction>, decision: PortableDecision) => Promise<boolean>;
export interface PortableBlock { block: true; reason: string }
export interface PortablePermit { block: false; action: Readonly<PortableAction> }
export type PortableExecution<T> = PortableBlock | { block: false; result: T };

/** Per-session, in-memory single-use call IDs. Share one ledger across all hooks. */
export class PortableCallLedger {
  private readonly seen = new Set<string>();

  claim(action: Readonly<PortableAction>): boolean {
    if (![action.host, action.sessionId, action.callId].every(value => typeof value === "string" && value.length > 0)) return false;
    const key = JSON.stringify([action.host, action.sessionId, action.callId]);
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}

export interface PortablePreflightOptions {
  config: ActionGuardConfig;
  /** Optional replay guard; requires a shared instance for the session lifetime. */
  ledger?: PortableCallLedger;
}

/**
 * An opt-in executor seam: the callback receives ONLY the immutable action
 * authorized by preflight. Callers must not execute the original request or
 * call the callback from another path. This does not install a host hook.
 * Executor failures are propagated, never disguised as pre-execution blocks.
 */
export async function executePortableAction<T>(
  action: PortableAction,
  options: PortablePreflightOptions,
  approve: PortableApproval | undefined,
  execute: (approved: Readonly<PortableAction>) => Promise<T>,
): Promise<PortableExecution<T>> {
  const permit = await preflightPortableAction(action, options, approve);
  if (permit.block) return permit;
  return { block: false, result: await execute(permit.action) };
}

const block = (reason: string): PortableBlock => ({ block: true, reason });

/**
 * Pi v0.87 executes its original validated argument reference after tool_call.
 * Bind that reference to a preflight permit; deny if it changed since approval.
 * This is a host-specific candidate, not a general replacement-input hook.
 */
export function bindPiExecutionInput(input: Record<string, unknown>, permit: PortablePermit): PortableBlock | { block: false } {
  try {
    if (permit.block || permit.action.host !== "pi" || !plainData(input)
        || JSON.stringify(input) !== JSON.stringify(permit.action.input)) {
      return block("Pi execution input differs from approved invocation");
    }
    deepFreeze(input);
    if (JSON.stringify(input) !== JSON.stringify(permit.action.input)) {
      return block("Pi execution input changed during binding");
    }
    return { block: false };
  } catch {
    return block("Pi execution input could not be bound to approval");
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Prototype adapter seam: return a block or a permit containing the exact
 * frozen invocation approved. The host MUST execute the permit's action, not
 * the mutable original. No host hook is installed by this function.
 */
export async function preflightPortableAction(
  action: PortableAction,
  options: PortablePreflightOptions,
  approve?: PortableApproval,
): Promise<PortableBlock | PortablePermit> {
  let before: string;
  let snapshot: PortableAction;
  try {
    if (!plainData(action)) return block("Action cannot be bound to approval");
    before = JSON.stringify(action);
    if (!before || JSON.stringify(JSON.parse(before)) !== before) return block("Action cannot be bound to approval");
    snapshot = deepFreeze(JSON.parse(before) as PortableAction);
  } catch {
    return block("Action cannot be bound to approval");
  }
  const decision = await evaluatePortableAction(snapshot, options);
  if (decision.level === "deny") return block(decision.reason);
  if (decision.level !== "confirm" || !decision.intercepted || !approve) {
    return block("No mandatory interactive approval available");
  }
  try {
    // Claim before the first await so concurrent invocations cannot reuse the ID.
    // A declined/failed request is still consumed; retry with a new host call ID.
    if (options.ledger && !options.ledger.claim(snapshot)) {
      return block("Call ID already used or invalid");
    }
    // Both the policy and the approver inspect the same immutable invocation.
    const accepted = await approve(snapshot, decision);
    if (accepted !== true || !plainData(action) || JSON.stringify(action) !== before) {
      return block("Approval declined or action changed while awaiting approval");
    }
    return { block: false, action: snapshot };
  } catch {
    return block("Approval failed; action was not authorized");
  }
}
