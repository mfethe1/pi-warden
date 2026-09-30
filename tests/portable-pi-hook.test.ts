import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { Type } from "typebox";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { defaultConfig } from "../src/config.js";
import { bindPiExecutionInput, preflightPortableAction } from "../src/portable-preflight.js";

// Offline Pi v0.87 host dispatch: faux model -> tool_call hook -> registered real file-writing tool.
const agentRoot = fileURLToPath(new URL("..", import.meta.resolve("@earendil-works/pi-coding-agent")));
const nested = join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/providers/faux.js");
const faux = await import(existsSync(nested) ? pathToFileURL(nested).href : "@earendil-works/pi-ai/providers/faux");

test("Pi tool_call denial prevents a registered host tool from writing a file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-host-hook-"));
  const path = join(dir, "probe.txt");
  let called = 0;
  let mutationBlocked = 0;
  let approved = false;
  const extension = ((pi: ExtensionAPI) => {
    pi.registerTool({
      name: "write", label: "write", description: "Writes probe file.",
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      execute: async (_id, args) => {
        called++;
        await writeFile(args.path, args.content);
        return { content: [{ type: "text", text: "written" }], details: undefined };
      },
    });
    pi.on("tool_call", async (event) => {
      const result = await preflightPortableAction({
        host: "pi", sessionId: "offline-test", callId: event.toolCallId,
        cwd: dir, task: "write the probe file", tool: event.toolName, input: event.input,
      }, { config: defaultConfig().action }, async () => approved);
      if (result.block) return { block: true, reason: result.reason };
      // Pi has no replacement-input return value. Bind its actual validated args
      // to the approved snapshot and freeze recursively before later handlers.
      const binding = bindPiExecutionInput(event.input, result);
      if (binding.block) return { block: true, reason: binding.reason };
      return undefined;
    });
    pi.on("tool_call", (event) => {
      if (event.toolName !== "write") return undefined;
      try {
        (event.input as { content: string }).content = "changed by later handler";
      } catch {
        mutationBlocked++;
      }
      return undefined;
    });
  }) as unknown as InlineExtension;
  try {
    const provider = faux.fauxProvider();
    const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(provider.provider);
    await runtime.setRuntimeApiKey(provider.provider.id, "offline");
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, "agent"), settingsManager: SettingsManager.inMemory(), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [extension] });
    await loader.reload();
    const { session } = await createAgentSession({ cwd: dir, agentDir: join(dir, "agent"), modelRuntime: runtime, model: provider.getModel(), resourceLoader: loader, sessionManager: SessionManager.inMemory(dir), settingsManager: SettingsManager.inMemory(), noTools: "builtin" });
    const run = async () => {
      provider.setResponses([faux.fauxAssistantMessage(faux.fauxToolCall("write", { path, content: "approved" })), faux.fauxAssistantMessage("Done.")]);
      await session.prompt("write the probe file");
    };
    await run();
    assert.equal(called, 0);
    await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });
    approved = true;
    await run();
    assert.equal(called, 1);
    assert.equal(mutationBlocked, 1);
    assert.equal(await readFile(path, "utf8"), "approved");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pi built-in write is blocked until its input is approved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-builtin-hook-"));
  const path = join(dir, "probe.txt");
  let approved = false;
  let mutationBlocked = 0;
  const extension = ((pi: ExtensionAPI) => {
    pi.on("tool_call", async event => {
      const permit = await preflightPortableAction({
        host: "pi", sessionId: "builtin-test", callId: event.toolCallId,
        cwd: dir, task: "write the probe file", tool: event.toolName, input: event.input,
      }, { config: defaultConfig().action }, async () => approved);
      if (permit.block) return { block: true, reason: permit.reason };
      const binding = bindPiExecutionInput(event.input, permit);
      if (binding.block) return { block: true, reason: binding.reason };
      return undefined;
    });
    pi.on("tool_call", event => {
      if (event.toolName !== "write") return undefined;
      try {
        (event.input as { content: string }).content = "tampered";
      } catch {
        mutationBlocked++;
      }
      return undefined;
    });
  }) as unknown as InlineExtension;
  try {
    const provider = faux.fauxProvider();
    const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(provider.provider);
    await runtime.setRuntimeApiKey(provider.provider.id, "offline");
    const settings = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, "agent"), settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [extension] });
    await loader.reload();
    const { session } = await createAgentSession({ cwd: dir, agentDir: join(dir, "agent"), modelRuntime: runtime, model: provider.getModel(), resourceLoader: loader, sessionManager: SessionManager.inMemory(dir), settingsManager: settings, tools: ["write"] });
    const run = async () => {
      provider.setResponses([faux.fauxAssistantMessage(faux.fauxToolCall("write", { path, content: "approved" })), faux.fauxAssistantMessage("Done.")]);
      await session.prompt("write the probe file");
    };
    await run();
    await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });
    approved = true;
    await run();
    assert.equal(mutationBlocked, 1);
    assert.equal(await readFile(path, "utf8"), "approved");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pi tool_call freezes nested edit arguments before later handlers and execution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warden-nested-hook-"));
  const path = join(dir, "probe.txt");
  let called = 0;
  let mutationBlocked = 0;
  let approved = false;
  const extension = ((pi: ExtensionAPI) => {
    pi.registerTool({
      name: "edit", label: "edit", description: "Edits probe file.",
      parameters: Type.Object({ path: Type.String(), edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })) }),
      execute: async (_id, args) => {
        called++;
        const before = await readFile(args.path, "utf8");
        await writeFile(args.path, before.replace(args.edits[0]!.oldText, args.edits[0]!.newText));
        return { content: [{ type: "text", text: "edited" }], details: undefined };
      },
    });
    pi.on("tool_call", async (event) => {
      const result = await preflightPortableAction({
        host: "pi", sessionId: "nested-test", callId: event.toolCallId,
        cwd: dir, task: "edit the probe", tool: event.toolName, input: event.input,
      }, { config: defaultConfig().action }, async () => approved);
      if (result.block) return { block: true, reason: result.reason };
      const binding = bindPiExecutionInput(event.input, result);
      if (binding.block) return { block: true, reason: binding.reason };
      return undefined;
    });
    pi.on("tool_call", event => {
      if (event.toolName !== "edit") return undefined;
      try {
        (event.input as { edits: { newText: string }[] }).edits[0]!.newText = "tampered";
      } catch {
        mutationBlocked++;
      }
      return undefined;
    });
  }) as unknown as InlineExtension;
  try {
    await writeFile(path, "before");
    const provider = faux.fauxProvider();
    const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(provider.provider);
    await runtime.setRuntimeApiKey(provider.provider.id, "offline");
    const settings = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, "agent"), settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [extension] });
    await loader.reload();
    const { session } = await createAgentSession({ cwd: dir, agentDir: join(dir, "agent"), modelRuntime: runtime, model: provider.getModel(), resourceLoader: loader, sessionManager: SessionManager.inMemory(dir), settingsManager: settings, noTools: "builtin" });
    const run = async () => {
      provider.setResponses([faux.fauxAssistantMessage(faux.fauxToolCall("edit", { path, edits: [{ oldText: "before", newText: "approved" }] })), faux.fauxAssistantMessage("Done.")]);
      await session.prompt("edit the probe");
    };
    await run();
    assert.equal(called, 0);
    assert.equal(await readFile(path, "utf8"), "before");
    approved = true;
    await run();
    assert.equal(called, 1);
    assert.equal(mutationBlocked, 1);
    assert.equal(await readFile(path, "utf8"), "approved");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
