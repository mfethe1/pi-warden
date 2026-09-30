import { defaultConfig, parseDuration } from "./config.js";
import { plainData } from "./portable-plain-data.js";
import { EXEMPTABLE_IDS } from "./guard.js";

function uniqueRuleIds(v: Record<string, unknown>): boolean {
  const seen = new Set(EXEMPTABLE_IDS);
  for (const key of ["commandRules", "commandDenyRules", "pathRules", "armingRules"]) {
    for (const rule of v[key] as Record<string, unknown>[]) {
      const id = rule.id as string;
      if (seen.has(id)) return false;
      seen.add(id);
    }
  }
  return true;
}
const surfaces = ["*", "read", "write", "edit", "bash", "exec", "shell", "run"];
const selected = (v: unknown, allowed: string[]) => list(v, x => oneOf(x, allowed)) && (v as unknown[]).length > 0;

const own = Object.hasOwn;
const keys = Object.keys;
const probability = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function list(v: unknown, check: (v: unknown) => boolean): boolean {
  if (!Array.isArray(v)) return false;
  for (let i = 0; i < v.length; i++) if (!check(v[i])) return false;
  return true;
}
const strings = (v: unknown) => list(v, text);
const oneOf = (v: unknown, values: string[]) => typeof v === "string" && values.includes(v);
function fields(v: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  for (const k of required) if (!own(v, k)) return false;
  for (const k of keys(v)) if (!required.includes(k) && !optional.includes(k)) return false;
  return true;
}
function optional(v: Record<string, unknown>, k: string, check: (v: unknown) => boolean): boolean {
  return !own(v, k) || check(v[k]);
}
function regex(v: unknown): boolean {
  if (!text(v)) return false;
  try { new RegExp(v); return true; } catch { return false; }
}
function command(v: unknown): boolean {
  return record(v) && fields(v, ["id", "pattern", "severity"], ["action", "message", "caseSensitive"])
    && text(v.id) && regex(v.pattern) && oneOf(v.severity, ["warn", "confirm", "deny"])
    && optional(v, "action", x => oneOf(x, ["dialog", "hold"]))
    && optional(v, "message", x => typeof x === "string") && optional(v, "caseSensitive", x => typeof x === "boolean");
}
function paths(v: Record<string, unknown>, key: string): boolean {
  return strings(v[key]) && (v[key] as unknown[]).length > 0
    && optional(v, "regex", x => typeof x === "boolean") && (v.regex !== true || list(v[key], regex));
}
function pathRule(v: unknown): boolean {
  return record(v) && fields(v, ["id", "paths", "access", "tools", "action"], ["regex", "message", "onlyIfExists"])
    && text(v.id) && paths(v, "paths") && selected(v.tools, surfaces)
    && oneOf(v.access, ["none", "read", "write"]) && oneOf(v.action, ["note", "warn", "confirm", "block"])
    && optional(v, "message", x => typeof x === "string") && optional(v, "onlyIfExists", x => typeof x === "boolean");
}
function arming(v: unknown): boolean {
  if (!record(v) || !fields(v, ["id", "when", "arms", "action"], ["message"]) || !text(v.id)
      || !record(v.when) || !record(v.arms)) return false;
  return fields(v.when, ["edited"], ["regex", "tools"]) && paths(v.when, "edited")
    && optional(v.when, "tools", x => selected(x, ["write", "edit"])) && fields(v.arms, ["command"], ["for", "caseSensitive"])
    && regex(v.arms.command) && optional(v.arms, "for", x => Number.isFinite(parseDuration(x, NaN)))
    && optional(v.arms, "caseSensitive", x => typeof x === "boolean")
    && oneOf(v.action, ["confirm", "hold", "block"]) && optional(v, "message", x => typeof x === "string");
}
function threshold(v: unknown, second: string): boolean {
  return record(v) && fields(v, ["warn", second]) && probability(v.warn) && probability(v[second])
    && (v.warn as number) <= (v[second] as number);
}
/** Portable ingress accepts a complete, strictly typed policy, never silently skipped malformed rules. */
export function validPortablePolicy(v: unknown): boolean {
  if (!plainData(v) || !record(v) || !fields(v, keys(defaultConfig().action))) return false;
  return typeof v.enabled === "boolean" && typeof v.failOpen === "boolean" && typeof v.feedbackLog === "boolean"
    && strings(v.tools) && strings(v.exemptRules) && typeof v.timeoutMs === "number" && Number.isInteger(v.timeoutMs) && v.timeoutMs >= 1 && v.timeoutMs <= 2_147_483_647
    && threshold(v.irreversible, "confirm") && threshold(v.offTask, "steer")
    && probability(v.intentMismatch) && probability(v.visibleMismatch) && (v.visibleMismatch as number) <= (v.intentMismatch as number) && probability(v.escalationThreshold)
    && oneOf(v.intentTraceOnly, ["invisible", "all", "none"]) && oneOf(v.floor, ["evidence", "level"])
    && record(v.shouldProceed) && fields(v.shouldProceed, ["threshold", "steer"])
    && probability(v.shouldProceed.threshold) && typeof v.shouldProceed.steer === "boolean"
    && list(v.commandRules, command) && list(v.commandDenyRules, command)
    && list(v.pathRules, pathRule) && list(v.armingRules, arming) && uniqueRuleIds(v);
}
