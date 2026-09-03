import type { VNode } from "@opentui/core";
import type { ProviderId } from "../types.js";

export type Screen =
  | "provider-tabs"
  | "list"
  | "key-selector"
  | "key-actions"
  | "add-name"
  | "add-key"
  | "oauth-login"
  | "rename"
  | "confirm-delete"
  | "theme-selector"
  | "export-path"
  | "import-path"
  | "confirm-import"
  | "fallback-menu"
  | "fallback-chain"
  | "fallback-settings"
  | "model-selector"
  | "antigravity-models";

export interface SelectOption {
  name: string;
  description: string;
  value: string;
}

export interface ScreenContent {
  element: VNode;
  helpText: string;
}

export type ActiveTab = "keys" | "fallback";

export type ProviderTab = ProviderId;

export { ProviderId };