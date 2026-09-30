import type { ActionGuardConfig } from "./config.js";
import { evaluatePortableAction } from "./portable-action.js";
import { canonicalJson, plainData } from "./portable-plain-data.js";
import type { PortableAction, PortableDecision } from "./portable-action.js";

export type PortableApproval = (action: Readonly<PortableAction>, decision: PortableDecision) => Promise<boolean>;
export interface PortableBlock { block: true; reason: string }
export interface PortablePermit { block: false; action: Readonly<PortableAction> }
export type PortableExecution<T> = PortableBlock | { block: false; result: T };

/** Per-session, in-memory single-use call IDs. Share one ledger across all hooks. */
export class PortableCallLedger {
  private readonly seen = new Set<string>();

  claim(action: Readonly<PortableAction>): boolean {
    const { host, sessionId, callId } = action;
    if (typeof host !== "string" || !host
        || typeof sessionId !== "string" || !sessionId
        || typeof callId !== "string" || !callId) return false;
    const key = `${host.length}:${host}${sessionId.length}:${sessionId}${callId.length}:${callId}`;
    if (setHas.call(this.seen, key)) return false;
    setAdd.call(this.seen, key);
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
// Capture collection operations before later same-process prototype mutation.
const setHas = Set.prototype.has;
const setAdd = Set.prototype.add;
const weakMapGet = WeakMap.prototype.get;
const weakMapSet = WeakMap.prototype.set;
const weakSetHas = WeakSet.prototype.has;
const weakSetAdd = WeakSet.prototype.add;
const ownValues = Object.values;
const freeze = Object.freeze;

/**
 * Pi v0.87 executes its original validated argument reference after tool_call.
 * Bind the executing call's identity AND its validated argument reference to
 * the permit; deny if either changed since approval. The adapter must derive
 * call identity from the authentic host event, not untrusted model arguments.
 */
/** In-process provenance only; a caller with arbitrary code execution can still supply its own approver. */
const issuedPiPermits = new WeakMap<PortablePermit, { action: Readonly<PortableAction>; input: Record<string, unknown> }>();
/** Consume the same issued permit object once; not a durable approval token. */
const boundPiPermits = new WeakSet<PortablePermit>();

export function bindPiExecutionInput(call: PortableAction, permit: PortablePermit): PortableBlock | { block: false } {
  try {
    const issued = weakMapGet.call(issuedPiPermits, permit);
    if (!issued || issued.action !== permit.action) return block("Pi permit was not issued by preflight");
    if (weakSetHas.call(boundPiPermits, permit)) return block("Pi permit has already been bound");
    const { input } = call;
    if (input !== issued.input) return block("Pi execution input is not the approved reference");
    if (permit.block || permit.action.host !== "pi" || !plainData(call)
        || canonicalJson(call) !== canonicalJson(permit.action)) {
      return block("Pi execution call differs from approved invocation");
    }
    detachObjectPrototypes(input);
    deepFreeze(input);
    if (!hasDetachedObjectPrototypes(input) || !plainData(call)
        || canonicalJson(call) !== canonicalJson(permit.action)) {
      return block("Pi execution call changed during binding");
    }
    if (weakSetHas.call(boundPiPermits, permit)) return block("Pi permit has already been bound");
    weakSetAdd.call(boundPiPermits, permit);
    return { block: false };
  } catch {
    return block("Pi execution input could not be bound to approval");
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    const children = ownValues(value);
    for (let index = 0; index < children.length; index++) deepFreeze(children[index]);
    freeze(value);
  }
  return value;
}

/** Keep own arguments while removing mutable Object.prototype lookups. */
function detachObjectPrototypes(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  const children = ownValues(value);
  for (let index = 0; index < children.length; index++) detachObjectPrototypes(children[index]);
  if (!Array.isArray(value)) Object.setPrototypeOf(value, null);
}

/** Check after freezing so Proxy traps cannot lie about a non-extensible target. */
function hasDetachedObjectPrototypes(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== null) return false;
  const children = ownValues(value);
  for (let index = 0; index < children.length; index++) {
    if (!hasDetachedObjectPrototypes(children[index])) return false;
  }
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
  let executionInput: Record<string, unknown>;
  try {
    if (!plainData(action)) return block("Action cannot be bound to approval");
    executionInput = action.input;
    before = canonicalJson(action) ?? "";
    if (!before || canonicalJson(JSON.parse(before)) !== before) return block("Action cannot be bound to approval");
    snapshot = JSON.parse(before) as PortableAction;
    detachObjectPrototypes(snapshot);
    deepFreeze(snapshot);
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
    if (accepted !== true || action.input !== executionInput || !plainData(action) || canonicalJson(action) !== before) {
      return block("Approval declined or action changed while awaiting approval");
    }
    const permit: PortablePermit = freeze({ block: false, action: snapshot });
    weakMapSet.call(issuedPiPermits, permit, { action: snapshot, input: executionInput });
    return permit;
  } catch {
    return block("Approval failed; action was not authorized");
  }
}
