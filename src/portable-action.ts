import type { ActionGuardConfig } from "./config.js";
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
const HOST_TOOLS: Record<string, readonly string[]> = {
  pi: ["bash", "write", "edit"],
  hermes: ["functions.terminal", "functions.write_file", "functions.patch"],
  claude: ["Bash", "Write", "Edit"],
};

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
          || !input.edits.every(item => item && typeof item === "object" && nonempty(item.oldText) && typeof item.newText === "string")) return undefined;
      return { tool: "edit", input: { path, edits: input.edits } };
    }
    if (!nonempty(input.old_string) || typeof input.new_string !== "string" || input.replace_all === true) return undefined;
    return { tool: "edit", input: { path, edits: [{ oldText: input.old_string, newText: input.new_string }] } };
  }
  return undefined;
}

/** Pure policy boundary for host integrations; does not itself install hooks. */
export async function evaluatePortableAction(action: PortableAction, options: { config: ActionGuardConfig }): Promise<PortableDecision> {
  if (![action.host, action.sessionId, action.callId, action.task, action.tool].every(nonempty)
      || !nonempty(action.cwd) || !action.cwd.startsWith("/")
      || !action.input || typeof action.input !== "object" || Array.isArray(action.input)) {
    return reject("Invalid action envelope; cannot establish origin or scope");
  }
  if (!HOST_TOOLS[action.host]?.includes(action.tool)) {
    return reject("Unverified host/tool contract; this adapter cannot promise pre-execution coverage");
  }
  if (typeof action.input.workdir === "string" && action.input.workdir !== action.cwd) {
    return reject("Action working directory differs from policy working directory");
  }
  const mapped = normalize(action.tool, action.input);
  if (!mapped) return reject("Unknown tool or missing effect-bearing fields; no safe policy mapping");
  // Do not let a host-provided tool allowlist disable a mapped tool by accident.
  const config = { ...options.config, enabled: true, tools: [...new Set([...options.config.tools, mapped.tool])], failOpen: false };
  try {
    const verdict = await evaluateAction({ ...mapped, cwd: action.cwd, task: action.task }, { config });
    // A portable adapter cannot assume the host's "warn" is an enforcement
    // boundary. Recursive removal needs an explicit hold even if Pi's local
    // policy only warns on in-project paths. Never downgrade a stronger verdict.
    const recursiveRemoval = verdict.patterns.some(hit => hit.id === "rm-rf" || hit.id === "rm-recursive");
    const level = recursiveRemoval && (verdict.level === "allow" || verdict.level === "warn") ? "confirm" : verdict.level;
    return { level, intercepted: true, reason: verdict.reasons.join("; "), verdict };
  } catch {
    return reject("Policy evaluation failed; action was not authorized");
  }
}
