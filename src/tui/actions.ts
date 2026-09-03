import { getActiveTheme, setPreviewTheme } from "../themes.js";
import {
  exportKeys,
  applyImport,
  resetFailures,
  toggleKey,
  writeExportFile,
  addKey,
} from "../storage.js";
import { safeSaveStore } from "./state.js";
import { BenchmarkRunner } from "./benchmark.js";
import {
  state,
  navigate,
  callRenderApp,
  refreshStore,
  setStatus,
  clampIndex,
} from "./state.js";
import type { ProviderId } from "../types.js";
import {
  authorizeAntigravity,
  exchangeAntigravity,
  getOrRefreshAntigravityAccessToken,
  fetchLiveAntigravityModels,
  startLocalCallbackServer,
  openUrlInBrowser,
} from "../antigravity.js";
import { syncOpencodeModels } from "../opencode-sync.js";

export function handleKeyAction(action: string): void {
  if (!state.selectedKeyId) return;
  const entry = state.store.keys.find((k) => k.id === state.selectedKeyId);
  const theme = getActiveTheme();

  switch (action) {
    case "toggle":
      if (entry) {
        toggleKey(state.store, state.selectedKeyId);
        safeSaveStore();
        refreshStore();
        setStatus(
          `Toggled "${entry.name}" to ${entry.enabled ? "ON" : "OFF"}`,
          theme.success,
        );
      }
      navigate("key-actions");
      break;
    case "rename":
      state.renameTargetId = state.selectedKeyId;
      navigate("rename");
      break;
    case "delete":
      state.deleteTargetId = state.selectedKeyId;
      navigate("confirm-delete");
      break;
    case "back":
      navigate("key-selector");
      break;
  }
}

export async function handleMenuSelect(value: string): Promise<void> {
  const theme = getActiveTheme();
  const provider = state.activeProvider;

  switch (value) {
    case "add":
      navigate("add-name");
      break;
    case "manage":
      navigate("key-selector");
      break;
    case "reset-failures":
      resetFailures(state.store);
      safeSaveStore();
      refreshStore();
      setStatus("All failure counts reset", theme.success);
      navigate("list");
      break;
    case "toggle-strategy": {
      const current = state.store.rotationStrategy;
      state.store.rotationStrategy = current === "round-robin" ? "least-failures" : "round-robin";
      safeSaveStore();
      refreshStore();
      setStatus(`Strategy: ${state.store.rotationStrategy}`, theme.primary);
      navigate("list");
      break;
    }
    case "theme":
      setPreviewTheme(null);
      navigate("theme-selector");
      break;
    case "sync-models": {
      const res = await syncOpencodeModels(state.store.fallbackChains.antigravity);
      if (res.success) {
        setStatus(`Synced ${res.count} models to opencode.json`, theme.success);
      } else {
        setStatus(`Sync failed: ${res.error}`, theme.error);
      }
      navigate("list");
      break;
    }
    case "export":
      navigate("export-path");
      break;
    case "import":
      navigate("import-path");
      break;
    case "quit":
      if (state.oauthCleanup) {
        state.oauthCleanup();
        state.oauthCleanup = null;
      }
      if (state.renderer) state.renderer.destroy();
      process.exit(0);
  }
}

export function handleExport(filePath: string): void {
  const theme = getActiveTheme();
  const path = filePath.trim();
  if (!path) {
    setStatus("File path is required", theme.error);
    callRenderApp();
    return;
  }
  try {
    const payload = exportKeys(state.store);
    writeExportFile(payload, path);
    setStatus(`Exported ${payload.keys.length} key(s) to ${path}`, theme.success);
    navigate("list");
  } catch (err) {
    console.error("[superoc] Export failed:", err);
    setStatus(`Export failed: check file path and permissions`, theme.error);
    callRenderApp();
  }
}

export function handleImportConfirm(value: string): void {
  const theme = getActiveTheme();
  if (value !== "yes" || !state.pendingImportResult) {
    state.pendingImportPath = "";
    state.pendingImportResult = null;
    navigate("list");
    return;
  }
  const { added, skipped } = applyImport(state.store, state.pendingImportResult.pendingKeys);
  safeSaveStore();
  refreshStore();
  const parts: string[] = [];
  if (added > 0) parts.push(`${added} added`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  setStatus(`Import complete: ${parts.join(", ")}`, theme.success);
  state.pendingImportPath = "";
  state.pendingImportResult = null;
  navigate("list");
}

export function handleFallbackMenuSelect(value: string): void {
  switch (value) {
    case "edit-chain":
      const provider = state.activeProvider;
      state.fallbackChainIndex[provider] = 0;
      state.fallbackChainScrollOffset[provider] = 0;
      navigate("fallback-chain");
      break;
    case "settings":
      navigate("fallback-settings");
      break;
  }
}

export async function fetchModels(provider: ProviderId): Promise<void> {
  if (provider === "nvidia") {
    await fetchNimModels();
  } else if (provider === "google") {
    await fetchGoogleModels();
  } else {
    await fetchAntigravityModels();
  }
}

async function fetchNimModels(): Promise<void> {
  try {
    const res = await fetch("https://integrate.api.nvidia.com/v1/models", {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      setStatus("Failed to fetch models from NVIDIA NIM", "#FF5555");
      return;
    }
    const data = (await res.json()) as { data?: Array<{ id: string; name?: string }> };
    if (!data.data || !Array.isArray(data.data)) {
      setStatus("Invalid response from NVIDIA NIM", "#FF5555");
      return;
    }
    state.availableModels.nvidia = data.data.map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
    }));
    state.modelsLoaded.nvidia = true;
  } catch (err) {
    console.error("[superoc] Failed to fetch NVIDIA models:", err);
    setStatus("Failed to fetch models from NVIDIA NIM", "#FF5555");
  }
}

async function fetchGoogleModels(): Promise<void> {
  const googleKey =
    state.store.keys.find((k) => k.provider === "google" && k.enabled)?.key ||
    process.env.GOOGLE_API_KEY;

  if (!googleKey) {
    setStatus("Add a Google API key first to fetch models", getActiveTheme().warning);
    return;
  }

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${googleKey}`,
      { signal: AbortSignal.timeout(15000) }
    );
    if (!res.ok) {
      setStatus("Failed to fetch models from Google Gemini", "#FF5555");
      return;
    }
    const data = (await res.json()) as {
      models?: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }>;
    };
    if (!data.models || !Array.isArray(data.models)) {
      setStatus("Invalid response from Google Gemini", "#FF5555");
      return;
    }
    state.availableModels.google = data.models
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => ({
        id: m.name.replace("models/", ""),
        name: m.displayName ?? m.name.replace("models/", ""),
      }));
    state.modelsLoaded.google = true;
  } catch (err) {
    console.error("[superoc] Failed to fetch Google models:", err);
    setStatus("Failed to fetch models from Google Gemini", "#FF5555");
  }
}

async function fetchAntigravityModels(): Promise<void> {
  const antigravityKey =
    state.store.keys.find((k) => k.provider === "antigravity" && k.enabled)?.key ||
    process.env.ANTIGRAVITY_API_KEY;

  let accessToken: string | undefined;
  let projectId: string | undefined;
  if (antigravityKey) {
    const auth = await getOrRefreshAntigravityAccessToken(antigravityKey);
    accessToken = auth?.accessToken;
    projectId = auth?.projectId;
  }

  try {
    const models = await fetchLiveAntigravityModels(accessToken, projectId);
    state.availableModels.antigravity = models;
    state.modelsLoaded.antigravity = true;
  } catch (err) {
    console.error("[superoc] Failed to fetch Antigravity models:", err);
    setStatus("Failed to fetch models from Antigravity", "#FF5555");
  }
}

export function addFallbackModel(id: string, name: string): void {
  const provider = state.activeProvider;
  const chain = state.store.fallbackChains[provider];

  if (chain.some((m) => m.id === id)) {
    setStatus(
      `Model "${name}" (${id}) is already in the fallback chain`,
      getActiveTheme().warning,
    );
    callRenderApp();
    return;
  }

  const insertIndex =
    state.fallbackChainIndex[provider] >= chain.length
      ? chain.length
      : state.fallbackChainIndex[provider] + 1;

  chain.splice(insertIndex, 0, {
    id,
    name,
    benchmarkTtfb: undefined,
    benchmarkTps: undefined,
    benchmarkStatus: "idle",
  });

  safeSaveStore();
  refreshStore();
  state.fallbackChainIndex[provider] = insertIndex;

  if (provider === "antigravity") {
    syncOpencodeModels(state.store.fallbackChains.antigravity);
  }
}

export function cancelBenchmark(modelId?: string): void {
  if (modelId) {
    const runner = state.benchmarkRunners.get(modelId);
    if (runner) {
      runner.cancel();
      state.benchmarkRunners.delete(modelId);
      const model = state.store.fallbackChains[state.activeProvider].find((m) => m.id === modelId);
      if (model && model.benchmarkStatus === "running") {
        model.benchmarkStatus = "idle";
        delete model.benchmarkTps;
        delete model.benchmarkTtfb;
        delete model.benchmarkError;
      }
      safeSaveStore();
      callRenderApp();
    }
  } else {
    for (const [id, runner] of state.benchmarkRunners) {
      runner.cancel();
      const model = state.store.fallbackChains[state.activeProvider].find((m) => m.id === id);
      if (model && model.benchmarkStatus === "running") {
        model.benchmarkStatus = "idle";
        delete model.benchmarkTps;
        delete model.benchmarkTtfb;
        delete model.benchmarkError;
      }
    }
    state.benchmarkRunners.clear();
    safeSaveStore();
    callRenderApp();
  }
}

export async function startBenchmark(): Promise<void> {
  const provider = state.activeProvider;
  const chain = state.store.fallbackChains[provider];
  const idx = state.fallbackChainIndex[provider];

  if (idx >= chain.length) {
    setStatus("No model selected to benchmark", getActiveTheme().warning);
    return;
  }

  const model = chain[idx];
  let apiKey =
    state.store.keys.find((k) => k.enabled && k.provider === provider)?.key ||
    (provider === "nvidia"
      ? process.env.NVIDIA_API_KEY
      : provider === "google"
      ? process.env.GOOGLE_API_KEY
      : process.env.ANTIGRAVITY_API_KEY);

  if (provider === "antigravity" && apiKey) {
    const auth = await getOrRefreshAntigravityAccessToken(apiKey);
    if (auth?.accessToken) {
      apiKey = `${auth.accessToken}|${auth.projectId}`;
    }
  }

  if (!apiKey) {
    setStatus(`No API key available for ${getProviderDisplayName(provider)} benchmarking`, getActiveTheme().error);
    return;
  }

  const existing = state.benchmarkRunners.get(model.id);
  if (existing) {
    existing.cancel();
    state.benchmarkRunners.delete(model.id);
  }

  model.benchmarkStatus = "idle";
  delete model.benchmarkTps;
  delete model.benchmarkTtfb;
  delete model.benchmarkError;

  const runner = new BenchmarkRunner(provider);
  state.benchmarkRunners.set(model.id, runner);
  model.benchmarkStatus = "running";
  callRenderApp();

  await runner.run(model, apiKey);

  if (state.benchmarkRunners.get(model.id) === runner) {
    state.benchmarkRunners.delete(model.id);
    runner.applyResultToModel(model);
    safeSaveStore();
    callRenderApp();
  }
}

export function getProviderDisplayName(provider: ProviderId): string {
  if (provider === "nvidia") return "NVIDIA NIM";
  if (provider === "google") return "Google Gemini";
  return "Antigravity (Google OAuth)";
}

export function handleStartOAuthLogin(): void {
  if (state.oauthCleanup) {
    state.oauthCleanup();
    state.oauthCleanup = null;
  }

  const auth = authorizeAntigravity();
  state.pendingOAuthUrl = auth.url;
  state.pendingOAuthState = auth.state;

  openUrlInBrowser(auth.url);

  state.oauthCleanup = startLocalCallbackServer(async (code, stateStr) => {
    try {
      const res = await exchangeAntigravity(code, stateStr || state.pendingOAuthState);
      if (res.type === "success") {
        const name = state.pendingKeyName || res.email || "antigravity-account";
        addKey(state.store, name, res.refresh, "antigravity");
        safeSaveStore();
        refreshStore();
        await syncOpencodeModels(state.store.fallbackChains.antigravity);
        fetchAntigravityModels().catch(() => {});
        setStatus(`Added Antigravity account "${name}"`, getActiveTheme().success);
        state.pendingKeyName = "";
        state.pendingOAuthUrl = "";
        state.pendingOAuthState = "";
        navigate("list");
      } else {
        setStatus(`OAuth failed: ${res.error}`, getActiveTheme().error);
        callRenderApp();
      }
    } catch (err) {
      setStatus(`OAuth error: ${err instanceof Error ? err.message : String(err)}`, getActiveTheme().error);
      callRenderApp();
    }
  });

  navigate("oauth-login");
}

export function handleFallbackChainKey(keyName: string): void {
  const provider = state.activeProvider;
  const chain = state.store.fallbackChains[provider];
  const totalItems = chain.length + 1;

  switch (keyName) {
    case "up":
      state.fallbackChainIndex[provider] = Math.max(0, state.fallbackChainIndex[provider] - 1);
      callRenderApp();
      break;
    case "down":
      state.fallbackChainIndex[provider] = Math.min(
        totalItems - 1,
        state.fallbackChainIndex[provider] + 1,
      );
      callRenderApp();
      break;
    case "x": {
      // Remove item
      if (state.fallbackChainIndex[provider] < chain.length) {
        const removed = chain[state.fallbackChainIndex[provider]];
        cancelBenchmark(removed.id);
        chain.splice(state.fallbackChainIndex[provider], 1);
        safeSaveStore();
        refreshStore();
        if (provider === "antigravity") {
          syncOpencodeModels(state.store.fallbackChains.antigravity);
        }
        if (state.fallbackChainIndex[provider] >= chain.length) {
          state.fallbackChainIndex[provider] = Math.max(0, chain.length - 1);
        }
        callRenderApp();
      }
      break;
    }
    case "j": {
      // Move item down
      const jIndex = state.fallbackChainIndex[provider];
      if (jIndex < chain.length - 1) {
        const temp = chain[jIndex];
        chain[jIndex] = chain[jIndex + 1];
        chain[jIndex + 1] = temp;
        state.fallbackChainIndex[provider] = jIndex + 1;
        safeSaveStore();
        refreshStore();
        callRenderApp();
      }
      break;
    }
    case "k": {
      // Move item up
      const kIndex = state.fallbackChainIndex[provider];
      if (kIndex > 0 && kIndex < chain.length) {
        const temp = chain[kIndex];
        chain[kIndex] = chain[kIndex - 1];
        chain[kIndex - 1] = temp;
        state.fallbackChainIndex[provider] = kIndex - 1;
        safeSaveStore();
        refreshStore();
        callRenderApp();
      }
      break;
    }
    case "a": {
      // Add new model below current item
      state.modelSelectorIndex[provider] = 0;
      state.modelSelectorScrollOffset[provider] = 0;
      navigate("model-selector");
      break;
    }
    case "b": {
      startBenchmark();
      break;
    }
    case "c": {
      const selectedModel = chain[state.fallbackChainIndex[provider]];
      if (selectedModel) {
        cancelBenchmark(selectedModel.id);
      }
      break;
    }
    case "return":
    case "enter": {
      if (state.fallbackChainIndex[provider] >= chain.length) {
        // "Add model" selected
        state.modelSelectorIndex[provider] = 0;
        state.modelSelectorScrollOffset[provider] = 0;
        navigate("model-selector");
      }
      break;
    }
  }
}