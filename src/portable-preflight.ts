import type { ActionGuardConfig } from "./config.js";
import { evaluatePortableAction } from "./portable-action.js";
import type { PortableAction, PortableDecision } from "./portable-action.js";

export type PortableApproval = (action: Readonly<PortableAction>, decision: PortableDecision) => Promise<boolean>;
export interface PortableBlock { block: true; reason: string }

const block = (reason: string): PortableBlock => ({ block: true, reason });

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
 * Prototype adapter seam: return a Pi-style block response before execution.
 * An actual host hook must call this for EVERY effectful tool before any early
 * exits, keep the invocation immutable until it executes, and honor the block.
 * No host hook is installed by this function.
 */
export async function preflightPortableAction(
  action: PortableAction,
  options: { config: ActionGuardConfig },
  approve?: PortableApproval,
): Promise<PortableBlock | undefined> {
  let before: string;
  try {
    if (!plainData(action)) return block("Action cannot be bound to approval");
    before = JSON.stringify(action);
    if (!before || JSON.stringify(JSON.parse(before)) !== before) return block("Action cannot be bound to approval");
  } catch {
    return block("Action cannot be bound to approval");
  }
  const decision = await evaluatePortableAction(action, options);
  if (decision.level === "deny") return block(decision.reason);
  if (decision.level !== "confirm" || !decision.intercepted || !approve) {
    return block("No mandatory interactive approval available");
  }
  try {
    // The approver sees a snapshot; it cannot rewrite the action the host runs.
    const accepted = await approve(JSON.parse(before) as PortableAction, decision);
    if (accepted !== true || !plainData(action) || JSON.stringify(action) !== before) {
      return block("Approval declined or action changed while awaiting approval");
    }
    return undefined;
  } catch {
    return block("Approval failed; action was not authorized");
  }
}
