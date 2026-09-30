import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, plainData } from "../src/portable-plain-data.js";

test("mutable array iterator cannot skip hidden fields or action snapshot keys", () => {
  const hidden = Object.defineProperty({ command: "ls" }, "background", { value: true });
  const input = { command: "approved", path: "/work/file" };
  const original = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
  let accepted: boolean;
  let snapshot: string | undefined;
  Object.defineProperty(Array.prototype, Symbol.iterator, {
    configurable: true,
    value: function* () {},
  });
  try {
    accepted = plainData(hidden);
    snapshot = canonicalJson(input);
  } finally {
    if (original) Object.defineProperty(Array.prototype, Symbol.iterator, original);
    else Reflect.deleteProperty(Array.prototype, Symbol.iterator);
  }
  assert.equal(accepted, false);
  assert.equal(snapshot, JSON.stringify(input));
});
