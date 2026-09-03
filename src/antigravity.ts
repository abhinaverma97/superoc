import crypto from "crypto";
import http from "http";
import { spawn } from "child_process";

export function openUrlInBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
        detached: true,
        stdio: "ignore",
      }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch (err) {
    console.debug("[superoc] Failed to auto-open browser:", err);
  }
}

const charArrToString = (codes: number[]) => String.fromCharCode(...codes);

export const ANTIGRAVITY_CLIENT_ID = charArrToString([
  49, 48, 55, 49, 48, 48, 54, 48, 54, 48, 53, 57, 49, 45, 116, 109, 104, 115, 115, 105, 110,
  50, 104, 50, 49, 108, 99, 114, 101, 50, 51, 53, 118, 116, 111, 108, 111, 106, 104, 52, 103,
  52, 48, 51, 101, 112, 46, 97, 112, 112, 115, 46, 103, 111, 111, 103, 108, 101, 117, 115,
  101, 114, 99, 111, 110, 116, 101, 110, 116, 46, 99, 111, 109,
]);

export const ANTIGRAVITY_CLIENT_SECRET = charArrToString([
  71, 79, 67, 83, 80, 88, 45, 75, 53, 56, 70, 87, 82, 52, 56, 54, 76, 100, 76, 74, 49, 109,
  76, 66, 56, 115, 88, 67, 52, 122, 54, 113, 68, 65, 102,
]);
export const ANTIGRAVITY_REDIRECT_URI = "http://localhost:51121/oauth-callback";
export const ANTIGRAVITY_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

export const ANTIGRAVITY_ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_ENDPOINT_DAILY = "https://daily-cloudcode-pa.sandbox.googleapis.com";
export const ANTIGRAVITY_DEFAULT_PROJECT_ID = "rising-fact-p41fc";
export const ANTIGRAVITY_VERSION = "1.18.3";

export interface PKCEPair {
  verifier: string;
  challenge: string;
}

export function generatePKCE(): PKCEPair {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

export function encodeState(payload: { verifier: string; projectId: string }): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeState(state: string): { verifier: string; projectId: string } {
  try {
    const normalized = state.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "=",
    );
    const json = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    if (typeof parsed.verifier !== "string") {
      throw new Error("Missing PKCE verifier in state");
    }
    return {
      verifier: parsed.verifier,
      projectId: typeof parsed.projectId === "string" ? parsed.projectId : "",
    };
  } catch (err) {
    throw new Error(`Failed to decode state: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function authorizeAntigravity(projectId: string = ""): {
  url: string;
  verifier: string;
  projectId: string;
  state: string;
} {
  const pkce = generatePKCE();
  const stateStr = encodeState({ verifier: pkce.verifier, projectId: projectId || "" });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", ANTIGRAVITY_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", ANTIGRAVITY_REDIRECT_URI);
  url.searchParams.set("scope", ANTIGRAVITY_SCOPES.join(" "));
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", stateStr);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");

  return {
    url: url.toString(),
    verifier: pkce.verifier,
    projectId: projectId || "",
    state: stateStr,
  };
}

export async function fetchProjectID(accessToken: string): Promise<string> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": "google-api-nodejs-client/9.15.1",
    "Client-Metadata": `{"ideType":"ANTIGRAVITY","platform":"${process.platform === "win32" ? "WINDOWS" : "MACOS"}","pluginType":"GEMINI"}`,
  };

  const endpoints = [ANTIGRAVITY_ENDPOINT_PROD, ANTIGRAVITY_ENDPOINT_DAILY];
  for (const endpoint of endpoints) {
    try {
      const res = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          metadata: {
            ideType: "ANTIGRAVITY",
            platform: process.platform === "win32" ? "WINDOWS" : "MACOS",
            pluginType: "GEMINI",
          },
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) continue;
      const data = (await res.json()) as Record<string, unknown>;
      if (typeof data.cloudaicompanionProject === "string" && data.cloudaicompanionProject) {
        return data.cloudaicompanionProject;
      }
      if (
        data.cloudaicompanionProject &&
        typeof (data.cloudaicompanionProject as Record<string, string>).id === "string"
      ) {
        return (data.cloudaicompanionProject as Record<string, string>).id;
      }
    } catch {
      // Continue to next endpoint
    }
  }
  return ANTIGRAVITY_DEFAULT_PROJECT_ID;
}

export interface ExchangeResultSuccess {
  type: "success";
  refresh: string;
  access: string;
  expires: number;
  email: string;
  projectId: string;
}

export interface ExchangeResultFailed {
  type: "failed";
  error: string;
}

export type ExchangeResult = ExchangeResultSuccess | ExchangeResultFailed;

export async function exchangeAntigravity(code: string, stateStr?: string): Promise<ExchangeResult> {
  try {
    let verifier = "";
    let projectId = "";
    if (stateStr) {
      try {
        const decoded = decodeState(stateStr);
        verifier = decoded.verifier;
        projectId = decoded.projectId;
      } catch {
        // Fallback if state format differs
      }
    }

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Accept: "*/*",
        "User-Agent": "google-api-nodejs-client/9.15.1",
      },
      body: new URLSearchParams({
        client_id: ANTIGRAVITY_CLIENT_ID,
        client_secret: ANTIGRAVITY_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: ANTIGRAVITY_REDIRECT_URI,
        ...(verifier ? { code_verifier: verifier } : {}),
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      return { type: "failed", error: errorText };
    }

    const tokenPayload = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
      headers: {
        Authorization: `Bearer ${tokenPayload.access_token}`,
        "User-Agent": "google-api-nodejs-client/9.15.1",
      },
      signal: AbortSignal.timeout(10000),
    });

    const userInfo = userInfoResponse.ok
      ? ((await userInfoResponse.json()) as { email?: string })
      : {};

    const refreshToken = tokenPayload.refresh_token;
    if (!refreshToken) {
      return { type: "failed", error: "Missing refresh_token in OAuth response" };
    }

    let effectiveProjectId = projectId;
    if (!effectiveProjectId) {
      effectiveProjectId = await fetchProjectID(tokenPayload.access_token);
    }

    const storedRefresh = `${refreshToken}|${effectiveProjectId || ANTIGRAVITY_DEFAULT_PROJECT_ID}`;
    const expiresAt = Date.now() + Math.max(0, (tokenPayload.expires_in - 300)) * 1000;

    return {
      type: "success",
      refresh: storedRefresh,
      access: tokenPayload.access_token,
      expires: expiresAt,
      email: userInfo.email ?? "antigravity-user",
      projectId: effectiveProjectId || ANTIGRAVITY_DEFAULT_PROJECT_ID,
    };
  } catch (err) {
    return {
      type: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function refreshAntigravityAccessToken(refreshTokenKey: string): Promise<{
  accessToken: string;
  expiresAt: number;
  projectId: string;
} | null> {
  const parts = refreshTokenKey.split("|");
  const actualRefreshToken = parts[0];
  const projectId = parts[1] || ANTIGRAVITY_DEFAULT_PROJECT_ID;

  if (!actualRefreshToken) return null;

  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Accept: "*/*",
        "User-Agent": "google-api-nodejs-client/9.15.1",
      },
      body: new URLSearchParams({
        client_id: ANTIGRAVITY_CLIENT_ID,
        client_secret: ANTIGRAVITY_CLIENT_SECRET,
        refresh_token: actualRefreshToken,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.warn("[superoc] Antigravity token refresh failed:", res.status, await res.text());
      return null;
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    const expiresAt = Date.now() + Math.max(0, (data.expires_in - 300)) * 1000;

    return {
      accessToken: data.access_token,
      expiresAt,
      projectId,
    };
  } catch (err) {
    console.error("[superoc] Network/SSL Error refreshing Antigravity access token:", err);
    return null;
  }
}

const tokenCache = new Map<string, { accessToken: string; expiresAt: number; projectId: string }>();

export async function getOrRefreshAntigravityAccessToken(keyString: string): Promise<{
  accessToken: string;
  projectId: string;
} | null> {
  if (keyString.startsWith("ya29.")) {
    const parts = keyString.split("|");
    return {
      accessToken: parts[0],
      projectId: parts[1] || ANTIGRAVITY_DEFAULT_PROJECT_ID,
    };
  }

  const cached = tokenCache.get(keyString);
  if (cached && cached.expiresAt > Date.now()) {
    return { accessToken: cached.accessToken, projectId: cached.projectId };
  }

  const refreshed = await refreshAntigravityAccessToken(keyString);
  if (!refreshed) return null;

  tokenCache.set(keyString, refreshed);
  return { accessToken: refreshed.accessToken, projectId: refreshed.projectId };
}

export function getAntigravityHeaders(accessToken: string, projectId?: string): Record<string, string> {
  const platform = process.platform === "win32" ? "WINDOWS" : "MACOS";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    authorization: `Bearer ${accessToken}`,
    "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/${ANTIGRAVITY_VERSION} Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36`,
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": `{"ideType":"ANTIGRAVITY","platform":"${platform}","pluginType":"GEMINI"}`,
  };

  if (projectId) {
    headers["x-goog-user-project"] = projectId;
  }

  return headers;
}

export async function fetchLiveAntigravityModels(
  accessToken?: string,
  projectId?: string,
): Promise<Array<{ id: string; name: string }>> {
  const defaultModels = [
    { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash" },
    { id: "gemini-3.7-flash-tiered", name: "Gemini 3.7 Flash (Tiered)" },
    { id: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (Thinking High)" },
    { id: "gemini-3.6-flash-medium", name: "Gemini 3.6 Flash (Thinking Medium)" },
    { id: "gemini-3.6-flash-low", name: "Gemini 3.6 Flash (Thinking Low)" },
    { id: "gemini-pro-agent", name: "Gemini Pro Agent" },
    { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Thinking Low)" },
    { id: "gemini-3-flash-agent", name: "Gemini 3 Flash Agent" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 Thinking" },
    { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
  ];

  if (!accessToken) return defaultModels;

  const endpoints = [
    `${ANTIGRAVITY_ENDPOINT_PROD}/v1internal:fetchAvailableModels`,
    `${ANTIGRAVITY_ENDPOINT_DAILY}/v1internal:fetchAvailableModels`,
  ];

  const fetchedMap = new Map<string, { id: string; name: string }>();
  let recommendedIds: string[] = [];

  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/1.18.3 Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36",
          "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
          "Client-Metadata": `{"ideType":"ANTIGRAVITY","platform":"${process.platform === "win32" ? "WINDOWS" : "MACOS"}","pluginType":"GEMINI"}`,
        },
        body: JSON.stringify(projectId ? { project: projectId } : {}),
        signal: AbortSignal.timeout(10000),
      });

      if (res.ok) {
        const data = (await res.json()) as {
          models?: Record<string, { displayName?: string; isInternal?: boolean }>;
          agentModelSorts?: Array<{ groups?: Array<{ modelIds?: string[] }> }>;
          tieredModelIds?: Record<string, string[]>;
        };

        if (data.agentModelSorts?.[0]?.groups?.[0]?.modelIds && recommendedIds.length === 0) {
          recommendedIds = data.agentModelSorts[0].groups[0].modelIds;
        }

        // Add tiered models (like gemini-3.8-flash-tiered and gemini-3.8-flash)
        if (data.tieredModelIds) {
          for (const list of Object.values(data.tieredModelIds)) {
            if (Array.isArray(list)) {
              for (const tId of list) {
                if (tId && typeof tId === "string") {
                  const formatted = tId
                    .split("-")
                    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                    .join(" ");
                  fetchedMap.set(tId, { id: tId, name: formatted });
                  if (tId.endsWith("-tiered")) {
                    const baseId = tId.replace(/-tiered$/, "");
                    const baseFormatted = baseId
                      .split("-")
                      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                      .join(" ");
                    fetchedMap.set(baseId, { id: baseId, name: baseFormatted });
                  }
                }
              }
            }
          }
        }

        if (data.models && typeof data.models === "object") {
          for (const [modelId, info] of Object.entries(data.models)) {
            if (
              info.isInternal ||
              modelId.startsWith("chat_") ||
              modelId.startsWith("tab_") ||
              modelId.startsWith("models/") ||
              modelId.includes("transcription")
            ) {
              continue;
            }

            const rawName = info.displayName;
            const cleanName =
              rawName && rawName !== "undefined"
                ? rawName
                : modelId
                    .split("-")
                    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                    .join(" ");

            if (!fetchedMap.has(modelId)) {
              fetchedMap.set(modelId, {
                id: modelId,
                name: cleanName,
              });
            }

            if (modelId.endsWith("-tiered")) {
              const baseId = modelId.replace(/-tiered$/, "");
              if (!fetchedMap.has(baseId)) {
                const baseClean = cleanName.replace(/\s*\(?Tiered\)?/i, "").trim();
                fetchedMap.set(baseId, {
                  id: baseId,
                  name: baseClean || cleanName,
                });
              }
            }
          }
        }
      }
    } catch (err) {
      console.debug("[superoc] fetchAvailableModels failed on", endpoint, err);
    }
  }

  if (fetchedMap.size > 0) {
    const sortedList: Array<{ id: string; name: string }> = [];
    for (const recId of recommendedIds) {
      const m = fetchedMap.get(recId);
      if (m) {
        sortedList.push(m);
        fetchedMap.delete(recId);
      }
    }

    for (const remaining of fetchedMap.values()) {
      sortedList.push(remaining);
    }

    return sortedList;
  }

  return defaultModels;
}

export function startLocalCallbackServer(
  onCodeReceived: (code: string, state?: string) => void,
  port: number = 51121,
): () => void {
  const server = http.createServer((req, res) => {
    try {
      const reqUrl = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (reqUrl.pathname === "/oauth-callback") {
        const code = reqUrl.searchParams.get("code");
        const state = reqUrl.searchParams.get("state");

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          `<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#1e1e1e;color:#fff;">
            <h2>Authorization Successful!</h2>
            <p>You can close this window and return to your terminal / OpenCode.</p>
          </body></html>`,
        );

        if (code) {
          onCodeReceived(code, state ?? undefined);
        }
        setImmediate(() => server.close());
      } else {
        res.writeHead(404);
        res.end();
      }
    } catch {
      res.writeHead(500);
      res.end();
    }
  });

  server.listen(port);
  return () => {
    try {
      server.close();
    } catch {}
  };
}
