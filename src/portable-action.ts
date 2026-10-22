import { defaultConfig } from "./config.js";
import type { ActionGuardConfig } from "./config.js";
import { plainData } from "./portable-plain-data.js";
import { evaluateAction } from "./guard.js";
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
function knownFields(tool: string, input: Record<string, unknown>): boolean {
  const permitted = TOOL_FIELDS[tool];
  return !!permitted && Object.keys(input).every(key => permitted.includes(key));
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Explicit tool mapping; unknown tools are never assumed read-only. */
function normalize(tool: string, input: Record<string, unknown>): { tool: string; input: Record<string, unknown> } | undefined {
  if (["bash", "Bash", "functions.terminal"].includes(tool)) {
    if (!nonempty(input.command)) return undefined;
    return { tool: "bash", input: { command: input.command } };
  }
  // Arbitrary Python/JS code execution has no sound shell-command mapping.
  // Until a host-specific adapter can inspect its effects, deny it here.
  if (["write", "Write", "functions.write_file"].includes(tool)) {
    const path = input.path ?? input.file_path;
    if (!nonempty(path) || typeof input.content !== "string") return undefined;
    return { tool: "write", input: { path, content: input.content } };
  }
  if (["edit", "Edit", "functions.patch"].includes(tool)) {
    if (tool === "functions.patch" && input.mode !== "replace") return undefined;
    const path = input.path ?? input.file_path;
    if (!nonempty(path)) return undefined;
    if (tool === "edit") {
      if (!Array.isArray(input.edits) || input.edits.length === 0 || input.edits.length > 3
          || !input.edits.every(item => item && typeof item === "object" && !Array.isArray(item)
            && Object.keys(item).every(key => key === "oldText" || key === "newText")
            && nonempty(item.oldText) && typeof item.newText === "string")) return undefined;
      return { tool: "edit", input: { path, edits: input.edits } };
    }
    if (!nonempty(input.old_string) || typeof input.new_string !== "string"
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
  if (!Object.keys(action).every(key => ["host", "sessionId", "callId", "cwd", "task", "tool", "input"].includes(key))) {
    return reject("Unrecognized action-envelope field; cannot discard effect-bearing context");
  }
  if (![action.host, action.sessionId, action.callId, action.task, action.tool].every(nonempty)
      || !nonempty(action.cwd) || !action.cwd.startsWith("/")
      || !action.input || typeof action.input !== "object" || Array.isArray(action.input)) {
    return reject("Invalid action envelope; cannot establish origin or scope");
  }
  if (!Object.hasOwn(HOST_TOOLS, action.host) || !HOST_TOOLS[action.host]?.includes(action.tool)) {
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

/** Require every configuration field, including nested thresholds, before spreading policy. */
function completeShape(value: unknown, template: unknown): boolean {
  if (Array.isArray(template)) return Array.isArray(value);
  if (template !== null && typeof template === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    return Object.entries(template).every(([key, expected]) => Object.hasOwn(value, key)
      && completeShape((value as Record<string, unknown>)[key], expected));
  }
  return typeof value === typeof template;
}

/** Fail closed even when host-supplied data is malformed or throws on access. */
export async function evaluatePortableAction(action: PortableAction, options: { config: ActionGuardConfig }): Promise<PortableDecision> {
  try {
    if (!plainData(action) || !plainData(options)
        || !completeShape(options?.config, defaultConfig().action)) {
      return reject("Malformed action or incomplete policy; action was not authorized");
    }
    return await evaluatePortableActionUnchecked(action, options);
  } catch {
    return reject("Malformed action or policy; action was not authorized");
  }
}
