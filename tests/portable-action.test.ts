import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../src/config.js";
import { evaluatePortableAction } from "../src/portable-action.js";

const base = { sessionId: "s1", callId: "c1", cwd: "/work", task: "Inspect files" } as const;
const config = defaultConfig().action;

test("known host/tool pairs hold recursive removal", async () => {
  for (const [host, tool] of [["pi", "bash"], ["hermes", "functions.terminal"], ["claude", "Bash"]] as const) {
    const result = await evaluatePortableAction({ ...base, host, tool, input: { command: "rm -rf /work/data" } }, { config });
    assert.equal(result.intercepted, true);
    assert.ok(result.level === "confirm" || result.level === "deny", `${host}: ${result.level}`);
  }
});

test("unrecognized shell code cannot quietly pass as safe", async () => {
  const result = await evaluatePortableAction({ ...base, host: "hermes", tool: "functions.terminal", input: { command: "python3 -c \"import shutil; shutil.rmtree('/work/data')\"" } }, { config });
  assert.equal(result.level, "confirm");
  assert.equal(result.intercepted, true);
});

test("lexically in-project writes require approval even when the guard allows them", async () => {
  const result = await evaluatePortableAction({ ...base, host: "pi", tool: "write", input: { path: "/work/linked/external.txt", content: "overwrite" } }, { config });
  assert.equal(result.verdict?.level, "allow");
  assert.equal(result.level, "confirm");
});

test("portable approval floor survives a permissive or disabled guard configuration", async () => {
  const permissive = { ...config, enabled: false, tools: [], failOpen: true };
  for (const [host, tool, input] of [
    ["pi", "bash", { command: "printf 'ok'" }],
    ["claude", "Write", { file_path: "/work/a.ts", content: "ok" }],
    ["hermes", "functions.patch", { mode: "replace", path: "/work/a.ts", old_string: "a", new_string: "b" }],
  ] as const) {
    const result = await evaluatePortableAction({ ...base, host, tool, input }, { config: permissive });
    assert.equal(result.level, "confirm", `${host}/${tool}`);
    assert.equal(result.intercepted, true);
  }
});

test("unknown hosts, cross-host tool aliases and arbitrary code fail closed", async () => {
  for (const [host, tool, input] of [
    ["chatgpt", "terminal", { command: "rm -rf /" }],
    ["hermes", "Bash", { command: "rm -rf /" }],
    ["hermes", "functions.execute_code", { code: "import shutil; shutil.rmtree('/work')" }],
    ["hermes", "functions.patch", { mode: "patch", patch: "*** Begin Patch" }],
    ["__proto__", "Bash", { command: "ls" }],
    ["constructor", "Bash", { command: "ls" }],
  ] as const) {
    const result = await evaluatePortableAction({ ...base, host, tool, input }, { config });
    assert.equal(result.level, "deny", `${host}/${tool}`);
    assert.equal(result.intercepted, false);
  }
});

test("rejects malformed envelopes and conflicting workdirs", async () => {
  for (const action of [
    { ...base, host: "claude", cwd: "relative", tool: "Bash", input: { command: "ls" } },
    { ...base, host: "hermes", tool: "functions.terminal", input: { command: "ls", workdir: "/other" } },
  ]) {
    const result = await evaluatePortableAction(action, { config });
    assert.equal(result.level, "deny");
  }
});

test("unknown action-envelope fields are denied rather than dropped", async () => {
  const result = await evaluatePortableAction({ ...base, host: "pi", tool: "bash", input: { command: "ls" }, executionMode: "background" } as never, { config });
  assert.equal(result.level, "deny");
  assert.equal(result.intercepted, false);
});

test("malformed adapter arguments fail closed rather than throwing before evaluation", async () => {
  const action = { ...base, host: "pi", tool: "bash", input: { command: "ls" } };
  for (const malformed of [undefined, null, { config: undefined }, { config: { tools: null } }] as const) {
    const result = await evaluatePortableAction(action, malformed as never);
    assert.equal(result.level, "deny");
    assert.equal(result.intercepted, false);
  }
  const missingAction = await evaluatePortableAction(null as never, { config });
  assert.equal(missingAction.level, "deny");
  assert.equal(missingAction.intercepted, false);
});

test("maps write and edit shapes with effect-bearing fields intact", async () => {
  for (const [host, tool, input] of [
    ["pi", "write", { path: "/work/a.ts", content: "export const a = 1" }],
    ["hermes", "functions.write_file", { path: "/work/a.ts", content: "export const a = 1" }],
    ["claude", "Write", { file_path: "/work/a.ts", content: "export const a = 1" }],
    ["pi", "edit", { path: "/work/a.ts", edits: [{ oldText: "a", newText: "b" }] }],
    ["claude", "Edit", { file_path: "/work/a.ts", old_string: "a", new_string: "b" }],
    ["hermes", "functions.patch", { mode: "replace", path: "/work/a.ts", old_string: "a", new_string: "b" }],
  ] as const) {
    const result = await evaluatePortableAction({ ...base, host, tool, input }, { config });
    assert.equal(result.intercepted, true, `${host}/${tool}`);
    assert.notEqual(result.level, "deny", `${host}/${tool}`);
    assert.equal(result.verdict?.summary.path, "a.ts");
  }
});

test("unknown or asynchronous effect-bearing options cannot be silently dropped", async () => {
  for (const [host, tool, input] of [
    ["hermes", "functions.terminal", { command: "ls", background: true }],
    ["hermes", "functions.terminal", { command: "ls", timeout: 5000 }],
    ["claude", "Bash", { command: "ls", timeout: 5000 }],
    ["hermes", "functions.terminal", { command: "ls", workdir: null }],
    ["claude", "Bash", { command: "ls", run_in_background: true }],
    ["pi", "bash", { command: "ls", env: { SAFE: "1" } }],
    ["hermes", "functions.write_file", { path: "/work/a", content: "x", chmod: "777" }],
    ["claude", "Edit", { file_path: "/work/a", old_string: "a", new_string: "b", replace_all: true, extra: "ignored" }],
    ["claude", "Edit", { file_path: "/work/a", old_string: "a", new_string: "b", replace_all: 1 }],
    ["hermes", "functions.patch", { mode: "replace", path: "/work/a", old_string: "a", new_string: "b", replace_all: "false" }],
    ["pi", "edit", { path: "/work/a", edits: [{ oldText: "a", newText: "b", extra_effect: "delete" }] }],
  ] as const) {
    const result = await evaluatePortableAction({ ...base, host, tool, input }, { config });
    assert.equal(result.level, "deny", `${host}/${tool}`);
    assert.equal(result.intercepted, false);
  }
});

test("explicit scoped working directory remains evaluable", async () => {
  const result = await evaluatePortableAction({ ...base, host: "hermes", tool: "functions.terminal", input: { command: "ls", workdir: "/work" } }, { config });
  assert.equal(result.intercepted, true);
});

test("missing content, bulk edits and incomplete commands fail closed", async () => {
  for (const [host, tool, input] of [
    ["claude", "Write", { file_path: "/work/a" }],
    ["claude", "Bash", { nope: "ls" }],
    ["hermes", "functions.patch", { mode: "replace", path: "/work/a", old_string: "a", new_string: "b", replace_all: true }],
    ["pi", "edit", { path: "/work/a", edits: Array.from({ length: 4 }, () => ({ oldText: "a", newText: "b" })) }],
  ] as const) {
    const result = await evaluatePortableAction({ ...base, host, tool, input }, { config });
    assert.equal(result.level, "deny", `${host}/${tool}`);
  }
});
