import { join } from "path";
import { homedir } from "os";
import { Box, Text } from "@opentui/core";
import pkg from "../../package.json" with { type: "json" };
import { getActiveTheme, getTheme, getResolvedTheme, listThemes, saveThemeOverride, setPreviewTheme, dangerSelectColors, getThemeOverride } from "../themes.js";
import { addKey, readAndValidateImportFile, validateImportPayload, removeKey, renameKey, getActiveKeys } from "../storage.js";
import { state, navigate, callRenderApp, refreshStore, setStatus, clampIndex, safeSaveStore } from "./state.js";
import { themedSelect, themedInput, events, maskKey, applyThemeToScreen } from "./ui.js";
import type { ScreenContent, SelectOption, ProviderId, ActiveTab } from "./types.js";
import {
  handleMenuSelect,
  handleKeyAction,
  handleExport,
  handleImportConfirm,
  handleFallbackChainKey,
  handleFallbackMenuSelect,
  fetchModels,
  addFallbackModel,
  cancelBenchmark,
  startBenchmark,
  handleStartOAuthLogin,
} from "./actions.js";
import { exchangeAntigravity } from "../antigravity.js";
import { BASE_ANTIGRAVITY_MODELS } from "../opencode-sync.js";

function keyStatus(entry: { enabled: boolean }): string {
  return !entry.enabled ? "OFF" : "OK";
}

function getProviderDisplayName(provider: ProviderId): string {
  if (provider === "nvidia") return "NVIDIA NIM";
  if (provider === "google") return "Google Gemini";
  return "Antigravity (Google OAuth)";
}

function getProviderShortName(provider: ProviderId): string {
  if (provider === "nvidia") return "NVIDIA";
  if (provider === "google") return "Gemini";
  return "Antigravity";
}

// ---------------------------------------------------------------------------
// Provider Tabs Screen
// ---------------------------------------------------------------------------

export function buildProviderTabs(): ScreenContent {
  const theme = getActiveTheme();
  const options: SelectOption[] = [
    {
      name: "[1] NVIDIA NIM",
      description: "Manage NVIDIA NIM API keys and fallback models",
      value: "nvidia",
    },
    {
      name: "[2] Google Gemini",
      description: "Manage Google Gemini API keys and fallback models",
      value: "google",
    },
    {
      name: "[3] Antigravity",
      description: "Manage Google OAuth Antigravity accounts and models",
      value: "antigravity",
    },
    { name: "Quit", description: "Exit the key manager", value: "quit" },
  ];

  state.mainMenuIndex = clampIndex(state.mainMenuIndex, options.length);

  const menu = themedSelect(
    "provider-tabs",
    56,
    10,
    options,
    state.mainMenuIndex,
    (idx, opt) => {
      state.mainMenuIndex = idx;
      handleProviderTabSelect(opt.value);
    },
  );

  return {
    element: Box(
      { flexDirection: "column", gap: 1 },
      Text({ content: " Select a provider:", fg: theme.primary }),
      menu,
    ),
    helpText: "[Ctrl+C] quit",
  };
}

function handleProviderTabSelect(value: string): void {
  if (value === "quit") {
    if (state.renderer) state.renderer.destroy();
    process.exit(0);
  }
  state.activeProvider = value as ProviderId;
  state.activeTab = "keys";
  navigate("list");
}

// ---------------------------------------------------------------------------
// Main Menu (per provider)
// ---------------------------------------------------------------------------

export function buildMainMenu(): ScreenContent {
  const { store } = state;
  const provider = state.activeProvider;
  const providerKeys = store.keys.filter((k) => k.provider === provider);
  const hasKeys = providerKeys.length > 0;
  const theme = getActiveTheme();
  const override = getThemeOverride();

  const isAntigravity = provider === "antigravity";

  const opts: (SelectOption | false)[] = [
    hasKeys && {
      name: "Manage Accounts / Keys",
      description: "Select an entry to rename, delete, or toggle",
      value: "manage",
    },
    isAntigravity && {
      name: "Login with Google (OAuth)",
      description: "Authenticate via Google OAuth PKCE in browser",
      value: "oauth-start",
    },
    {
      name: isAntigravity ? "Add Account Manually (Refresh Token)" : "Add Key",
      description: isAntigravity
        ? "Manually add account name and refresh_token"
        : `Add a new ${getProviderDisplayName(provider)} API key`,
      value: "add",
    },
    isAntigravity && {
      name: "Models",
      description: "View current Antigravity models & refresh from Google API",
      value: "antigravity-models",
    },
    hasKeys && {
      name: "Reset Failures",
      description: "Reset all failure counts to zero",
      value: "reset-failures",
    },
    hasKeys && {
      name: "Export Keys",
      description: "Export all keys to a JSON file",
      value: "export",
    },
    {
      name: "Import Keys",
      description: "Import keys from a JSON file",
      value: "import",
    },
    {
      name: `Strategy: ${store.rotationStrategy}`,
      description: "Toggle between round-robin and least-failures",
      value: "toggle-strategy",
    },
    {
      name: `Theme: ${theme.name}${!override ? " (synced with opencode)" : ""}`,
      description: "Change the color theme",
      value: "theme",
    },
    { name: "Back", description: "Return to provider selection", value: "back" },
  ];
  const options = opts.filter(Boolean) as SelectOption[];

  state.mainMenuIndex = clampIndex(state.mainMenuIndex, options.length);

  const menu = themedSelect(
    "main-menu",
    56,
    12,
    options,
    state.mainMenuIndex,
    (idx, opt) => {
      state.mainMenuIndex = idx;
      if (opt.value === "oauth-start") {
        handleStartOAuthLogin();
      } else {
        handleMenuSelect(opt.value);
      }
    },
  );

  const providerName = getProviderDisplayName(provider);
  return {
    element: Box(
      { flexDirection: "column", gap: 1 },
      Text({ content: ` ${providerName} Key Manager`, fg: theme.primary }),
      menu,
    ),
    helpText: "[Esc] back  [Ctrl+C] quit",
  };
}

// ---------------------------------------------------------------------------
// Key Selector
// ---------------------------------------------------------------------------

export function buildKeySelector(): ScreenContent {
  const provider = state.activeProvider;
  const providerKeys = state.store.keys.filter((k) => k.provider === provider);

  const options: SelectOption[] = providerKeys.map((entry) => ({
    name: `${entry.name} [${keyStatus(entry)}]`,
    description: `${maskKey(entry.key)} rl:${entry.rateLimitCount} ${entry.lastUsedAt ? new Date(entry.lastUsedAt).toLocaleString() : "never used"}`,
    value: entry.id,
  }));

  if (options.length === 0) {
    navigate("list");
    return { element: Text({ content: "", fg: "#000000" }), helpText: "" };
  }

  state.keySelectorIndex = clampIndex(state.keySelectorIndex, options.length);

  const selector = themedSelect(
    "key-selector",
    56,
    12,
    options,
    state.keySelectorIndex,
    (idx, opt) => {
      state.keySelectorIndex = idx;
      state.selectedKeyId = opt.value;
      state.keyActionsIndex = 0;
      navigate("key-actions");
    },
  );

  return {
    element: Box(
      { flexDirection: "column", gap: 1 },
      Text({ content: " Select a key to manage:", fg: getActiveTheme().primary }),
      selector,
    ),
    helpText: "[Esc] back",
  };
}

// ---------------------------------------------------------------------------
// Key Actions
// ---------------------------------------------------------------------------

export function buildKeyActions(): ScreenContent {
  const { selectedKeyId } = state;
  if (!selectedKeyId) {
    navigate("key-selector");
    return { element: Text({ content: "", fg: "#000000" }), helpText: "" };
  }

  const entry = state.store.keys.find((k) => k.id === selectedKeyId);
  if (!entry) {
    state.selectedKeyId = null;
    navigate("key-selector");
    return { element: Text({ content: "", fg: "#000000" }), helpText: "" };
  }

  const options: SelectOption[] = [
    {
      name: `Toggle ${entry.enabled ? "OFF" : "ON"}`,
      description: `${entry.enabled ? "Disable" : "Enable"} this key`,
      value: "toggle",
    },
    { name: "Rename", description: "Change the friendly name", value: "rename" },
    { name: "Delete", description: "Remove this key permanently", value: "delete" },
    { name: "Back", description: "Return to key list", value: "back" },
  ];

  state.keyActionsIndex = clampIndex(state.keyActionsIndex, options.length);

  const actions = themedSelect(
    "key-actions",
    40,
    8,
    options,
    state.keyActionsIndex,
    (idx, opt) => {
      state.keyActionsIndex = idx;
      handleKeyAction(opt.value);
    },
  );

  return {
    element: Box(
      { flexDirection: "column", gap: 1 },
      Text({ content: ` Key: ${entry.name} (${maskKey(entry.key)})`, fg: getActiveTheme().primary }),
      actions,
    ),
    helpText: "[Esc] back",
  };
}

// ---------------------------------------------------------------------------
// Theme Selector
// ---------------------------------------------------------------------------

export function buildThemeSelector(): ScreenContent {
  const theme = getActiveTheme();
  const allThemes = listThemes();
  const currentOverride = getThemeOverride();
  const resolvedId = getResolvedTheme().id;
  const activeId = theme.id;

  const options: SelectOption[] = [
    {
      name: "sync",
      description: "Sync with opencode theme (default)",
      value: "sync",
    },
    ...allThemes.map((th) => ({
      name: th.id,
      description: `${th.name}${th.id === activeId ? " *" : ""}${th.id === resolvedId && !currentOverride ? " (opencode)" : ""}`,
      value: th.id,
    })),
  ];

  state.themeSelectorIndex = clampIndex(
    currentOverride ? options.findIndex((o) => o.value === currentOverride) : 0,
    options.length,
  );

  const selector = themedSelect(
    "theme-selector",
    56,
    12,
    options,
    state.themeSelectorIndex,
    (_index, option) => {
      state.themeSelectorIndex = _index;
      setPreviewTheme(null);
      if (option.value === "sync") {
        saveThemeOverride("");
        setStatus("Theme synced with opencode", theme.success);
      } else {
        saveThemeOverride(option.value);
        setStatus(`Theme set to ${option.value}`, theme.success);
      }
      refreshStore();
      navigate("list");
    },
  );

  events(selector).on("selectionChanged", (index: number) => {
    state.themeSelectorIndex = index;
    const option = options[index];
    if (!option) return;
    const previewId = option.value === "sync" ? getResolvedTheme().id : option.value;
    setPreviewTheme(previewId);
    applyThemeToScreen(getTheme(previewId));
  });

  return {
    element: Box(
      { flexDirection: "column", gap: 1 },
      Text({ id: "theme-label", content: " Select a theme:", fg: theme.primary }),
      selector,
    ),
    helpText: "[Esc] back  [Enter] apply",
  };
}

// ---------------------------------------------------------------------------
// Confirm Delete
// ---------------------------------------------------------------------------

export function buildConfirmDelete(): ScreenContent {
  const entry = state.store.keys.find((k) => k.id === state.deleteTargetId);
  const name = entry?.name ?? "this key";

  const options: SelectOption[] = [
    { name: "Yes, delete", description: `Permanently remove "${name}"`, value: "yes" },
    { name: "No, cancel", description: "Keep the key", value: "no" },
  ];

  const confirm = themedSelect(
    "confirm-delete",
    40,
    6,
    options,
    0,
    (_index, option) => {
      if (option.value === "yes" && state.deleteTargetId) {
        const e = state.store.keys.find((k) => k.id === state.deleteTargetId);
        const n = e?.name ?? "key";
        removeKey(state.store, state.deleteTargetId);
        safeSaveStore();
        refreshStore();
        if (state.keySelectorIndex >= state.store.keys.length)
          state.keySelectorIndex = Math.max(0, state.store.keys.length - 1);
        setStatus(`Deleted "${n}"`, getActiveTheme().error);
      }
      state.deleteTargetId = null;
      navigate("key-actions");
    },
    dangerSelectColors(getActiveTheme()),
  );

  return {
    element: Box(
      { flexDirection: "column", gap: 1 },
      Text({ content: "Are you sure you want to delete this key?", fg: getActiveTheme().error }),
      confirm,
    ),
    helpText: "[Esc] cancel",
  };
}

// ---------------------------------------------------------------------------
// Add Name Input
// ---------------------------------------------------------------------------

export function buildAddNameInput(): ScreenContent {
  const theme = getActiveTheme();
  const input = themedInput("add-name-input", "e.g. work-key, personal, team-alpha", 40);

  events(input).on("enter", (value: string) => {
    state.pendingKeyName = value.trim();
    if (!state.pendingKeyName) {
      setStatus("Name is required", theme.error);
      callRenderApp();
      return;
    }
    const provider = state.activeProvider;
    if (state.store.keys.some((k) => k.name === state.pendingKeyName && k.provider === provider)) {
      setStatus("A key with this name already exists", theme.error);
      callRenderApp();
      return;
    }
    navigate("add-key");
  });

  return {
    element: Box(
      { flexDirection: "column", gap: 1 },
      Text({ content: "Enter a friendly name for this key / account:", fg: theme.text }),
      input,
    ),
    helpText: "[Enter] next  [Esc] cancel",
  };
}

// ---------------------------------------------------------------------------
// Add Key Input
// ---------------------------------------------------------------------------

export function buildAddKeyInput(): ScreenContent {
  const theme = getActiveTheme();
  const provider = state.activeProvider;
  const placeholder =
    provider === "nvidia"
      ? "nvapi-..."
      : provider === "antigravity"
      ? "refresh_token (or refresh_token|project_id)"
      : "API key (no prefix required)";
  const input = themedInput("add-key-input", placeholder, 55);

  events(input).on("enter", (value: string) => {
    const key = value.trim();
    if (!key) {
      setStatus("API key / Token is required", theme.error);
      callRenderApp();
      return;
    }
    if (provider === "nvidia" && !key.startsWith("nvapi-")) {
      setStatus("NVIDIA key must start with 'nvapi-'", theme.error);
      callRenderApp();
      return;
    }
    addKey(state.store, state.pendingKeyName, key, provider);
    safeSaveStore();
    refreshStore();
    setStatus(`Added "${state.pendingKeyName}"`, theme.success);
    state.pendingKeyName = "";
    navigate("list");
  });

  return {
    element: Box(
      { flexDirection: "column", gap: 1 },
      Text({ content: `Provider: ${getProviderDisplayName(provider)}`, fg: theme.textMuted }),
      Text({ content: `Name: ${state.pendingKeyName}`, fg: theme.primary }),
      Text({ content: provider === "antigravity" ? "Enter the refresh token (or token|projectId):" : "Enter the API key:", fg: theme.text }),
      input,
    ),
    helpText: "[Enter] confirm  [Esc] cancel",
  };
}

// ---------------------------------------------------------------------------
// OAuth Login Screen (for Antigravity)
// ---------------------------------------------------------------------------

export function buildOAuthLoginScreen(): ScreenContent {
  const theme = getActiveTheme();
  const url = state.pendingOAuthUrl;
  const input = themedInput("oauth-code-input", "Paste redirect URL or authorization code here...", 55);

  events(input).on("enter", async (val: string) => {
    const trimmed = val.trim();
    if (!trimmed) return;
    let code = trimmed;
    let stateParam = state.pendingOAuthState;
    if (trimmed.startsWith("http")) {
      try {
        const u = new URL(trimmed);
        code = u.searchParams.get("code") || trimmed;
        stateParam = u.searchParams.get("state") || stateParam;
      } catch {}
    }
    const res = await exchangeAntigravity(code, stateParam);
    if (res.type === "success") {
      const name = state.pendingKeyName || res.email || "antigravity-account";
      addKey(state.store, name, res.refresh, "antigravity");
      safeSaveStore();
      refreshStore();
      setStatus(`Added Antigravity account "${name}"`, theme.success);
      if (state.oauthCleanup) {
        state.oauthCleanup();
        state.oauthCleanup = null;
      }
      state.pendingKeyName = "";
      state.pendingOAuthUrl = "";
      state.pendingOAuthState = "";
      navigate("list");
    } else {
      setStatus(`OAuth failed: ${res.error}`, theme.error);
      callRenderApp();
    }
  });

  return {
    element: Box(
      { flexDirection: "column", gap: 1 },
      Text({ content: " Google OAuth Authentication", fg: theme.primary }),
      Text({ content: " Opening browser for Google login automatically...", fg: theme.success }),
      Text({ content: " Listening for callback on http://localhost:51121/oauth-callback", fg: theme.textMuted }),
      Text({ content: " If browser did not open, paste authorization code or callback URL:", fg: theme.text }),
      input,
    ),
    helpText: "[Esc] cancel  [Enter] submit code  [o] re-open browser",
  };
}

// ---------------------------------------------------------------------------
// Rename Input
// ---------------------------------------------------------------------------

export function buildRenameInput(): ScreenContent {
  const theme = getActiveTheme();
  if (!state.renameTargetId) {
    return { element: Text({ content: "Error: no key selected", fg: theme.error }), helpText: "" };
  }
  const entry = state.store.keys.find((k) => k.id === state.renameTargetId);
  const currentName = entry?.name ?? "";

  const input = themedInput("rename-input", "New friendly name", 40, currentName);

  events(input).on("enter", (value: string) => {
    const newName = value.trim();
    if (!newName) {
      setStatus("Name is required", theme.error);
      callRenderApp();
      return;
    }
    const provider = state.activeProvider;
    if (state.store.keys.some((k) => k.name === newName && k.id !== state.renameTargetId && k.provider === provider)) {
      setStatus("A key with this name already exists", theme.error);
      callRenderApp();
      return;
    }
    renameKey(state.store, state.renameTargetId!, newName);
    safeSaveStore();
    refreshStore();
    setStatus(`Renamed to "${newName}"`, theme.success);
    state.renameTargetId = null;
    navigate("key-actions");
  });

  return {
    element: Box(
      { flexDirection: "column", gap: 1 },
      Text({ content: "Enter new name:", fg: theme.text }),
      input,
    ),
    helpText: "[Enter] confirm [Esc] cancel",
  };
}

// ---------------------------------------------------------------------------
// Export Path Input
// ---------------------------------------------------------------------------

export function buildExportPathInput(): ScreenContent {
  const theme = getActiveTheme();
  const provider = state.activeProvider;
  const providerKeys = state.store.keys.filter((k) => k.provider === provider);
  const defaultPath = `~/superoc-${provider}-keys-export.json`;
  const input = themedInput("export-path-input", defaultPath, 55);

  events(input).on("enter", (value: string) => {
    let filePath = value.trim();
    if (!filePath) {
      setStatus("File path is required", theme.error);
      callRenderApp();
      return;
    }
    if (filePath.startsWith("~/")) {
      filePath = join(homedir(), filePath.slice(2));
    }
    handleExport(filePath);
  });

  return {
    element: Box(
      { flexDirection: "column", gap: 1 },
      Text({ content: `Export ${providerKeys.length} key(s) to JSON file:`, fg: theme.text }),
      input,
    ),
    helpText: "[Enter] export [Esc] cancel",
  };
}

// ---------------------------------------------------------------------------
// Import Path Input
// ---------------------------------------------------------------------------

export function buildImportPathInput(): ScreenContent {
  const theme = getActiveTheme();
  const input = themedInput("import-path-input", "~/superoc-keys-export.json", 55);

  events(input).on("enter", (value: string) => {
    let filePath = value.trim();
    if (!filePath) {
      setStatus("File path is required", theme.error);
      callRenderApp();
      return;
    }
    if (filePath.startsWith("~/")) {
      filePath = join(homedir(), filePath.slice(2));
    }

    const fileResult = readAndValidateImportFile(filePath);
    if ("error" in fileResult) {
      setStatus(fileResult.error, theme.error);
      callRenderApp();
      return;
    }

    const result = validateImportPayload(fileResult.raw);

    if (result.errors.length > 0) {
      setStatus(`Import error: ${result.errors[0]}`, theme.error);
      callRenderApp();
      return;
    }

    if (result.pendingKeys.length === 0) {
      setStatus("No valid keys found in file", theme.warning);
      navigate("list");
      return;
    }

    state.pendingImportPath = filePath;
    state.pendingImportResult = result;
    navigate("confirm-import");
  });

  return {
    element: Box(
      { flexDirection: "column", gap: 1 },
      Text({ content: "Import keys from JSON file:", fg: theme.text }),
      input,
    ),
    helpText: "[Enter] import [Esc] cancel",
  };
}

// ---------------------------------------------------------------------------
// Confirm Import
// ---------------------------------------------------------------------------

export function buildConfirmImport(): ScreenContent {
  const theme = getActiveTheme();
  const result = state.pendingImportResult;
  if (!result) {
    navigate("list");
    return { element: Text({ content: "", fg: "#000000" }), helpText: "" };
  }

  const parts: string[] = [];
  if (result.pendingKeys.length > 0) parts.push(`${result.pendingKeys.length} key(s) will be imported`);
  if (result.errors.length > 0) parts.push(`${result.errors.length} entry/entries invalid`);

  const options: SelectOption[] = [
    { name: "Yes, import", description: parts.join(", "), value: "yes" },
    { name: "No, cancel", description: "Discard the import", value: "no" },
  ];

  const confirm = themedSelect("confirm-import", 50, 6, options, 0, (_index, option) => {
    handleImportConfirm(option.value);
  });

  return {
    element: Box(
      { flexDirection: "column", gap: 1 },
      Text({ content: `Confirm import from: ${state.pendingImportPath}`, fg: theme.primary }),
      confirm,
    ),
    helpText: "[Esc] cancel",
  };
}

// ---------------------------------------------------------------------------
// Fallback Menu
// ---------------------------------------------------------------------------

export function buildFallbackMenu(): ScreenContent {
  const theme = getActiveTheme();
  const provider = state.activeProvider;
  const chain = state.store.fallbackChains[provider];

  const opts: (SelectOption | false)[] = [
    {
      name: provider === "antigravity" ? "Select / Configure Models" : "Edit Fallback Chain",
      description: `Manage models (${chain.length} configured)`,
      value: "edit-chain",
    },
    {
      name: `Rate Limit Threshold: ${state.store.maxRateLimitFailures}`,
      description: "Number of rate limits before account failover activates",
      value: "settings",
    },
  ];
  const options = opts.filter(Boolean) as SelectOption[];

  state.fallbackSettingsIndex = clampIndex(state.fallbackSettingsIndex, options.length);

  const menu = themedSelect(
    "fallback-menu",
    56,
    8,
    options,
    state.fallbackSettingsIndex,
    (idx, opt) => {
      state.fallbackSettingsIndex = idx;
      handleFallbackMenuSelect(opt.value);
    },
  );

  return { element: menu, helpText: "[Tab] switch tabs  [Ctrl+C] quit" };
}

// ---------------------------------------------------------------------------
// Fallback Settings
// ---------------------------------------------------------------------------

export function buildFallbackSettings(): ScreenContent {
  const theme = getActiveTheme();
  const current = state.store.maxRateLimitFailures;

  const options: SelectOption[] = [
    { name: "+1", description: `Increase threshold to ${current + 1}`, value: "inc" },
    { name: "-1", description: `Decrease threshold to ${Math.max(1, current - 1)}`, value: "dec" },
    { name: "Back", description: "Return to fallback menu", value: "back" },
  ];

  const selector = themedSelect(
    "fallback-settings",
    56,
    8,
    options,
    Math.max(0, state.fallbackSettingsIndex - 1),
    (idx, opt) => {
      if (opt.value === "inc") {
        state.store.maxRateLimitFailures = current + 1;
        safeSaveStore();
        refreshStore();
        state.fallbackSettingsIndex = idx + 1;
        callRenderApp();
      } else if (opt.value === "dec") {
        state.store.maxRateLimitFailures = Math.max(1, current - 1);
        safeSaveStore();
        refreshStore();
        state.fallbackSettingsIndex = idx + 1;
        callRenderApp();
      } else if (opt.value === "back") {
        navigate("fallback-menu");
      }
    },
  );

  events(selector).on("selectionChanged", (index: number) => {
    state.fallbackSettingsIndex = index + 1;
  });

  return {
    element: Box(
      { flexDirection: "column", gap: 1 },
      Box(
        { flexDirection: "column" },
        Text({ content: " Fallback Settings:", fg: theme.primary }),
        Text({ content: ` Rotate to next account after ${current} consecutive rate limit${current === 1 ? "" : "s"}`, fg: theme.textMuted }),
      ),
      selector,
    ),
    helpText: "[Esc] back",
  };
}

// ---------------------------------------------------------------------------
// Fallback Chain
// ---------------------------------------------------------------------------

const BRAILLE_SPINNER_FRAMES = [
  "\u280B", "\u2819", "\u2839", "\u2838",
  "\u283C", "\u2834", "\u2826", "\u2827",
  "\u2807", "\u280F",
];

function getBrailleSpinner(): string {
  const frame = Math.floor(Date.now() / 80) % BRAILLE_SPINNER_FRAMES.length;
  return BRAILLE_SPINNER_FRAMES[frame]!;
}

export function buildFallbackChain(): ScreenContent {
  const theme = getActiveTheme();
  const provider = state.activeProvider;
  const chain = state.store.fallbackChains[provider];
  const totalItems = chain.length + 1;

  const currentIndex = state.fallbackChainIndex[provider];
  state.fallbackChainIndex[provider] = clampIndex(currentIndex, totalItems);

  const viewportHeight = 12;
  const listWidth = 56;

  if (state.fallbackChainIndex[provider] < state.fallbackChainScrollOffset[provider]) {
    state.fallbackChainScrollOffset[provider] = state.fallbackChainIndex[provider];
  } else if (
    state.fallbackChainIndex[provider] >=
    state.fallbackChainScrollOffset[provider] + viewportHeight
  ) {
    state.fallbackChainScrollOffset[provider] =
      state.fallbackChainIndex[provider] - viewportHeight + 1;
  }

  const items: any[] = [];
  const startIdx = state.fallbackChainScrollOffset[provider];
  const endIdx = Math.min(startIdx + viewportHeight, chain.length);

  for (let i = startIdx; i < endIdx; i++) {
    const model = chain[i];
    const isSelected = i === state.fallbackChainIndex[provider];
    const isActivelyBenchmarking = model.benchmarkStatus === "running" && state.benchmarkRunners.has(model.id);

    let statusText: string;
    let statusIsError = false;

    if (isActivelyBenchmarking) {
      const runner = state.benchmarkRunners.get(model.id)!;
      const m = runner.metrics;
      const phase = runner.phase;
      if (phase === "connecting") {
        statusText = `${getBrailleSpinner()} connecting...`;
      } else if (phase === "streaming") {
        const ttfb = m.ttfb != null ? `${m.ttfb.toFixed(0)}ms` : "...";
        const tps = m.tps != null ? `${m.tps.toFixed(1)}` : "...";
        statusText = `${getBrailleSpinner()} ${ttfb} TTFB, ${tps} TPS`;
      } else {
        statusText = `${getBrailleSpinner()} benchmarking...`;
      }
    } else if (model.benchmarkStatus === "running") {
      statusText = `${getBrailleSpinner()} benchmarking...`;
    } else if (model.benchmarkStatus === "done") {
      const ttfbStr = model.benchmarkTtfb != null && Number.isFinite(model.benchmarkTtfb)
        ? `${model.benchmarkTtfb.toFixed(0)}ms`
        : "?ms";
      const tpsStr = model.benchmarkTps != null && Number.isFinite(model.benchmarkTps) && model.benchmarkTps > 0
        ? `${model.benchmarkTps.toFixed(1)}`
        : "?";
      statusText = `\u2713 ${ttfbStr} TTFB, ${tpsStr} TPS`;
    } else if (model.benchmarkStatus === "error") {
      statusText = `\u2717 ${model.benchmarkError}`;
      statusIsError = true;
    } else {
      statusText = "";
    }

    const prefix = isSelected ? "\u25b6 " : "  ";
    const nameWidth = listWidth - 4;
    const displayName = model.name.length > nameWidth
      ? model.name.slice(0, nameWidth - 3) + "..."
      : model.name;

    items.push(
      Box(
        {
          flexDirection: "row",
          paddingX: 1,
          backgroundColor: isSelected ? theme.selectedBg : theme.backgroundPanel,
          width: listWidth,
        },
        Text({
          content: `${prefix}${displayName}`,
          fg: isSelected ? theme.selectedText : theme.text,
          width: statusText ? nameWidth - statusText.length : nameWidth,
        }),
        statusText
          ? Text({ content: statusText, fg: statusIsError ? theme.error : theme.textMuted })
          : Text({ content: "", fg: theme.backgroundPanel }),
      ),
    );
  }

  const addModelIndex = chain.length;
  const isAddVisible = addModelIndex >= startIdx && addModelIndex < startIdx + viewportHeight;
  if (isAddVisible) {
    const isAddSelected = state.fallbackChainIndex[provider] === addModelIndex;
    items.push(
      Box(
        {
          flexDirection: "row",
          paddingX: 1,
          backgroundColor: isAddSelected ? theme.selectedBg : theme.backgroundPanel,
          width: listWidth,
        },
        Text({
          content: `${isAddSelected ? "\u25b6 " : "  "}+ Add model`,
          fg: isAddSelected ? theme.selectedText : theme.textMuted,
        }),
      ),
    );
  }

  const providerName = getProviderDisplayName(provider);
  return {
    element: Box(
      { flexDirection: "column", gap: 0, width: listWidth },
      Text({ content: ` ${providerName} Models:`, fg: theme.primary }),
      ...items,
    ),
    helpText: "[Up/Down] move  [x] remove  [j/k] reorder\n[a] add  [b] benchmark  [c] cancel",
  };
}

// ---------------------------------------------------------------------------
// Model Selector
// ---------------------------------------------------------------------------

export function getFilteredModelsForSelector(): Array<{ id: string; name: string }> {
  const provider = state.activeProvider;
  const addedIds = new Set(state.store.fallbackChains[provider].map((m) => m.id));
  const filteredModels = state.availableModels[provider].filter((model) => !addedIds.has(model.id));
  const searchQuery = state.modelSearchQuery.toLowerCase();
  return searchQuery.length > 0
    ? filteredModels.filter(
        (model) =>
          model.name.toLowerCase().includes(searchQuery) ||
          model.id.toLowerCase().includes(searchQuery),
      )
    : filteredModels;
}

export function buildModelSelector(): ScreenContent {
  const theme = getActiveTheme();
  const provider = state.activeProvider;

  if (state.availableModels[provider].length === 0 && !state.modelsLoaded[provider]) {
    state.modelsLoaded[provider] = true;
    fetchModels(provider).then(() => {
      if (state.availableModels[provider].length === 0) {
        setStatus("No models available", getActiveTheme().warning);
      }
      callRenderApp();
    });

    return {
      element: Box(
        { flexDirection: "column", gap: 1 },
        Text({ content: `Loading models from ${getProviderDisplayName(provider)}...`, fg: theme.textMuted }),
      ),
      helpText: "[Esc] cancel",
    };
  }

  const searchFilteredModels = getFilteredModelsForSelector();

  if (state.modelSelectorScrollOffset[provider] < 0) {
    state.modelSelectorScrollOffset[provider] = 0;
  }

  state.modelSelectorIndex[provider] = clampIndex(state.modelSelectorIndex[provider], Math.max(1, searchFilteredModels.length));

  const searchDisplay = state.modelSearchQuery.length > 0
    ? Text({ content: `Search: ${state.modelSearchQuery}_`, fg: theme.primary })
    : Text({ content: "Type to search or enter custom model ID...", fg: theme.textMuted });

  const listWidth = 56;
  const viewportHeight = 12;
  const totalItems = searchFilteredModels.length;

  if (state.modelSelectorIndex[provider] < state.modelSelectorScrollOffset[provider]) {
    state.modelSelectorScrollOffset[provider] = state.modelSelectorIndex[provider];
  } else if (
    state.modelSelectorIndex[provider] >=
    state.modelSelectorScrollOffset[provider] + viewportHeight
  ) {
    state.modelSelectorScrollOffset[provider] =
      state.modelSelectorIndex[provider] - viewportHeight + 1;
  }

  const items: any[] = [];
  const startIdx = state.modelSelectorScrollOffset[provider];
  const endIdx = Math.min(startIdx + viewportHeight, totalItems);

  for (let i = startIdx; i < endIdx; i++) {
    const model = searchFilteredModels[i];
    const isSelected = i === state.modelSelectorIndex[provider];
    const prefix = isSelected ? "\u25b6 " : "  ";

    items.push(
      Box(
        {
          flexDirection: "row",
          paddingX: 1,
          backgroundColor: isSelected ? theme.selectedBg : theme.backgroundPanel,
          width: listWidth,
        },
        Text({ content: `${prefix}${model.name}`, fg: isSelected ? theme.selectedText : theme.text }),
      ),
    );
  }

  if (totalItems === 0) {
    const query = state.modelSearchQuery.trim();
    if (query.length > 0) {
      items.push(
        Box(
          {
            flexDirection: "row",
            paddingX: 1,
            backgroundColor: theme.selectedBg,
            width: listWidth,
          },
          Text({ content: `▶ + Add custom model ID: "${query}"`, fg: theme.selectedText }),
        ),
      );
    } else {
      items.push(
        Box(
          {
            flexDirection: "row",
            paddingX: 1,
            backgroundColor: theme.backgroundPanel,
            width: listWidth,
          },
          Text({ content: "  No matching models (type to add custom ID)", fg: theme.textMuted }),
        ),
      );
    }
  }

  return {
    element: Box(
      { flexDirection: "column", gap: 0, width: listWidth },
      Text({ content: " Select a model to add:", fg: theme.primary }),
      searchDisplay,
      ...items,
    ),
    helpText: "[Esc] cancel  [Enter] select  [Type] search  [Backspace] clear  [r] refresh live",
  };
}

// ---------------------------------------------------------------------------
// Antigravity Models Screen
// ---------------------------------------------------------------------------

export function buildAntigravityModelsScreen(): ScreenContent {
  const theme = getActiveTheme();
  const models = Object.entries(BASE_ANTIGRAVITY_MODELS);
  const listWidth = 64;
  const viewportHeight = 14;

  if (state.modelSelectorIndex["antigravity"] === undefined) {
    state.modelSelectorIndex["antigravity"] = 0;
  }
  state.modelSelectorIndex["antigravity"] = clampIndex(
    state.modelSelectorIndex["antigravity"],
    models.length,
  );

  const currentIndex = state.modelSelectorIndex["antigravity"];
  let scrollOffset = state.modelSelectorScrollOffset["antigravity"] || 0;
  if (currentIndex < scrollOffset) {
    scrollOffset = currentIndex;
  } else if (currentIndex >= scrollOffset + viewportHeight) {
    scrollOffset = currentIndex - viewportHeight + 1;
  }
  state.modelSelectorScrollOffset["antigravity"] = scrollOffset;

  const visibleModels = models.slice(scrollOffset, scrollOffset + viewportHeight);

  const rows = visibleModels.map(([id, def], idx) => {
    const isSelected = scrollOffset + idx === currentIndex;
    const nameWidth = 34;
    const displayName =
      def.name.length > nameWidth ? def.name.slice(0, nameWidth - 3) + "..." : def.name;
    const idWidth = 26;
    const displayId = id.length > idWidth ? id.slice(0, idWidth - 3) + "..." : id;

    return Box(
      {
        flexDirection: "row",
        paddingX: 1,
        backgroundColor: isSelected ? theme.selectedBg : theme.backgroundPanel,
        width: listWidth,
      },
      Text({
        content: `${isSelected ? "▶ " : "  "}${displayName.padEnd(nameWidth)}`,
        fg: isSelected ? theme.selectedText : theme.text,
      }),
      Text({
        content: displayId,
        fg: isSelected ? theme.selectedText : theme.textMuted,
      }),
    );
  });

  return {
    element: Box(
      { flexDirection: "column", gap: 0, width: listWidth },
      Text({
        content: ` Antigravity Models (${models.length} registered):`,
        fg: theme.primary,
      }),
      Text({
        content: `   ${"Model Name".padEnd(34)}${"OpenCode Model ID"}`,
        fg: theme.textMuted,
      }),
      ...rows,
    ),
    helpText: "[Up/Down] navigate  [r] Refresh from Google API & OpenCode  [Esc] Back",
  };
}