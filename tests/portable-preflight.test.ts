import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.js";
import type { PortableAction } from "../src/portable-action.js";
import { bindPiExecutionInput, executePortableAction, PortableCallLedger, preflightPortableAction } from "../src/portable-preflight.js";
import type { PortableApproval } from "../src/portable-preflight.js";

const config = defaultConfig().action;
const action = () => ({
  host: "pi", sessionId: "session-1", callId: "call-1", cwd: "/work", task: "Inspect files",
  tool: "bash", input: { command: "printf 'ok'" },
});

test("Pi binder rejects a forged or copied permit even for matching inputs", async () => {
  const request = action();
  const forged = { block: false as const, action: structuredClone(request) };
  assert.equal(bindPiExecutionInput(request, forged).block, true);
  const permit = await preflightPortableAction(request, { config }, async () => true);
  assert.equal(permit.block, false);
  if (permit.block) return;
  assert.equal(Object.isFrozen(permit), true);
  assert.equal(bindPiExecutionInput(request, { block: false, action: permit.action }).block, true);
  assert.equal(bindPiExecutionInput(request, permit).block, false);
});

test("mutating WeakSet.prototype.has cannot replay a consumed Pi permit", async () => {
  const request = action();
  const permit = await preflightPortableAction(request, { config }, async () => true);
  assert.equal(permit.block, false);
  if (permit.block) return;
  assert.equal(bindPiExecutionInput(request, permit).block, false);
  const original = Object.getOwnPropertyDescriptor(WeakSet.prototype, "has");
  Object.defineProperty(WeakSet.prototype, "has", { configurable: true, value: () => false });
  try {
    assert.equal(bindPiExecutionInput(request, permit).block, true);
  } finally {
    if (original) Object.defineProperty(WeakSet.prototype, "has", original);
    else Reflect.deleteProperty(WeakSet.prototype, "has");
  }
});

test("mutating Array.prototype.toJSON cannot replay a consumed call ID", () => {
  const ledger = new PortableCallLedger();
  const request = action();
  assert.equal(ledger.claim(request), true);
  const original = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
  let counter = 0;
  Object.defineProperty(Array.prototype, "toJSON", { configurable: true, value: () => ++counter });
  try {
    assert.equal(ledger.claim(request), false);
  } finally {
    if (original) Object.defineProperty(Array.prototype, "toJSON", original);
    else Reflect.deleteProperty(Array.prototype, "toJSON");
  }
});

test("call-ID key is unambiguous when identity fields contain separators", () => {
  const ledger = new PortableCallLedger();
  const first = { ...action(), host: "a", sessionId: "b:c", callId: "d" };
  const second = { ...first, host: "a:b", sessionId: "c" };
  assert.equal(ledger.claim(first), true);
  assert.equal(ledger.claim(second), true);
  assert.equal(ledger.claim(first), false);
  assert.equal(ledger.claim(second), false);
});

test("mutating Set.prototype.has cannot replay a consumed call ID", () => {
  const ledger = new PortableCallLedger();
  assert.equal(ledger.claim(action()), true);
  const original = Object.getOwnPropertyDescriptor(Set.prototype, "has");
  Object.defineProperty(Set.prototype, "has", { configurable: true, value: () => false });
  try {
    assert.equal(ledger.claim(action()), false);
  } finally {
    if (original) Object.defineProperty(Set.prototype, "has", original);
    else Reflect.deleteProperty(Set.prototype, "has");
  }
});

test("Pi binder rejects a matching clone rather than freezing the executing reference", async () => {
  const request = action();
  const permit = await preflightPortableAction(request, { config }, async () => true);
  assert.equal(permit.block, false);
  if (permit.block) return;
  const clone = structuredClone(request.input);
  assert.equal(bindPiExecutionInput({ ...request, input: clone }, permit).block, true);
  assert.equal(Object.isFrozen(request.input), false);
  assert.equal(bindPiExecutionInput(request, permit).block, false);
  assert.equal(Object.isFrozen(request.input), true);
});

test("Pi preflight rejects replacing the input reference while approval waits", async () => {
  const request = action();
  const original = request.input;
  const permit = await preflightPortableAction(request, { config }, async () => {
    request.input = structuredClone(original);
    return true;
  });
  assert.equal(permit.block, true);
});

test("Pi input binder rejects post-approval changes and freezes nested edits", async () => {
  const input = { path: "/tmp/example", edits: [{ oldText: "before", newText: "after" }] };
  const request: PortableAction = { ...action(), tool: "edit", input };
  const permit = await preflightPortableAction(request, { config }, async () => true);
  assert.equal(permit.block, false);
  if (permit.block) return;
  const changed = structuredClone(input);
  changed.edits[0]!.newText = "malicious";
  assert.equal(bindPiExecutionInput({ ...request, input: changed }, permit).block, true);
  for (const field of ["sessionId", "callId", "cwd", "task", "tool"] as const) {
    assert.equal(bindPiExecutionInput({ ...request, [field]: `${request[field]}-other` }, permit).block, true, field);
  }
  assert.equal(bindPiExecutionInput(request, permit).block, false);
  assert.equal(bindPiExecutionInput({ ...request, input: structuredClone(input) }, permit).block, true);
  assert.equal(Object.isFrozen(input), true);
  assert.equal(Object.isFrozen(input.edits), true);
  assert.equal(Object.isFrozen(input.edits[0]), true);
  assert.throws(() => { input.edits[0]!.newText = "malicious"; }, TypeError);
});

test("mutating Object.values cannot skip freezing executing nested edits", async () => {
  const input = { path: "/tmp/example", edits: [{ oldText: "before", newText: "after" }] };
  const request: PortableAction = { ...action(), tool: "edit", input };
  const permit = await preflightPortableAction(request, { config }, async () => true);
  assert.equal(permit.block, false);
  if (permit.block) return;
  const original = Object.getOwnPropertyDescriptor(Object, "values");
  let result: boolean | undefined;
  Object.defineProperty(Object, "values", { configurable: true, value: () => [] });
  try {
    result = bindPiExecutionInput(request, permit).block;
  } finally {
    if (original) Object.defineProperty(Object, "values", original);
    else Reflect.deleteProperty(Object, "values");
  }
  assert.equal(result, false);
  assert.equal(Object.isFrozen(input.edits), true);
  assert.equal(Object.isFrozen(input.edits[0]), true);
  assert.throws(() => { input.edits[0]!.newText = "unapproved"; }, TypeError);
});

test("replacing prototype helpers after approval cannot leave inherited Pi options", async () => {
  const input = { path: "/tmp/example", edits: [{ oldText: "before", newText: "after" }] };
  const request: PortableAction = { ...action(), tool: "edit", input };
  const permit = await preflightPortableAction(request, { config }, async () => true);
  assert.equal(permit.block, false);
  if (permit.block) return;
  const originalGet = Object.getOwnPropertyDescriptor(Object, "getPrototypeOf");
  const originalSet = Object.getOwnPropertyDescriptor(Object, "setPrototypeOf");
  let result: boolean | undefined;
  Object.defineProperty(Object, "getPrototypeOf", { configurable: true, value: (value: object) => Array.isArray(value) ? Array.prototype : null });
  Object.defineProperty(Object, "setPrototypeOf", { configurable: true, value: <T>(value: T): T => value });
  try {
    result = bindPiExecutionInput(request, permit).block;
  } finally {
    if (originalGet) Object.defineProperty(Object, "getPrototypeOf", originalGet);
    if (originalSet) Object.defineProperty(Object, "setPrototypeOf", originalSet);
  }
  assert.equal(result, false);
  assert.equal(Object.getPrototypeOf(input), null);
  assert.equal(Object.getPrototypeOf(input.edits[0]), null);
});

test("replacing Object.freeze after approval cannot leave Pi execution edits mutable", async () => {
  const input = { path: "/tmp/example", edits: [{ oldText: "before", newText: "after" }] };
  const request: PortableAction = { ...action(), tool: "edit", input };
  const permit = await preflightPortableAction(request, { config }, async () => true);
  assert.equal(permit.block, false);
  if (permit.block) return;
  const original = Object.getOwnPropertyDescriptor(Object, "freeze");
  let result: boolean | undefined;
  Object.defineProperty(Object, "freeze", { configurable: true, value: <T>(value: T): T => value });
  try {
    result = bindPiExecutionInput(request, permit).block;
  } finally {
    if (original) Object.defineProperty(Object, "freeze", original);
    else Reflect.deleteProperty(Object, "freeze");
  }
  assert.equal(result, false);
  assert.equal(Object.isFrozen(input.edits[0]), true);
  assert.throws(() => { input.edits[0]!.newText = "unapproved"; }, TypeError);
});

test("mutated array iterator cannot skip freezing approved or executing nested edits", async () => {
  const input = { path: "/tmp/example", edits: [{ oldText: "before", newText: "after" }] };
  const request: PortableAction = { ...action(), tool: "edit", input };
  const original = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
  let frozen: boolean | undefined;
  let result: boolean | undefined;
  Object.defineProperty(Array.prototype, Symbol.iterator, { configurable: true, value: function* () {} });
  try {
    const permit = await preflightPortableAction(request, { config }, async () => true);
    assert.equal(permit.block, false);
    if (permit.block) return;
    result = bindPiExecutionInput(request, permit).block;
    frozen = Object.isFrozen(permit.action.input.edits) && Object.isFrozen(input.edits)
      && Object.isFrozen(input.edits[0]);
  } finally {
    if (original) Object.defineProperty(Array.prototype, Symbol.iterator, original);
    else Reflect.deleteProperty(Array.prototype, Symbol.iterator);
  }
  assert.equal(result, false);
  assert.equal(frozen, true);
  assert.throws(() => { input.edits[0]!.newText = "unapproved"; }, TypeError);
});

test("inherited toJSON cannot conceal a changed Pi execution command", async () => {
  const request = action();
  const permit = await preflightPortableAction(request, { config }, async () => true);
  assert.equal(permit.block, false);
  if (permit.block) return;
  request.input.command = "printf EVIL";
  const prototype = Object.prototype as Record<string, unknown>;
  const before = Object.getOwnPropertyDescriptor(prototype, "toJSON");
  Object.defineProperty(prototype, "toJSON", {
    configurable: true,
    value(this: { command?: string }) {
      return this.command === "printf EVIL" ? { ...this, command: "printf 'ok'" } : this;
    },
  });
  try {
    assert.equal(bindPiExecutionInput(request, permit).block, true);
    assert.equal(request.input.command, "printf EVIL");
  } finally {
    if (before) Object.defineProperty(prototype, "toJSON", before);
    else Reflect.deleteProperty(prototype, "toJSON");
  }
});

test("replacing getOwnPropertyDescriptor cannot smuggle a changing command getter into Pi execution", async () => {
  const request = action();
  const permit = await preflightPortableAction(request, { config }, async () => true);
  assert.equal(permit.block, false);
  if (permit.block) return;
  let executed = false;
  Object.defineProperty(request.input, "command", {
    configurable: true,
    enumerable: true,
    get: () => executed ? "printf UNAPPROVED" : "printf 'ok'",
  });
  const original = Object.getOwnPropertyDescriptor(Object, "getOwnPropertyDescriptor");
  const descriptor = Object.getOwnPropertyDescriptor;
  Object.defineProperty(Object, "getOwnPropertyDescriptor", {
    configurable: true,
    value: (target: object, key: PropertyKey) =>
      target === request.input && key === "command"
        ? { configurable: true, enumerable: true, writable: true, value: "printf 'ok'" }
        : descriptor(target, key),
  });
  try {
    const result = bindPiExecutionInput(request, permit);
    executed = true;
    assert.equal(result.block, true);
  } finally {
    if (original) Object.defineProperty(Object, "getOwnPropertyDescriptor", original);
  }
});

test("replacing Reflect.ownKeys after approval cannot conceal a hidden Pi option", async () => {
  const request = action();
  const permit = await preflightPortableAction(request, { config }, async () => true);
  assert.equal(permit.block, false);
  if (permit.block) return;
  Object.defineProperty(request.input, "timeout", { value: 0, enumerable: false });
  const original = Object.getOwnPropertyDescriptor(Reflect, "ownKeys");
  const ownKeys = Reflect.ownKeys;
  Object.defineProperty(Reflect, "ownKeys", {
    configurable: true,
    value: (value: object) => ownKeys(value).filter((key) => key !== "timeout"),
  });
  try {
    assert.equal(bindPiExecutionInput(request, permit).block, true);
  } finally {
    if (original) Object.defineProperty(Reflect, "ownKeys", original);
  }
});

test("replacing Object.create after approval cannot conceal a changed Pi command", async () => {
  const request = action();
  const permit = await preflightPortableAction(request, { config }, async () => true);
  assert.equal(permit.block, false);
  if (permit.block) return;
  request.input.command = "printf UNAPPROVED";
  const original = Object.getOwnPropertyDescriptor(Object, "create");
  Object.defineProperty(Object, "create", {
    configurable: true,
    value: () => ({
      toJSON(this: { command?: string }) {
        return this.command === "printf UNAPPROVED"
          ? { ...this, command: "printf 'ok'" }
          : this;
      },
    }),
  });
  try {
    assert.equal(bindPiExecutionInput(request, permit).block, true);
  } finally {
    if (original) Object.defineProperty(Object, "create", original);
  }
});

test("replacing JSON.stringify after approval cannot conceal a changed Pi command", async () => {
  const request = action();
  const permit = await preflightPortableAction(request, { config }, async () => true);
  assert.equal(permit.block, false);
  if (permit.block) return;
  request.input.command = "printf UNAPPROVED";
  const original = Object.getOwnPropertyDescriptor(JSON, "stringify");
  const stringify = JSON.stringify;
  let blocked: boolean | undefined;
  Object.defineProperty(JSON, "stringify", {
    configurable: true,
    value: (value: unknown) => stringify(value).replaceAll("printf UNAPPROVED", "printf 'ok'"),
  });
  try {
    blocked = bindPiExecutionInput(request, permit).block;
  } finally {
    if (original) Object.defineProperty(JSON, "stringify", original);
  }
  assert.equal(blocked, true);
});

test("replacing Object.keys after approval cannot conceal a changed Pi command", async () => {
  const request = action();
  const permit = await preflightPortableAction(request, { config }, async () => true);
  assert.equal(permit.block, false);
  if (permit.block) return;
  request.input.command = "printf UNAPPROVED";
  const original = Object.getOwnPropertyDescriptor(Object, "keys");
  const keys = Object.keys;
  let blocked: boolean | undefined;
  Object.defineProperty(Object, "keys", {
    configurable: true,
    value: (value: object) => keys(value).filter((key) => key !== "command"),
  });
  try {
    blocked = bindPiExecutionInput(request, permit).block;
  } finally {
    if (original) Object.defineProperty(Object, "keys", original);
  }
  assert.equal(blocked, true);
});

test("approved and Pi-bound inputs cannot acquire inherited optional fields", async () => {
  const request = action();
  const permit = await preflightPortableAction(request, { config }, async () => true);
  assert.equal(permit.block, false);
  if (permit.block) return;
  assert.equal(bindPiExecutionInput(request, permit).block, false);
  const prototype = Object.prototype as Record<string, unknown>;
  const before = Object.getOwnPropertyDescriptor(prototype, "workdir");
  Object.defineProperty(prototype, "workdir", { configurable: true, value: "/outside" });
  try {
    assert.equal((permit.action.input as Record<string, unknown>).workdir, undefined);
    assert.equal((request.input as Record<string, unknown>).workdir, undefined);
    assert.equal(Object.getPrototypeOf(permit.action.input), null);
    assert.equal(Object.getPrototypeOf(request.input), null);
  } finally {
    if (before) Object.defineProperty(prototype, "workdir", before);
    else Reflect.deleteProperty(prototype, "workdir");
  }
});

test("Pi binding rejects a proxy that falsely reports successful prototype detachment", async () => {
  const request = action();
  const permit = await preflightPortableAction(request, { config }, async () => true);
  assert.equal(permit.block, false);
  if (permit.block) return;
  const proxied = { ...request, input: new Proxy({ ...request.input }, {
    setPrototypeOf: () => true,
  }) };
  assert.equal(bindPiExecutionInput(proxied, permit).block, true);
  assert.equal(Object.getPrototypeOf(proxied.input), Object.prototype);
});

test("Pi binder checks nested prototype detachment despite mutated Array.prototype.every", async () => {
  const input = { path: "/tmp/example", edits: [{ oldText: "before", newText: "after" }] };
  const request: PortableAction = { ...action(), tool: "edit", input };
  const permit = await preflightPortableAction(request, { config }, async () => true);
  assert.equal(permit.block, false);
  if (permit.block) return;
  const original = Object.getOwnPropertyDescriptor(Array.prototype, "every");
  const proxied = { ...request, input: {
    ...input, edits: [new Proxy({ ...input.edits[0]! }, { setPrototypeOf: () => true })],
  } };
  Object.defineProperty(Array.prototype, "every", { configurable: true, value: () => true });
  try {
    assert.equal(bindPiExecutionInput(proxied, permit).block, true);
    assert.equal(Object.getPrototypeOf(proxied.input.edits[0]), Object.prototype);
    assert.equal(new PortableCallLedger().claim({ ...request, callId: "" }), false);
  } finally {
    if (original) Object.defineProperty(Array.prototype, "every", original);
    else Reflect.deleteProperty(Array.prototype, "every");
  }
});

test("shared ledger consumes a call ID before approval and blocks concurrent replay", async () => {
  const ledger = new PortableCallLedger();
  let promptCount = 0;
  let release: (value: boolean) => void = () => { throw Error("approval did not start"); };
  const pendingApproval = new Promise<boolean>(resolve => { release = resolve; });
  const first = preflightPortableAction(action(), { config, ledger }, async () => {
    promptCount++;
    return pendingApproval;
  });
  // Wait for the first approval prompt to start without assuming policy timing.
  for (let turn = 0; promptCount === 0 && turn < 100; turn++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(promptCount, 1);
  const replay = await preflightPortableAction(action(), { config, ledger }, async () => {
    promptCount++;
    return true;
  });
  assert.equal(replay.block, true);
  assert.match(replay.reason, /Call ID already used/);
  assert.equal(promptCount, 1);
  release(true);
  assert.equal((await first).block, false);
  assert.equal((await preflightPortableAction(action(), { config, ledger }, async () => true)).block, true);
  assert.equal((await preflightPortableAction({ ...action(), callId: "call-2" }, { config, ledger }, async () => true)).block, false);
});

test("ledger consumes declined calls and keeps host/session namespaces distinct", async () => {
  const ledger = new PortableCallLedger();
  assert.equal((await preflightPortableAction(action(), { config, ledger }, async () => false)).block, true);
  assert.equal((await preflightPortableAction(action(), { config, ledger }, async () => true)).block, true);
  assert.equal((await preflightPortableAction({ ...action(), sessionId: "session-2" }, { config, ledger }, async () => true)).block, false);
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

test("malformed policy access fails closed without prompting or escaping as an exception", async () => {
  const malformed = { get tools(): never { throw Error("malformed policy"); } } as unknown as typeof config;
  let prompted = false;
  const result = await preflightPortableAction(action(), { config: malformed }, async () => { prompted = true; return true; });
  assert.equal(result.block, true);
  assert.equal(prompted, false);
});

test("prototype executor writes only the frozen action returned by an approved permit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-warden-preflight-"));
  const path = join(directory, "probe.txt");
  try {
    const request = { ...action(), cwd: directory, tool: "write", input: { path, content: "approved" } };
    const refused = await preflightPortableAction(request, { config }, async () => false);
    assert.equal(refused.block, true);
    await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });

    const permitted = await preflightPortableAction(request, { config }, async (shown) => {
      assert.equal(shown.input.content, "approved");
      return true;
    });
    assert.equal(permitted.block, false);
    if (permitted.block) throw Error("unexpected block");
    request.input.content = "changed after approval";
    assert.equal(Object.isFrozen(permitted.action.input), true);
    // This simulates a compliant executor, NOT a real Pi/Hermes/Claude hook.
    await writeFile(permitted.action.input.path as string, permitted.action.input.content as string);
    assert.equal(await readFile(path, "utf8"), "approved");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("opt-in executor binds a real file write to the approved snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-warden-executor-"));
  const path = join(directory, "probe.txt");
  const request = { ...action(), cwd: directory, tool: "write", input: { path, content: "approved" } };
  let executions = 0;
  const execute = async (approved: Readonly<PortableAction>) => {
    executions++;
    assert.equal(Object.isFrozen(approved), true);
    assert.equal(Object.isFrozen(approved.input), true);
    await writeFile(approved.input.path as string, approved.input.content as string);
    return "written";
  };
  try {
    const headless = await executePortableAction(request, { config }, undefined, execute);
    const declined = await executePortableAction(request, { config }, async () => false, execute);
    assert.equal(headless.block, true);
    assert.equal(declined.block, true);
    assert.equal(executions, 0);
    await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });

    const approved = await executePortableAction(request, { config }, async () => {
      // A changed request cannot execute, even if the approver says yes.
      request.input.content = "changed before approval resolves";
      return true;
    }, execute);
    assert.equal(approved.block, true);
    assert.equal(executions, 0);

    request.input.content = "approved";
    const completed = await executePortableAction(request, { config }, async () => true, async (snapshot) => {
      request.input.content = "changed after approval";
      return execute(snapshot);
    });
    assert.deepEqual(completed, { block: false, result: "written" });
    assert.equal(executions, 1);
    assert.equal(await readFile(path, "utf8"), "approved");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("opt-in executor propagates failures rather than reporting a pre-execution block", async () => {
  await assert.rejects(
    executePortableAction(action(), { config }, async () => true, async () => { throw Error("tool failed"); }),
    /tool failed/,
  );
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
  const permit = await preflightPortableAction(action(), { config }, approve);
  assert.equal(permit.block, false);
  assert.equal((await preflightPortableAction(action(), { config }, approve)).block, true);
  assert.equal(approvals, 2, "approval from the first call is not cached for a second call");
});
