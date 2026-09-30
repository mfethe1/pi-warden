import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("owned permits compose with durable outcome holds", () => {
  const fixture = fileURLToPath(new URL("./fixtures/hermes-outcome-ledger.py", import.meta.url));
  const result = spawnSync("python3", ["-I", "-B", fixture], {
    encoding: "utf8", timeout: 15_000, env: { ...process.env, PYTHONOPTIMIZE: "2" },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stderr, /Ran 6 tests/);
  assert.match(result.stderr, /\bOK\b/);
});
