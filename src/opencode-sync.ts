import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { FallbackModel } from "./types.js";
import { PROXY_BASE_URL } from "./proxy.js";

const DEFAULT_MODALITIES = {
  input: ["text", "image", "pdf"],
  output: ["text"],
};

const DEFAULT_CAPABILITIES = {
  tools: true,
  input: ["text", "image", "pdf"],
  output: ["text"],
};

export function getOpencodeConfigPath(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const configDir = join(xdgConfig, "opencode");
  const jsoncPath = join(configDir, "opencode.jsonc");
  const jsonPath = join(configDir, "opencode.json");
  if (existsSync(jsoncPath)) return jsoncPath;
  return jsonPath;
}

export const BASE_ANTIGRAVITY_MODELS: Record<string, any> = {
  "gemini-3.8-flash": {
    name: "Gemini 3.8 Flash",
    limit: { context: 1048576, output: 65536 },
    capabilities: DEFAULT_CAPABILITIES,
    modalities: DEFAULT_MODALITIES,
  },
  "gemini-3.8-flash-tiered": {
    name: "Gemini 3.8 Flash Tiered",
    limit: { context: 1048576, output: 65536 },
    capabilities: DEFAULT_CAPABILITIES,
    modalities: DEFAULT_MODALITIES,
  },
  "gemini-3.7-flash": {
    name: "Gemini 3.7 Flash",
    limit: { context: 1048576, output: 65536 },
    capabilities: DEFAULT_CAPABILITIES,
    modalities: DEFAULT_MODALITIES,
  },
  "gemini-3.7-flash-tiered": {
    name: "Gemini 3.7 Flash Tiered",
    limit: { context: 1048576, output: 65536 },
    capabilities: DEFAULT_CAPABILITIES,
    modalities: DEFAULT_MODALITIES,
  },
  "gemini-3.6-flash-high": {
    name: "Gemini 3.6 Flash High",
    limit: { context: 1048576, output: 65536 },
    capabilities: DEFAULT_CAPABILITIES,
    modalities: DEFAULT_MODALITIES,
  },
  "gemini-3.6-flash-medium": {
    name: "Gemini 3.6 Flash Medium",
    limit: { context: 1048576, output: 65536 },
    capabilities: DEFAULT_CAPABILITIES,
    modalities: DEFAULT_MODALITIES,
  },
  "gemini-3.6-flash-low": {
    name: "Gemini 3.6 Flash Low",
    limit: { context: 1048576, output: 65536 },
    capabilities: DEFAULT_CAPABILITIES,
    modalities: DEFAULT_MODALITIES,
  },
  "gemini-pro-agent": {
    name: "Gemini 3.1 Pro Agent",
    limit: { context: 1048576, output: 65535 },
    capabilities: DEFAULT_CAPABILITIES,
    modalities: DEFAULT_MODALITIES,
  },
  "gemini-3.1-pro-low": {
    name: "Gemini 3.1 Pro Low",
    limit: { context: 1048576, output: 65535 },
    capabilities: DEFAULT_CAPABILITIES,
    modalities: DEFAULT_MODALITIES,
  },
  "gemini-3-flash-agent": {
    name: "Gemini 3.5 Flash Agent",
    limit: { context: 1048576, output: 65536 },
    capabilities: DEFAULT_CAPABILITIES,
    modalities: DEFAULT_MODALITIES,
  },
  "claude-sonnet-4-6": {
    name: "Claude Sonnet 4.6",
    limit: { context: 1048576, output: 64000 },
    capabilities: DEFAULT_CAPABILITIES,
    modalities: DEFAULT_MODALITIES,
  },
  "claude-opus-4-6-thinking": {
    name: "Claude Opus 4.6 Thinking",
    limit: { context: 1048576, output: 128000 },
    capabilities: DEFAULT_CAPABILITIES,
    modalities: DEFAULT_MODALITIES,
  },
  "gpt-oss-120b-medium": {
    name: "GPT-OSS 120B Medium",
    limit: { context: 131072, output: 32768 },
    capabilities: DEFAULT_CAPABILITIES,
    modalities: DEFAULT_MODALITIES,
  },
  "gemini-2.5-pro": {
    name: "Gemini 2.5 Pro",
    limit: { context: 1048576, output: 65536 },
    capabilities: DEFAULT_CAPABILITIES,
    modalities: DEFAULT_MODALITIES,
  },
  "gemini-2.5-flash": {
    name: "Gemini 2.5 Flash",
    limit: { context: 1048576, output: 65536 },
    capabilities: DEFAULT_CAPABILITIES,
    modalities: DEFAULT_MODALITIES,
  },
};

export function syncOpencodeModels(customModels?: Array<{ id: string; name: string }>): {
  success: boolean;
  configPath: string;
  count: number;
  error?: string;
} {
  const configPath = getOpencodeConfigPath();
  try {
    let config: Record<string, any> = {
      $schema: "https://opencode.ai/config.json",
      plugins: ["superoc"],
      plugin: ["superoc"],
      providers: {},
      provider: {},
    };

    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, "utf-8");
      try {
        config = JSON.parse(raw);
      } catch {}
    }

    // Ensure plugin array in both v1 (plugin) and v2 (plugins) format
    if (!Array.isArray(config.plugins)) {
      config.plugins = Array.isArray(config.plugin) ? [...config.plugin] : [];
    }
    if (!config.plugins.includes("superoc")) {
      config.plugins.push("superoc");
    }
    if (!Array.isArray(config.plugin)) config.plugin = [];
    if (!config.plugin.includes("superoc")) {
      config.plugin.push("superoc");
    }

    if (!config.permission || typeof config.permission !== "object") {
      config.permission = {};
    }
    if (!config.permission.websearch) {
      config.permission.websearch = "allow";
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
    if (config.providers?.google?.models) {
      for (const key of Object.keys(config.providers.google.models)) {
        if (key.startsWith("antigravity-")) {
          delete config.providers.google.models[key];
        }
      }
    }

    const modelsMap: Record<string, any> = { ...BASE_ANTIGRAVITY_MODELS };

    if (customModels && Array.isArray(customModels)) {
      for (const m of customModels) {
        const cleanId = m.id.replace(/^antigravity-/, "");
        if (!modelsMap[cleanId]) {
          modelsMap[cleanId] = {
            name: m.name,
            limit: { context: 1048576, output: 65536 },
            capabilities: DEFAULT_CAPABILITIES,
            modalities: DEFAULT_MODALITIES,
          };
        }
      }
    }

    // OpenCode v2 provider structure
    if (!config.providers) config.providers = {};
    config.providers.antigravity = {
      name: "Antigravity",
      package: "aisdk:@ai-sdk/google",
      settings: {
        baseURL: PROXY_BASE_URL,
      },
      models: modelsMap,
    };

    // OpenCode v1 provider structure
    if (!config.provider) config.provider = {};
    config.provider.antigravity = {
      name: "Antigravity",
      npm: "@ai-sdk/google",
      api: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "antigravity-oauth",
      models: modelsMap,
    };

    const dir = dirname(configPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    // Automatically register credentials in OpenCode auth.json so @ai-sdk/google never throws missing key
    syncOpencodeAuth();

    // Ensure OpenCode auto-discovers the plugin in ~/.config/opencode/plugins/superoc.js
    syncOpencodePluginFile();

    return {
      success: true,
      configPath,
      count: Object.keys(modelsMap).length,
    };
  } catch (err) {
    return {
      success: false,
      configPath,
      count: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function syncOpencodeAuth(): void {
  const localShare = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const authPath = join(localShare, "opencode", "auth.json");
  try {
    const dir = dirname(authPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    let data: Record<string, any> = {};
    if (existsSync(authPath)) {
      try {
        data = JSON.parse(readFileSync(authPath, "utf-8"));
      } catch {}
    }
    if (!data.antigravity) {
      data.antigravity = { type: "api", key: "antigravity-oauth" };
      writeFileSync(authPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
    }
  } catch {}
}

export function syncOpencodePluginFile(): void {
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const pluginsDir = join(xdgConfig, "opencode", "plugins");
  const pluginFile = join(pluginsDir, "superoc.js");
  try {
    if (!existsSync(pluginsDir)) mkdirSync(pluginsDir, { recursive: true });
    const content = `import plugin from "superoc";\nexport default plugin;\n`;
    writeFileSync(pluginFile, content, "utf-8");
  } catch {}
}
