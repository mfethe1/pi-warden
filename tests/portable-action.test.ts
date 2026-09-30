import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../src/config.js";
import { evaluatePortableAction } from "../src/portable-action.js";

const base = { host: "hermes", sessionId: "s1", callId: "c1", cwd: "/work", task: "Inspect files" } as const;

test("normalizes the same destructive command from Pi, Hermes, Claude and ChatGPT", async () => {
  for (const tool of ["bash", "terminal", "Bash", "functions.terminal"] as const) {
    const result = await evaluatePortableAction({ ...base, tool, input: { command: "rm -rf /work/data" } }, { config: defaultConfig().action });
    assert.equal(result.intercepted, true);
    assert.ok(result.level === "confirm" || result.level === "deny", `${tool}: ${result.level}`);
  }
});

test("unknown and arbitrary code tools are blocked rather than guessed read-only", async () => {
  for (const [tool, input] of [["mystery", { command: "rm -rf /" }], ["functions.execute_code", { code: "import shutil; shutil.rmtree('/work')" }], ["functions.patch", { mode: "patch", patch: "*** Begin Patch" }]] as const) {
    const result = await evaluatePortableAction({ ...base, tool, input }, { config: defaultConfig().action });
    assert.equal(result.level, "deny");
    assert.equal(result.intercepted, false);
  }
});

test("rejects malformed envelopes before judging", async () => {
  const result = await evaluatePortableAction({ ...base, cwd: "relative", tool: "Bash", input: { command: "ls" } }, { config: defaultConfig().action });
  assert.equal(result.level, "deny");
});

test("normalizes write and edit tool shapes without silently losing content", async () => {
  const config = defaultConfig().action;
  for (const [tool, input] of [
    ["write_file", { path: "/work/a.ts", content: "export const a = 1" }],
    ["Write", { file_path: "/work/a.ts", content: "export const a = 1" }],
    ["Edit", { file_path: "/work/a.ts", old_string: "a", new_string: "b" }],
  ] as const) {
    const result = await evaluatePortableAction({ ...base, tool, input }, { config });
    assert.equal(result.intercepted, true, tool);
    assert.notEqual(result.level, "deny", tool);
  }
});

test("missing write content and shell argument fail closed", async () => {
  for (const [tool, input] of [["Write", { file_path: "/work/a" }], ["Bash", { nope: "ls" }]] as const) {
    const result = await evaluatePortableAction({ ...base, tool, input }, { config: defaultConfig().action });
    assert.equal(result.level, "deny");
  }
});
