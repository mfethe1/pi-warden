const ownKeys = Reflect.ownKeys;
const descriptor = Object.getOwnPropertyDescriptor;
const prototype = Object.getPrototypeOf;

/** Reject inherited, hidden, accessor, sparse and non-JSON data before reading it. */
export function plainData(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  const array = Array.isArray(value);
  const parent = prototype(value);
  if (array ? parent !== Array.prototype : parent !== Object.prototype && parent !== null) return false;
  seen.add(value);
  const keys = ownKeys(value);
  if (array && keys.length !== value.length + 1) return false;
  for (const key of keys) {
    if (array && key === "length") continue;
    if (typeof key !== "string") return false;
    const field = descriptor(value, key);
    if (!field?.enumerable || !("value" in field) || !plainData(field.value, seen)) return false;
  }
  if (array) {
    for (let index = 0; index < value.length; index++) if (!descriptor(value, String(index))) return false;
  }
  seen.delete(value);
  return true;
}
