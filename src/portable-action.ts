import type { ActionGuardConfig } from "./config.js";
import { evaluateAction } from "./guard.js";
import { plainData } from "./portable-plain-data.js";
import type { Level, Verdict } from "./guard.js";

/** Host-neutral, pre-execution request. Adapters must only call this before a tool executes. */
export interface PortableAction {
  host: string;
  sessionId: string;
  callId: string;
  cwd: string;
  task: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface PortableDecision {
  level: Level;
  /** False means no policy was run; the adapter MUST block rather than execute. */
  intercepted: boolean;
  reason: string;
  verdict?: Verdict;
}

const reject = (reason: string): PortableDecision => ({ level: "deny", intercepted: false, reason });
// A later same-process replacement must not hide effect-bearing fields.
const ownKeys = Object.keys;

/** Tool names are host-specific. ChatGPT integrations need a verified hook contract first. */
const HOST_TOOLS: Readonly<Record<string, readonly string[]>> = {
  pi: ["bash", "write", "edit"],
  hermes: ["functions.terminal", "functions.write_file", "functions.patch"],
  claude: ["Bash", "Write", "Edit"],
};

const TOOL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  // Timeouts are deliberately unsupported: the guard cannot show their execution effect to an approver.
  bash: ["command"], Bash: ["command"], "functions.terminal": ["command", "workdir"],
  write: ["path", "content"], Write: ["file_path", "content"], "functions.write_file": ["path", "content"],
  edit: ["path", "edits"], Edit: ["file_path", "old_string", "new_string", "replace_all"],
  "functions.patch": ["mode", "path", "old_string", "new_string", "replace_all"],
};

/** Reject unexamined fields: a host may add an effectful option in a later release. */
function contains(values: readonly string[], candidate: string): boolean {
  for (let index = 0; index < values.length; index++) {
    if (values[index] === candidate) return true;
  }
  return false;
}

function knownFields(tool: string, input: Record<string, unknown>): boolean {
  const permitted = TOOL_FIELDS[tool];
  if (!permitted) return false;
  const keys = ownKeys(input);
  for (let index = 0; index < keys.length; index++) {
    if (!contains(permitted, keys[index]!)) return false;
  }
  return true;
}

function validEdits(edits: unknown): edits is { oldText: string; newText: string }[] {
  if (!Array.isArray(edits) || edits.length === 0 || edits.length > 3) return false;
  for (let index = 0; index < edits.length; index++) {
    const item = edits[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const keys = ownKeys(item);
    for (let field = 0; field < keys.length; field++) {
      if (keys[field] !== "oldText" && keys[field] !== "newText") return false;
    }
    if (!Object.hasOwn(item, "oldText") || !nonempty(item.oldText)
        || !Object.hasOwn(item, "newText") || typeof item.newText !== "string") return false;
  }
  return true;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function ownNonempty(input: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(input, key) && nonempty(input[key]);
}

function ownPath(input: Record<string, unknown>): unknown {
  return Object.hasOwn(input, "path") ? input.path : Object.hasOwn(input, "file_path") ? input.file_path : undefined;
}

/** Explicit tool mapping; unknown tools are never assumed read-only. */
function normalize(tool: string, input: Record<string, unknown>): { tool: string; input: Record<string, unknown> } | undefined {
  if (contains(["bash", "Bash", "functions.terminal"], tool)) {
    if (!ownNonempty(input, "command")) return undefined;
    return { tool: "bash", input: { command: input.command } };
  }
  // Arbitrary Python/JS code execution has no sound shell-command mapping.
  // Until a host-specific adapter can inspect its effects, deny it here.
  if (contains(["write", "Write", "functions.write_file"], tool)) {
    const path = ownPath(input);
    if (!nonempty(path) || !Object.hasOwn(input, "content") || typeof input.content !== "string") return undefined;
    return { tool: "write", input: { path, content: input.content } };
  }
  if (contains(["edit", "Edit", "functions.patch"], tool)) {
    if (tool === "functions.patch" && (!Object.hasOwn(input, "mode") || input.mode !== "replace")) return undefined;
    const path = ownPath(input);
    if (!nonempty(path)) return undefined;
    if (tool === "edit") {
      if (!Object.hasOwn(input, "edits") || !validEdits(input.edits)) return undefined;
      return { tool: "edit", input: { path, edits: input.edits } };
    }
    if (!ownNonempty(input, "old_string") || !Object.hasOwn(input, "new_string")
        || typeof input.new_string !== "string"
        || (Object.hasOwn(input, "replace_all") && input.replace_all !== false)) return undefined;
    return { tool: "edit", input: { path, edits: [{ oldText: input.old_string, newText: input.new_string }] } };
  }
  return undefined;
}

/** Pure policy boundary for host integrations; does not itself install hooks. */
async function evaluatePortableActionUnchecked(action: PortableAction, options: { config: ActionGuardConfig }): Promise<PortableDecision> {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    return reject("Invalid action envelope; cannot establish origin or scope");
  }
  if (!plainData(action)) {
    return reject("Invalid action envelope; hidden or non-data fields cannot be inspected");
  }
  const required = ["host", "sessionId", "callId", "cwd", "task", "tool", "input"];
  const actionKeys = ownKeys(action);
  for (let index = 0; index < actionKeys.length; index++) {
    if (!contains(required, actionKeys[index]!)) return reject("Unrecognized action-envelope field; cannot discard effect-bearing context");
  }
  for (let index = 0; index < required.length; index++) {
    if (!Object.hasOwn(action, required[index]!)) return reject("Invalid action envelope; cannot establish origin or scope");
  }
  if (!nonempty(action.host) || !nonempty(action.sessionId) || !nonempty(action.callId)
      || !nonempty(action.task) || !nonempty(action.tool)
      || !nonempty(action.cwd) || !action.cwd.startsWith("/")
      || !action.input || typeof action.input !== "object" || Array.isArray(action.input)) {
    return reject("Invalid action envelope; cannot establish origin or scope");
  }
  const hostTools = Object.hasOwn(HOST_TOOLS, action.host) ? HOST_TOOLS[action.host] : undefined;
  if (!hostTools || !contains(hostTools, action.tool)) {
    return reject("Unverified host/tool contract; this adapter cannot promise pre-execution coverage");
  }
  if (!knownFields(action.tool, action.input)) {
    return reject("Unrecognized tool option; cannot discard a potentially effect-bearing field");
  }
  if (Object.hasOwn(action.input, "workdir") && action.input.workdir !== action.cwd) {
    return reject("Action working directory differs from policy working directory");
  }
  const mapped = normalize(action.tool, action.input);
  if (!mapped) return reject("Unknown tool or missing effect-bearing fields; no safe policy mapping");
  if (!options?.config || typeof options.config !== "object" || !Array.isArray(options.config.tools)) {
    return reject("Invalid policy configuration; action was not authorized");
  }
  // Do not let a host-provided tool allowlist disable a mapped tool by accident.
  const config = { ...options.config, enabled: true, tools: [...new Set([...options.config.tools, mapped.tool])], failOpen: false };
  try {
    const verdict = await evaluateAction({ ...mapped, cwd: action.cwd, task: action.task }, { config });
    // The offline guard recognizes only a subset of shell semantics and uses
    // lexical (not effective/symlink-resolved) paths. Until adapters prove
    // execution semantics and approval binding, no mapped shell/write/edit
    // operation may be silently allowed. Preserve stronger deny verdicts.
    const level = verdict.level === "deny" ? "deny" : "confirm";
    const reason = ["Portable policy requires action-scoped approval for every effectful call", ...verdict.reasons].join("; ");
    return { level, intercepted: true, reason, verdict };
  } catch {
    return reject("Policy evaluation failed; action was not authorized");
  }
}

/** Fail closed even when host-supplied options are malformed or throw on access. */
export async function evaluatePortableAction(action: PortableAction, options: { config: ActionGuardConfig }): Promise<PortableDecision> {
  try {
    return await evaluatePortableActionUnchecked(action, options);
  } catch {
    return reject("Malformed action or policy; action was not authorized");
  }
}
