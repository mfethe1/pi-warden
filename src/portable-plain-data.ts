/** Reject getters, hidden keys, non-JSON values, prototypes, and cycles before policy evaluation. */
export function plainData(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype
        || Reflect.ownKeys(value).length !== value.length + 1) return false;
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
  const keys = Reflect.ownKeys(value);
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    if (typeof key !== "string") return false;
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !field.enumerable || !("value" in field) || !plainData(field.value, seen)) return false;
  }
  seen.delete(value);
  return true;
}

/** Serialize validated own data without consulting inherited toJSON methods. */
export function canonicalJson(value: unknown): string | undefined {
  const copy = (item: unknown): unknown => {
    if (Array.isArray(item)) {
      const array = new Array<unknown>(item.length);
      for (let index = 0; index < item.length; index++) array[index] = copy(item[index]);
      Object.setPrototypeOf(array, null);
      return array;
    }
    if (item !== null && typeof item === "object") {
      const object: Record<string, unknown> = Object.create(null);
      const keys = Object.keys(item);
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index]!;
        object[key] = copy((item as Record<string, unknown>)[key]);
      }
      return object;
    }
    return item;
  };
  return JSON.stringify(copy(value));
}
