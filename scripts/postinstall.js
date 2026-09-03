#!/usr/bin/env node

import { join } from "path";
import { homedir } from "os";
import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";

const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
const CONFIG_DIR = join(xdgConfig, "opencode");
const jsoncPath = join(CONFIG_DIR, "opencode.jsonc");
const jsonPath = join(CONFIG_DIR, "opencode.json");
const CONFIG_PATH = existsSync(jsoncPath) ? jsoncPath : jsonPath;

const DEFAULT_MODALITIES = {
  input: ["text", "image", "pdf"],
  output: ["text"],
};

const BASE_ANTIGRAVITY_MODELS = {
  "antigravity-gemini-3.8-flash": {
    name: "Gemini 3.8 Flash (Antigravity)",
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  },
  "antigravity-gemini-3.8-flash-tiered": {
    name: "Gemini 3.8 Flash Tiered (Antigravity)",
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  },
  "antigravity-gemini-3.7-flash": {
    name: "Gemini 3.7 Flash (Antigravity)",
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  },
  "antigravity-gemini-3.7-flash-tiered": {
    name: "Gemini 3.7 Flash Tiered (Antigravity)",
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  },
  "antigravity-gemini-3.6-flash-high": {
    name: "Gemini 3.6 Flash High (Antigravity)",
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  },
  "antigravity-gemini-3.6-flash-medium": {
    name: "Gemini 3.6 Flash Medium (Antigravity)",
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  },
  "antigravity-gemini-3.6-flash-low": {
    name: "Gemini 3.6 Flash Low (Antigravity)",
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  },
  "antigravity-gemini-pro-agent": {
    name: "Gemini 3.1 Pro Agent (Antigravity)",
    limit: { context: 1048576, output: 65535 },
    modalities: DEFAULT_MODALITIES,
  },
  "antigravity-gemini-3.1-pro-low": {
    name: "Gemini 3.1 Pro Low (Antigravity)",
    limit: { context: 1048576, output: 65535 },
    modalities: DEFAULT_MODALITIES,
  },
  "antigravity-gemini-3-flash-agent": {
    name: "Gemini 3.5 Flash Agent (Antigravity)",
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  },
  "antigravity-claude-sonnet-4-6": {
    name: "Claude Sonnet 4.6 (Antigravity)",
    limit: { context: 200000, output: 64000 },
    modalities: DEFAULT_MODALITIES,
  },
  "antigravity-claude-opus-4-6-thinking": {
    name: "Claude Opus 4.6 Thinking (Antigravity)",
    limit: { context: 200000, output: 64000 },
    modalities: DEFAULT_MODALITIES,
  },
  "antigravity-gpt-oss-120b-medium": {
    name: "GPT-OSS 120B Medium (Antigravity)",
    limit: { context: 131072, output: 32768 },
    modalities: DEFAULT_MODALITIES,
  },
  "antigravity-gemini-2.5-pro": {
    name: "Gemini 2.5 Pro (Antigravity)",
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  },
  "antigravity-gemini-2.5-flash": {
    name: "Gemini 2.5 Flash (Antigravity)",
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  },
};

async function install() {
  console.log(
    "\n+=============================================================+",
  );
  console.log("|  superoc - Installer                                        |");
  console.log(
    "+=============================================================+\n",
  );

  try {
    await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }

  let config = {
    $schema: "https://opencode.ai/config.json",
    plugin: ["superoc"],
    provider: { google: { models: {} } },
  };

  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = await readFile(CONFIG_PATH, "utf-8");
      config = JSON.parse(raw);
    } catch {}
  }

  config.plugin = config.plugin || [];
  // Clean up legacy "nimsuper" entry if present
  config.plugin = config.plugin.filter(function (p) {
    if (typeof p === "string") return p !== "nimsuper";
    if (Array.isArray(p)) return p[0] !== "nimsuper";
    return true;
  });

  const hasPlugin = config.plugin.some(function (p) {
    if (typeof p === "string") return p === "superoc";
    if (Array.isArray(p)) return p[0] === "superoc";
    return false;
  });

  if (!hasPlugin) {
    config.plugin.push("superoc");
  }

  if (!config.provider || typeof config.provider !== "object") {
    config.provider = {};
  }
  if (!config.provider.google || typeof config.provider.google !== "object") {
    config.provider.google = {};
  }
  if (!config.provider.google.models || typeof config.provider.google.models !== "object") {
    config.provider.google.models = {};
  }

  // Populate models
  for (const [id, modelDef] of Object.entries(BASE_ANTIGRAVITY_MODELS)) {
    if (!config.provider.google.models[id]) {
      config.provider.google.models[id] = modelDef;
    }
  }

  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });

  console.log("Updated OpenCode config with superoc plugin and Antigravity models");
  console.log("\nNext steps:");
  console.log("  1. Run: superoc  (to manage your API keys & accounts)");
  console.log("  2. Connect your providers via the TUI");
  console.log("  3. Start OpenCode - superoc will auto-rotate your keys & accounts\n");
}

await install().catch(function (err) {
  console.error("Installation failed:", err);
  process.exit(1);
});
