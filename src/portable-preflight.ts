import type { ActionGuardConfig } from "./config.js";
import { evaluatePortableAction } from "./portable-action.js";
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

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** No getters, hidden keys, non-JSON values, or cycles may disappear from approval. */
function plainData(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).length !== value.length + 1) return false;
    seen.add(value);
    let valid = Object.keys(value).length === value.length;
    for (let index = 0; valid && index < value.length; index++) {
      const field = Object.getOwnPropertyDescriptor(value, String(index));
      valid = !!field?.enumerable && "value" in field && plainData(field.value, seen);
    }
    seen.delete(value);
    return valid;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return false;
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !field.enumerable || !("value" in field) || !plainData(field.value, seen)) return false;
  }
  seen.delete(value);
  return true;
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
