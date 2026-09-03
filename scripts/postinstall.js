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
  "gemini-3.8-flash": {
    name: "Gemini 3.8 Flash",
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  },
  "gemini-3.8-flash-tiered": {
    name: "Gemini 3.8 Flash Tiered",
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  },
  "gemini-3.7-flash": {
    name: "Gemini 3.7 Flash",
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  },
  "gemini-3.7-flash-tiered": {
    name: "Gemini 3.7 Flash Tiered",
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  },
  "gemini-3.6-flash-high": {
    name: "Gemini 3.6 Flash High",
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  },
  "gemini-3.6-flash-medium": {
    name: "Gemini 3.6 Flash Medium",
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  },
  "gemini-3.6-flash-low": {
    name: "Gemini 3.6 Flash Low",
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  },
  "gemini-pro-agent": {
    name: "Gemini 3.1 Pro Agent",
    limit: { context: 1048576, output: 65535 },
    modalities: DEFAULT_MODALITIES,
  },
  "gemini-3.1-pro-low": {
    name: "Gemini 3.1 Pro Low",
    limit: { context: 1048576, output: 65535 },
    modalities: DEFAULT_MODALITIES,
  },
  "gemini-3-flash-agent": {
    name: "Gemini 3.5 Flash Agent",
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  },
  "claude-sonnet-4-6": {
    name: "Claude Sonnet 4.6",
    limit: { context: 200000, output: 64000 },
    modalities: DEFAULT_MODALITIES,
  },
  "claude-opus-4-6-thinking": {
    name: "Claude Opus 4.6 Thinking",
    limit: { context: 200000, output: 64000 },
    modalities: DEFAULT_MODALITIES,
  },
  "gpt-oss-120b-medium": {
    name: "GPT-OSS 120B Medium",
    limit: { context: 131072, output: 32768 },
    modalities: DEFAULT_MODALITIES,
  },
  "gemini-2.5-pro": {
    name: "Gemini 2.5 Pro",
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  },
  "gemini-2.5-flash": {
    name: "Gemini 2.5 Flash",
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  },
};

async function readConfig() {
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = await readFile(CONFIG_PATH, "utf-8");
      return JSON.parse(raw);
    } catch {}
  }
  return {
    $schema: "https://opencode.ai/config.json",
    plugin: ["superoc"],
    provider: {},
  };
}

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

  const config = await readConfig();

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

  // Clean up any legacy antigravity models from google provider
  if (config.provider?.google?.models) {
    for (const key of Object.keys(config.provider.google.models)) {
      if (key.startsWith("antigravity-")) {
        delete config.provider.google.models[key];
      }
    }
    if (Object.keys(config.provider.google.models).length === 0) {
      delete config.provider.google.models;
    }
    if (Object.keys(config.provider.google).length === 0) {
      delete config.provider.google;
    }
  }

  config.provider = config.provider || {};
  config.provider.antigravity = {
    name: "Antigravity",
    npm: "@ai-sdk/google",
    api: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "antigravity-oauth",
    models: BASE_ANTIGRAVITY_MODELS,
  };

  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });

  // Ensure superoc package is registered in OpenCode's config directory so OpenCode loads the plugin
  try {
    const configDir = path.dirname(CONFIG_PATH);
    const opencodePkgPath = path.join(configDir, "package.json");
    let opencodePkg = {};
    if (fs.existsSync(opencodePkgPath)) {
      try {
        opencodePkg = JSON.parse(fs.readFileSync(opencodePkgPath, "utf-8"));
      } catch {}
    }
    opencodePkg.dependencies = opencodePkg.dependencies || {};
    opencodePkg.dependencies.superoc = "^0.1.17";
    fs.writeFileSync(opencodePkgPath, JSON.stringify(opencodePkg, null, 2) + "\n");

    const targetModuleDir = path.join(configDir, "node_modules", "superoc");
    const localDist = path.join(__dirname, "..", "dist");
    if (fs.existsSync(localDist)) {
      const targetDist = path.join(targetModuleDir, "dist");
      fs.mkdirSync(targetDist, { recursive: true });
      fs.cpSync(localDist, targetDist, { recursive: true });
    }
  } catch {}

  // Sync credentials in OpenCode auth.json
  try {
    const localShare = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
    const authPath = path.join(localShare, "opencode", "auth.json");
    if (!fs.existsSync(path.dirname(authPath))) fs.mkdirSync(path.dirname(authPath), { recursive: true });
    let authData = {};
    if (fs.existsSync(authPath)) {
      try {
        authData = JSON.parse(fs.readFileSync(authPath, "utf-8"));
      } catch {}
    }
    if (!authData.antigravity) {
      authData.antigravity = { type: "api", key: "antigravity-oauth" };
      fs.writeFileSync(authPath, JSON.stringify(authData, null, 2) + "\n", "utf-8");
    }
  } catch {}

  console.log("Updated OpenCode config with Antigravity provider & models");
  console.log("\nNext steps:");
  console.log("  1. Run: superoc  (to manage your API keys & accounts)");
  console.log("  2. Connect your providers via the TUI");
  console.log("  3. Start OpenCode - superoc will auto-rotate your keys & accounts\n");
}

await install().catch(function (err) {
  console.error("Installation failed:", err);
  process.exit(1);
});
