import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../src/config.js";
import type { ActionGuardConfig } from "../src/config.js";
import { evaluatePortableAction } from "../src/portable-action.js";

const action = { host: "hermes", sessionId: "s", callId: "c", cwd: "/work", task: "test", tool: "functions.terminal", input: { command: "ls" } };
const invalid: Record<string, unknown>[] = [
  { floor: "bogus" }, { intentTraceOnly: "bogus" }, { timeoutMs: -1 },
  { intentMismatch: 2 }, { irreversible: { warn: 0.9, confirm: 0.1 } },
  { tools: [7] }, { exemptRules: [null] },
  { commandRules: [null] }, { commandDenyRules: [{ id: "bad", pattern: "[", severity: "deny" }] },
  { commandRules: [{ id: "bad", pattern: "ls", severity: "bogus" }] },
  { pathRules: [{ id: "bad", paths: ["/work/**"], access: "bogus", tools: ["write"], action: "block" }] },
  { pathRules: [{ id: "bad", paths: ["["], regex: true, access: "none", tools: ["write"], action: "block" }] },
  { pathRules: [{ id: "bad", paths: ["/work/**"], access: "none", tools: ["write"], action: "bogus" }] },
  { armingRules: [{ id: "bad", when: { edited: ["**"] }, arms: { command: "[" }, action: "block" }] },
];
for (const [index, override] of invalid.entries()) {
  test(`malformed policy ${index} denies before policy evaluation`, async () => {
    const config = { ...defaultConfig().action, ...override } as ActionGuardConfig;
    const result = await evaluatePortableAction(action, { config });
    assert.equal(result.level, "deny");
    assert.equal(result.intercepted, false);
  });
}
test("valid own command deny rule is applied", async () => {
  const config = { ...defaultConfig().action, commandDenyRules: [{ id: "ls", pattern: "^ls$", severity: "deny" as const }] };
  const result = await evaluatePortableAction(action, { config });
  assert.equal(result.level, "deny");
  assert.equal(result.intercepted, true);
});
