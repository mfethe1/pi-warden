import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../src/config.js";
import { preflightPortableAction } from "../src/portable-preflight.js";
import type { PortableApproval } from "../src/portable-preflight.js";

const config = defaultConfig().action;
const action = () => ({
  host: "pi", sessionId: "session-1", callId: "call-1", cwd: "/work", task: "Inspect files",
  tool: "bash", input: { command: "printf 'ok'" },
});

test("preflight blocks denied, declined, headless, and failed approvals before a side effect", async () => {
  let effects = 0;
  let prompts = 0;
  const attempt = async (a: ReturnType<typeof action>, approve?: Parameters<typeof preflightPortableAction>[2]) => {
    const result = await preflightPortableAction(a, { config }, approve);
    if (!result?.block) effects++;
    return result;
  };
  const denied = action();
  denied.tool = "python";
  assert.equal((await attempt(denied, async () => { prompts++; return true; }))?.block, true);
  assert.equal(prompts, 0, "a policy denial cannot be overridden by approval");
  assert.equal((await attempt(action()))?.block, true);
  assert.equal((await attempt(action(), async () => { prompts++; return false; }))?.block, true);
  assert.equal((await attempt(action(), async () => { prompts++; throw Error("UI unavailable"); }))?.block, true);
  assert.equal(effects, 0);
});

test("non-JSON or hidden effect-bearing fields are rejected before approval", async () => {
  const malformed = action();
  Object.defineProperty(malformed.input, "hidden", { value: "effect", enumerable: false });
  let prompted = false;
  const result = await preflightPortableAction(malformed, { config }, async () => { prompted = true; return true; });
  assert.equal(result?.block, true);
  assert.equal(prompted, false);
});

test("approval is fresh per call and rejects changed scope while awaiting a decision", async () => {
  const first = action();
  const changed = await preflightPortableAction(first, { config }, async (shown) => {
    assert.equal(shown.callId, "call-1");
    first.callId = "call-2";
    return true;
  });
  assert.equal(changed?.block, true);
  let approvals = 0;
  const approve: PortableApproval = async (shown) => {
    approvals++;
    assert.equal(shown.sessionId, "session-1");
    return approvals === 1;
  };
  assert.equal(await preflightPortableAction(action(), { config }, approve), undefined);
  assert.equal((await preflightPortableAction(action(), { config }, approve))?.block, true);
  assert.equal(approvals, 2, "approval from the first call is not cached for a second call");
});
