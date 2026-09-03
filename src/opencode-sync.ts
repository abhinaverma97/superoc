import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { FallbackModel } from "./types.js";

const DEFAULT_MODALITIES = {
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

export function syncOpencodeModels(customModels?: FallbackModel[]): {
  success: boolean;
  configPath: string;
  count: number;
  error?: string;
} {
  const configPath = getOpencodeConfigPath();
  try {
    let config: Record<string, any> = {
      $schema: "https://opencode.ai/config.json",
      plugin: [],
      provider: {},
    };

    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, "utf-8");
      try {
        config = JSON.parse(raw);
      } catch {}
    }

    if (!Array.isArray(config.plugin)) config.plugin = [];
    if (!config.provider || typeof config.provider !== "object") config.provider = {};
    
    if (config.provider.antigravity) {
      delete config.provider.antigravity;
    }

    if (!config.provider.google || typeof config.provider.google !== "object") {
      config.provider.google = {};
    }
    if (!config.provider.google.models || typeof config.provider.google.models !== "object") {
      config.provider.google.models = {};
    }

    const baseModels: Record<string, any> = { ...BASE_ANTIGRAVITY_MODELS };

    if (customModels && Array.isArray(customModels)) {
      for (const m of customModels) {
        if (!baseModels[m.id]) {
          baseModels[m.id] = {
            name: m.name,
            limit: { context: 1048576, output: 65536 },
            modalities: DEFAULT_MODALITIES,
          };
        }
      }
    }

    config.provider.google.models = baseModels;

    const dir = dirname(configPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    return {
      success: true,
      configPath,
      count: Object.keys(baseModels).length,
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
