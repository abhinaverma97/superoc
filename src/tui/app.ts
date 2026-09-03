import { Box, Text } from "@opentui/core";
import pkg from "../../package.json" with { type: "json" };
import { getActiveTheme, setPreviewTheme } from "../themes.js";
import { getActiveKeys } from "../storage.js";
import {
  state,
  setNavigate,
  setRenderApp,
  callRenderApp,
  refreshStore,
} from "./state.js";
import type { Screen } from "./types.js";
import {
  buildProviderTabs,
  buildMainMenu,
  buildKeySelector,
  buildKeyActions,
  buildThemeSelector,
  buildConfirmDelete,
  buildAddNameInput,
  buildAddKeyInput,
  buildOAuthLoginScreen,
  buildRenameInput,
  buildExportPathInput,
  buildImportPathInput,
  buildConfirmImport,
  buildFallbackMenu,
  buildFallbackChain,
  buildFallbackSettings,
  buildModelSelector,
  getFilteredModelsForSelector,
  buildAntigravityModelsScreen,
} from "./screens.js";
import {
  handleFallbackChainKey,
  addFallbackModel,
  cancelBenchmark,
  handleRefreshAntigravityModels,
} from "./actions.js";
import { openUrlInBrowser } from "../antigravity.js";
import { syncOpencodeModels, syncOpencodeAuth } from "../opencode-sync.js";

export function initApp(): void {
  // Ensure opencode config and auth are in sync whenever superoc is launched
  try {
    syncOpencodeModels();
    syncOpencodeAuth();
  } catch {}

  setNavigate((screen: Screen) => {
    state.currentScreen = screen;
    renderApp();
  });

  setRenderApp(renderApp);

  if (!state.renderer) return;
  state.renderer.keyInput.on(
    "keypress",
    (key: { name: string; ctrl: boolean; shift: boolean }) => {
      if (key.name === "tab") {
        if (state.currentScreen === "provider-tabs") return;
        state.activeTab = state.activeTab === "keys" ? "fallback" : "keys";
        if (state.activeTab === "keys") {
          navigateTo("list");
        } else {
          navigateTo("fallback-menu");
        }
        return;
      }

      if (key.name === "1") {
        if (state.currentScreen === "provider-tabs") return;
        state.activeTab = "keys";
        navigateTo("list");
        return;
      }

      if (key.name === "2") {
        if (state.currentScreen === "provider-tabs") return;
        state.activeTab = "fallback";
        if (state.activeProvider === "antigravity") {
          navigateTo("antigravity-models");
        } else {
          navigateTo("fallback-menu");
        }
        return;
      }

      if (key.name === "escape") {
        switch (state.currentScreen) {
          case "provider-tabs":
            return;
          case "list":
            navigateTo("provider-tabs");
            return;
          case "key-selector":
            return navigateTo("list");
          case "key-actions":
            return navigateTo("key-selector");
          case "add-name":
          case "add-key":
            state.pendingKeyName = "";
            return navigateTo("list");
          case "oauth-login":
            if (state.oauthCleanup) {
              state.oauthCleanup();
              state.oauthCleanup = null;
            }
            state.pendingOAuthUrl = "";
            state.pendingOAuthState = "";
            return navigateTo("list");
          case "rename":
            state.renameTargetId = null;
            return navigateTo("key-actions");
          case "confirm-delete":
            state.deleteTargetId = null;
            return navigateTo("key-actions");
          case "theme-selector":
            setPreviewTheme(null);
            return navigateTo("list");
          case "export-path":
            return navigateTo("list");
          case "import-path":
            return navigateTo("list");
          case "confirm-import":
            state.pendingImportPath = "";
            state.pendingImportResult = null;
            return navigateTo("list");
          case "fallback-menu":
            return navigateTo("list");
          case "fallback-chain":
            cancelBenchmark();
            return navigateTo("fallback-menu");
          case "fallback-settings":
            return navigateTo("fallback-menu");
          case "model-selector":
            state.modelSearchQuery = "";
            return navigateTo("fallback-chain");
          case "antigravity-models":
            return navigateTo("list");
        }
      }

      if (key.ctrl && key.name === "c") {
        if (state.oauthCleanup) {
          state.oauthCleanup();
          state.oauthCleanup = null;
        }
        if (state.renderer) state.renderer.destroy();
        process.exit(0);
      }

      if (state.currentScreen === "oauth-login") {
        if (key.name === "o" && state.pendingOAuthUrl) {
          openUrlInBrowser(state.pendingOAuthUrl);
          return;
        }
      }

      if (state.currentScreen === "antigravity-models") {
        if (key.name === "up") {
          state.modelSelectorIndex["antigravity"] = Math.max(
            0,
            (state.modelSelectorIndex["antigravity"] || 0) - 1,
          );
          callRenderApp();
          return;
        } else if (key.name === "down") {
          state.modelSelectorIndex["antigravity"] =
            (state.modelSelectorIndex["antigravity"] || 0) + 1;
          callRenderApp();
          return;
        } else if (key.name === "r") {
          handleRefreshAntigravityModels();
          return;
        }
      }

      if (state.currentScreen === "fallback-chain") {
        handleFallbackChainKey(key.name);
        return;
      }

      if (state.currentScreen === "model-selector") {
        const filteredModels = getFilteredModelsForSelector();
        if (key.name === "up") {
          if (filteredModels.length === 0) return;
          state.modelSelectorIndex[state.activeProvider] = Math.max(0, state.modelSelectorIndex[state.activeProvider] - 1);
          callRenderApp();
          return;
        } else if (key.name === "down") {
          if (filteredModels.length === 0) return;
          state.modelSelectorIndex[state.activeProvider] = Math.min(
            filteredModels.length - 1,
            state.modelSelectorIndex[state.activeProvider] + 1,
          );
          callRenderApp();
          return;
        } else if (key.name === "return" || key.name === "enter") {
          if (
            state.modelSelectorIndex[state.activeProvider] >= 0 &&
            state.modelSelectorIndex[state.activeProvider] < filteredModels.length
          ) {
            const model = filteredModels[state.modelSelectorIndex[state.activeProvider]];
            if (model) {
              addFallbackModel(model.id, model.name);
              state.modelSearchQuery = "";
              navigateTo("fallback-chain");
              return;
            }
          }
          const customQuery = state.modelSearchQuery.trim();
          if (customQuery.length > 0) {
            addFallbackModel(customQuery, customQuery);
            state.modelSearchQuery = "";
            navigateTo("fallback-chain");
          }
          return;
        } else if (key.name === "backspace") {
          state.modelSearchQuery = state.modelSearchQuery.slice(0, -1);
          state.modelSelectorIndex[state.activeProvider] = 0;
          callRenderApp();
          return;
        } else if (key.name === "r" && state.modelSearchQuery === "") {
          state.modelsLoaded[state.activeProvider] = false;
          state.availableModels[state.activeProvider] = [];
          callRenderApp();
          return;
        } else if (key.name && key.name.length === 1) {
          state.modelSearchQuery += key.name;
          state.modelSelectorIndex[state.activeProvider] = 0;
          callRenderApp();
          return;
        }
      }
    },
  );

  renderApp();
}

function navigateTo(screen: Screen): void {
  state.currentScreen = screen;
  renderApp();
}

function renderApp(): void {
  if (state.isRendering) {
    state.renderPending = true;
    return;
  }
  state.isRendering = true;
  try {
    doRenderApp();
  } finally {
    state.isRendering = false;
    if (state.renderPending) {
      state.renderPending = false;
      queueMicrotask(renderApp);
    }
  }
}

function doRenderApp(): void {
  if (!state.renderer) return;
  state.focusTargetId = null;
  for (const child of state.renderer.root.getChildren()) child.destroyRecursively();

  const theme = getActiveTheme();

  const { element: content, helpText }: { element: any; helpText: string } = (() => {
    switch (state.currentScreen) {
      case "provider-tabs":
        return buildProviderTabs();
      case "list":
        return buildMainMenu();
      case "key-selector":
        return buildKeySelector();
      case "key-actions":
        return buildKeyActions();
      case "theme-selector":
        return buildThemeSelector();
      case "confirm-delete":
        return buildConfirmDelete();
      case "add-name":
        return buildAddNameInput();
      case "add-key":
        return buildAddKeyInput();
      case "oauth-login":
        return buildOAuthLoginScreen();
      case "rename":
        return buildRenameInput();
      case "export-path":
        return buildExportPathInput();
      case "import-path":
        return buildImportPathInput();
      case "confirm-import":
        return buildConfirmImport();
      case "fallback-menu":
        return buildFallbackMenu();
      case "fallback-chain":
        return buildFallbackChain();
      case "fallback-settings":
        return buildFallbackSettings();
      case "model-selector":
        return buildModelSelector();
      case "antigravity-models":
        return buildAntigravityModelsScreen();
    }
  })();

  const isProviderTabs = state.currentScreen === "provider-tabs";
  const isKeysTab = state.activeTab === "keys";

  let tabBar: any;
  if (isProviderTabs) {
    tabBar = Box({ flexDirection: "row", gap: 2 });
  } else {
    tabBar = Box(
      { flexDirection: "row", gap: 1 },
      Text({
        content: "[1]",
        fg: isKeysTab ? theme.primary : theme.textMuted,
      }),
      Text({
        content: state.activeProvider === "antigravity" ? "Account Rotation" : "API Key Rotation",
        fg: isKeysTab ? theme.primary : theme.textMuted,
      }),
      Text({ content: " | ", fg: theme.textMuted }),
      Text({
        content: "[2]",
        fg: !isKeysTab ? theme.primary : theme.textMuted,
      }),
      Text({
        content: state.activeProvider === "antigravity" ? "Models" : "Model Fallback Chain",
        fg: !isKeysTab ? theme.primary : theme.textMuted,
      }),
    );
  }

  const providerName =
    state.activeProvider === "nvidia"
      ? "NVIDIA NIM"
      : state.activeProvider === "google"
      ? "Google Gemini"
      : "Antigravity";

  const title = Box(
    { flexDirection: "row", gap: 2 },
    Text({
      id: "title-text",
      content: isProviderTabs ? "SuperOC" : `${providerName} Key Rotator`,
      fg: theme.primary,
    }),
    Text({
      id: "version-text",
      content: `v${pkg.version}`,
      fg: theme.textMuted,
    }),
  );

  const activeKeysCount = getActiveKeys(state.store, state.activeProvider).length;
  const totalKeysCount = state.store.keys.filter((k) => k.provider === state.activeProvider).length;
  const modelsCount = state.store.fallbackChains[state.activeProvider]?.length ?? 0;

  const status = Box(
    { flexDirection: "row", gap: 2 },
    Text({
      id: "keys-count",
      content: `${state.activeProvider === "antigravity" ? "Accounts" : "Keys"}: ${totalKeysCount}`,
      fg: theme.textMuted,
    }),
    Text({
      id: "active-count",
      content: `Active: ${activeKeysCount}`,
      fg: theme.success,
    }),
    Text({
      id: "models-count",
      content: `Models: ${modelsCount}`,
      fg: theme.textMuted,
    }),
    Text({
      id: "rl-threshold",
      content: `RL: ${state.store.maxRateLimitFailures}`,
      fg: theme.textMuted,
    }),
    Text({
      id: "status-text",
      content: state.statusMessage,
      fg: state.statusColor,
    }),
  );

  const help = Box({ flexDirection: "row" }, Text({ id: "help-text", content: helpText, fg: theme.textMuted }));

  state.renderer.root.add(
    Box(
      {
        id: "screen-root",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        width: "100%",
        height: "100%",
        backgroundColor: theme.background,
      },
      Box(
        {
          id: "panel",
          flexDirection: "column",
          paddingX: 2,
          paddingY: 1,
          border: true,
          borderStyle: "rounded",
          borderColor: theme.border,
          gap: 1,
          backgroundColor: theme.backgroundPanel,
        },
        tabBar,
        title,
        status,
        content,
        help,
      ),
    ),
  );

  if (state.focusTargetId) {
    const renderable = state.renderer.root.findDescendantById(state.focusTargetId);
    if (renderable && typeof renderable.focus === "function") renderable.focus();
  }
}