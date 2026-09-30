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

test("unknown hosts, cross-host tool aliases and arbitrary code fail closed", async () => {
  for (const [host, tool, input] of [
    ["chatgpt", "terminal", { command: "rm -rf /" }],
    ["hermes", "Bash", { command: "rm -rf /" }],
    ["hermes", "functions.execute_code", { code: "import shutil; shutil.rmtree('/work')" }],
    ["hermes", "functions.patch", { mode: "patch", patch: "*** Begin Patch" }],
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
