import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin";
import {
  loadStore,
  saveStore,
  addKey,
  getNextKey,
  getActiveKeys,
  getDefaultStore,
  recordRateLimit,
  resetRateLimit,
  recordModelRateLimit,
} from "./storage.js";
import type { KeyStore, KeyStoreConfig, FallbackModel, ProviderId } from "./types.js";
import {
  extractStatus,
  describeError,
  is429Error,
  isStatusMessageRateLimited,
  shouldRetryForError,
  type SessionState,
} from "./errors.js";
import { detectProviderForRequest, getProviderHeaders } from "./provider.js";
import {
  authorizeAntigravity,
  exchangeAntigravity,
  getOrRefreshAntigravityAccessToken,
  getAntigravityHeaders,
  fetchLiveAntigravityModels,
} from "./antigravity.js";
import { BASE_ANTIGRAVITY_MODELS, syncOpencodeModels, syncOpencodeAuth } from "./opencode-sync.js";

const PROVIDERS: ProviderId[] = ["nvidia", "google", "antigravity"];
const NIM_BASE_URL = "https://integrate.api.nvidia.com";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
const VALID_STRATEGIES = ["round-robin", "least-failures"] as const;

if (!process.env.OPENCODE_ENABLE_EXA) {
  process.env.OPENCODE_ENABLE_EXA = "1";
}

function isValidStrategy(val: unknown): val is KeyStoreConfig["rotationStrategy"] {
  return val === "round-robin" || val === "least-failures";
}

function modelKey(model: { providerID: string; modelID: string }): string {
  return `${model.providerID}/${model.modelID}`;
}

function getEnvKeyName(provider: ProviderId): string {
  if (provider === "nvidia") return "NVIDIA_API_KEY";
  if (provider === "google") return "GOOGLE_API_KEY";
  return "ANTIGRAVITY_API_KEY";
}

function isProviderRequest(provider: ProviderId, modelApiStr: string, providerId: string | undefined, modelProviderId: string | undefined): boolean {
  const detected = detectProviderForRequest({
    provider: { info: { id: providerId } },
    model: { providerID: modelProviderId, api: modelApiStr },
  });
  return detected === provider;
}

async function isSubagentSession(client: PluginInput["client"], sessionID: string): Promise<boolean> {
  try {
    const res = await (client.session as unknown as {
      get: (p: { path: { id: string } }) => Promise<unknown>;
    }).get({ path: { id: sessionID } });
    const data = res && typeof res === "object" && "data" in res
      ? (res as { data: unknown }).data
      : res;
    if (!data || typeof data !== "object") return false;
    return (data as Record<string, unknown>)?.parentID !== undefined;
  } catch (err) {
    console.debug(`[superoc] isSubagentSession failed for ${sessionID}:`, err);
    return false;
  }
}

const SUBAGENT_CACHE_MAX_SIZE = 1000;
const SUBAGENT_CACHE_TTL_MS = 60_000;
const ERROR_DEDUP_WINDOW_MS = 500;
const SESSIONS_MAX_SIZE = 500;
const SESSIONS_MAX_AGE_MS = 10 * 60 * 1000;

const subAgentCache = new Map<string, number>();

async function isSubagentSessionCached(client: PluginInput["client"], sessionID: string): Promise<boolean> {
  const cached = subAgentCache.get(sessionID);
  if (cached !== undefined) {
    if (cached > Date.now()) return true;
    subAgentCache.delete(sessionID);
  }
  const result = await isSubagentSession(client, sessionID);
  if (result) {
    if (subAgentCache.size >= SUBAGENT_CACHE_MAX_SIZE) {
      const firstKey = subAgentCache.keys().next().value;
      if (firstKey !== undefined) subAgentCache.delete(firstKey);
    }
    subAgentCache.set(sessionID, Date.now() + SUBAGENT_CACHE_TTL_MS);
  }
  return result;
}

function findChainIndex(chain: FallbackModel[], model: { providerID: string; modelID: string } | undefined): number {
  if (!model) return -1;
  return chain.findIndex((entry) => entry.id === model.modelID);
}

function createSseUnwrapTransform(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data:")) {
          const jsonStr = line.slice(5).trim();
          if (!jsonStr) {
            controller.enqueue(encoder.encode(line + "\n"));
            continue;
          }
          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed.response !== undefined) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed.response)}\n`));
              continue;
            }
          } catch {}
        }
        controller.enqueue(encoder.encode(line + "\n"));
      }
    },
    flush(controller) {
      if (buffer.length > 0) {
        if (buffer.startsWith("data:")) {
          const jsonStr = buffer.slice(5).trim();
          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed.response !== undefined) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed.response)}\n`));
              return;
            }
          } catch {}
        }
        controller.enqueue(encoder.encode(buffer));
      }
    },
  });
}

function createAntigravityFetch(
  store: KeyStore,
  config: KeyStoreConfig,
  reloadFromDisk: () => void,
  safeSaveStore: () => void,
) {
  return async (
    input: string | URL | Request,
    init?: RequestInit,
    fallbackFetch: typeof fetch = fetch,
  ): Promise<Response> => {
    const urlString =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;

    if (urlString.includes("generativelanguage.googleapis.com") || urlString.includes("antigravity")) {
      const match = urlString.match(/\/models\/([^:]+):(\w+)/);
      const rawModel = match ? match[1] : "";
      const action = match ? match[2] : "streamGenerateContent";
      const isStreaming = action === "streamGenerateContent" || urlString.includes("alt=sse");

      const isAntigravityModel =
        rawModel.startsWith("antigravity-") ||
        rawModel in BASE_ANTIGRAVITY_MODELS ||
        /claude|gpt-oss|gemini-3|gemini-pro-agent/i.test(rawModel);

      reloadFromDisk();
      const activeAntigravityKeys = getActiveKeys(store, "antigravity");

      if (isAntigravityModel || activeAntigravityKeys.length > 0) {
        if (init?.signal?.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        let attempts = 0;
        let lastResponse: Response | null = null;
        const maxAttempts = Math.max(1, activeAntigravityKeys.length);
        while (attempts < maxAttempts) {
          if (init?.signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
          }
          attempts++;
          const next = getNextKey(store, config, rawModel, "antigravity");
          if (!next) break;

          const authRes = await getOrRefreshAntigravityAccessToken(next.key.key);
          if (!authRes) {
            continue;
          }

          if (init?.signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
          }

          const effectiveModel = rawModel.replace(/^antigravity-/, "");
          const candidateModels = [effectiveModel];
          if (
            !effectiveModel.endsWith("-tiered") &&
            (effectiveModel.includes("flash") || effectiveModel.includes("pro"))
          ) {
            candidateModels.push(`${effectiveModel}-tiered`);
          } else if (effectiveModel.endsWith("-tiered")) {
            candidateModels.push(effectiveModel.replace(/-tiered$/, ""));
          }

          let bodyStr = init?.body;
          let parsedBody = typeof bodyStr === "string" ? JSON.parse(bodyStr) : bodyStr;

          const headers = new Headers(init?.headers ?? {});
          headers.set("Authorization", `Bearer ${authRes.accessToken}`);
          headers.set(
            "User-Agent",
            `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/1.18.3 Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36`,
          );
          headers.set("X-Goog-Api-Client", "google-cloud-sdk vscode_cloudshelleditor/0.1");
          headers.set(
            "Client-Metadata",
            `{"ideType":"ANTIGRAVITY","platform":"WINDOWS","pluginType":"GEMINI"}`,
          );
          headers.delete("x-goog-api-key");
          headers.delete("x-api-key");
          headers.delete("x-goog-user-project");
          const endpoints = [
            "https://daily-cloudcode-pa.sandbox.googleapis.com",
            "https://cloudcode-pa.googleapis.com",
          ];

          let gotRes: Response | null = null;
          endpointLoop: for (const ep of endpoints) {
            if (init?.signal?.aborted) {
              throw new DOMException("The operation was aborted.", "AbortError");
            }
            for (const candidate of candidateModels) {
              if (init?.signal?.aborted) {
                throw new DOMException("The operation was aborted.", "AbortError");
              }
              const transformedUrl = `${ep}/v1internal:${action}${isStreaming ? "?alt=sse" : ""}`;
              const wrappedBody = JSON.stringify({
                project: authRes.projectId || "rising-fact-p41fc",
                model: candidate,
                request: parsedBody,
                requestType: "agent",
                userAgent: "antigravity",
              });
              try {
                const r = await fetch(transformedUrl, {
                  ...init,
                  headers,
                  body: wrappedBody,
                });
                if (r.ok) {
                  gotRes = r;
                  break endpointLoop;
                }
                if (r.status === 429) {
                  gotRes = r;
                }
              } catch (netErr: any) {
                if (netErr?.name === "AbortError" || init?.signal?.aborted) {
                  throw netErr;
                }
                if (process.env.SUPEROC_DEBUG === "true") {
                  console.warn(`[superoc] Endpoint ${ep} socket/network error:`, netErr);
                }
              }
            }
          }

          if (gotRes) {
            lastResponse = gotRes;
          }

          if (gotRes && gotRes.ok) {
            if (isStreaming && gotRes.body) {
              const transformedStream = gotRes.body.pipeThrough(createSseUnwrapTransform());
              return new Response(transformedStream, {
                status: gotRes.status,
                statusText: gotRes.statusText,
                headers: gotRes.headers,
              });
            }
            return gotRes;
          }

          if (gotRes && gotRes.status === 429) {
            recordRateLimit(store, next.key.id);
            recordModelRateLimit(store, next.key.id, rawModel);
            safeSaveStore();
            continue;
          }

          if (gotRes) return gotRes;
        }

        if (isAntigravityModel) {
          if (lastResponse) return lastResponse;
          return new Response(
            JSON.stringify({
              error: {
                code: 429,
                message: "All Antigravity accounts are currently rate limited or exhausted.",
                status: "RESOURCE_EXHAUSTED",
              },
            }),
            { status: 429, headers: { "Content-Type": "application/json" } },
          );
        }
      }
    }

    return (fallbackFetch || fetch)(input as any, init);
  };
}

function installGlobalFetchInterceptor(fetchHandler: (input: any, init?: any, orig?: any) => Promise<Response>) {
  if (!(globalThis as any).__superoc_fetch_installed) {
    (globalThis as any).__superoc_fetch_installed = true;
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async function (input: any, init?: any) {
      return fetchHandler(input, init, origFetch);
    };
  }
}

export const SuperocPlugin: Plugin = async (input: PluginInput, options?: Record<string, unknown>) => {
  const client = input.client;
  const config: KeyStoreConfig = {
    storePath: options?.storePath as string | undefined,
    rotationStrategy: isValidStrategy(options?.rotationStrategy)
      ? options!.rotationStrategy
      : "round-robin",
  };

  const store = loadStore(config) ?? getDefaultStore();
  if (!store.fallbackChains) store.fallbackChains = { nvidia: [], google: [], antigravity: [] };

  let activeProviderContextModels: Record<string, any> | undefined;
  const sessions = new Map<string, SessionState>();

  const reloadFromDisk = () => {
    let fresh: KeyStore | null = null;
    try {
      fresh = loadStore(config);
    } catch (err) {
      console.debug("[superoc] Failed to reload store from disk:", err);
      return;
    }
    if (fresh === null) return;
    try {
      store.keys = fresh.keys;
      store.currentIndex = fresh.currentIndex;
      store.rotationStrategy = fresh.rotationStrategy;
      store.updatedAt = fresh.updatedAt;
      store.lastUsedKeyId = fresh.lastUsedKeyId;
      store.fallbackChains = {
        nvidia: Array.isArray(fresh.fallbackChains?.nvidia) ? fresh.fallbackChains.nvidia : [],
        google: Array.isArray(fresh.fallbackChains?.google) ? fresh.fallbackChains.google : [],
        antigravity: Array.isArray(fresh.fallbackChains?.antigravity) ? fresh.fallbackChains.antigravity : [],
      };
      store.maxRateLimitFailures =
        typeof fresh.maxRateLimitFailures === "number" &&
        Number.isFinite(fresh.maxRateLimitFailures) &&
        fresh.maxRateLimitFailures >= 1
          ? fresh.maxRateLimitFailures
          : getDefaultStore().maxRateLimitFailures;
    } catch (err) {
      console.debug("[superoc] Failed to apply reloaded store:", err);
    }
  };

  const safeSaveStore = () => {
    try {
      saveStore(store, config);
    } catch (err) {
      console.error("[superoc] Failed to save store:", err);
    }
  };

  for (const provider of PROVIDERS) {
    const activeKeys = getActiveKeys(store, provider);
    if (activeKeys.length === 0) {
      const envKey = process.env[getEnvKeyName(provider)];
      if (envKey) {
        const existing = store.keys.find((k) => k.name === "env-default" && k.provider === provider);
        if (!existing) {
          addKey(store, "env-default", envKey, provider);
          safeSaveStore();
        }
      }
    }
  }

  const showToast = async (variant: "success" | "info" | "warning" | "error", message: string) => {
    try {
      await client.tui?.showToast?.({ body: { title: "Antigravity Quota", message, variant } });
    } catch (err) {
      console.debug("[superoc] showToast failed:", err);
    }
  };

  const getState = (sessionID: string): SessionState => {
    const existing = sessions.get(sessionID);
    if (existing) return existing;
    if (sessions.size >= SESSIONS_MAX_SIZE) {
      const now = Date.now();
      let oldestId: string | undefined;
      let oldestTime = Infinity;
      for (const [id, s] of sessions) {
        if (s.createdAt < oldestTime) {
          oldestTime = s.createdAt;
          oldestId = id;
        }
      }
      if (oldestId) sessions.delete(oldestId);
      for (const [id, s] of sessions) {
        if (now - s.createdAt > SESSIONS_MAX_AGE_MS) {
          sessions.delete(id);
        }
      }
    }
    const next: SessionState = {
      attemptIndex: 0,
      inRetry: false,
      aborting: false,
      pendingRetryIndex: undefined,
      lastUserMessageID: undefined,
      activeChainKey: undefined,
      activeChainModelId: undefined,
      rateLimitCount: 0,
      currentModelId: undefined,
      lastFailedModelId: undefined,
      lastErrorHandledAt: 0,
      createdAt: Date.now(),
      sessionProviderId: undefined,
      lastUsedKeyId: undefined,
    };
    sessions.set(sessionID, next);
    return next;
  };

  const cleanupSession = (sessionID: string) => {
    sessions.delete(sessionID);
  };

  const waitForSessionIdle = async (sessionID: string, timeoutMs: number = 2000): Promise<boolean> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await client.session.status({});
        const data = res && typeof res === "object" && "data" in res
          ? (res as { data: unknown }).data
          : res;
        if (data && typeof data === "object") {
          const statusMap = data as Record<string, unknown>;
          const status = statusMap[sessionID] as Record<string, unknown> | undefined;
          if (status?.type === "idle") return true;
          if (!status) return true;
        }
      } catch {
        // status endpoint might not be available, keep polling
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    console.debug(`[nimsuper] waitForSessionIdle timed out for ${sessionID}`);
    return false;
  };

  const getChainForProvider = (provider: ProviderId): FallbackModel[] => store.fallbackChains[provider];

  const triggerRetry = async (sessionID: string, state: SessionState, reason?: string): Promise<boolean> => {
    const provider = state.sessionProviderId as ProviderId | undefined ?? "nvidia";
    const chain = getChainForProvider(provider);
    if (chain.length < 2) return false;

    let nextIndex = (state.attemptIndex + 1) % chain.length;
    if (
      state.lastFailedModelId &&
      chain[nextIndex]?.id === state.lastFailedModelId &&
      chain.length > 2
    ) {
      nextIndex = (nextIndex + 1) % chain.length;
    }
    state.inRetry = true;
    state.pendingRetryIndex = nextIndex;

    try {
      const source = chain[state.attemptIndex];
      const target = chain[nextIndex];
      if (!source || !target) return false;

      await showToast("warning", `${source.name} → ${target.name}${reason ? `: ${reason}` : ""}`);

      const messagesResult = await client.session.messages({ path: { id: sessionID } });
      const entries = messagesResult && "data" in messagesResult ? messagesResult.data : messagesResult;
      if (!Array.isArray(entries)) return false;

      const userMessages = (entries as Array<Record<string, unknown>>).filter(
        (entry) => (entry?.info as Record<string, unknown>)?.role === "user",
      );
      if (userMessages.length === 0) return false;

      const lastUser = userMessages[userMessages.length - 1] as Record<string, unknown>;
      const lastUserInfo = lastUser.info as Record<string, unknown>;
      const lastUserParts = lastUser.parts as Array<Record<string, unknown>>;

      if (
        state.lastUserMessageID &&
        (lastUserInfo?.id as string) !== state.lastUserMessageID
      ) {
        return false;
      }

      const promptParts: Array<{
        type: "text";
        id: string;
        text: string;
        synthetic?: boolean;
        ignored?: boolean;
      }> = [];
      if (Array.isArray(lastUserParts)) {
        for (const part of lastUserParts) {
          if (part?.type === "text") {
            promptParts.push({
              type: "text",
              id: part.id as string,
              text: part.text as string,
              synthetic: part.synthetic as boolean | undefined,
              ignored: part.ignored as boolean | undefined,
            });
          }
        }
      }

      state.aborting = true;
      try {
        await client.session.abort({ path: { id: sessionID } });
      } catch (abortErr) {
        console.debug(`[superoc] abort failed for ${sessionID}:`, abortErr);
      }

      const idle = await waitForSessionIdle(sessionID);
      if (!idle) {
        console.debug(`[superoc] session ${sessionID} did not go idle after abort`);
        state.pendingRetryIndex = undefined;
        return false;
      }

      await client.session.prompt({
        path: { id: sessionID },
        body: {
          messageID: lastUserInfo?.id as string,
          agent: lastUserInfo?.agent as string,
          model: {
            providerID: state.sessionProviderId ?? provider,
            modelID: target.id,
          },
          parts: promptParts,
        },
      });

      return true;
    } catch (err) {
      console.debug(`[superoc] triggerRetry failed for ${sessionID}:`, err);
      state.pendingRetryIndex = undefined;
      return false;
    } finally {
      state.inRetry = false;
    }
  };

  const handleSessionError = async (event: Record<string, unknown>) => {
    const props = event.properties as Record<string, unknown> | undefined;
    const error = props?.error;
    const sessionID = props?.sessionID as string | undefined;

    if (is429Error(error)) {
      const stateForBlacklist = sessionID ? sessions.get(sessionID) : undefined;
      const errorKeyId = stateForBlacklist?.lastUsedKeyId ?? store.lastUsedKeyId;
      reloadFromDisk();
      if (errorKeyId) {
        recordRateLimit(store, errorKeyId);
        const modelForBlacklist = stateForBlacklist?.currentModelId ?? stateForBlacklist?.activeChainModelId;
        if (modelForBlacklist) {
          recordModelRateLimit(store, errorKeyId, modelForBlacklist);
        }
        if (stateForBlacklist) {
          stateForBlacklist.lastFailedModelId = modelForBlacklist;
        }
      }
      safeSaveStore();
    }

    if (!sessionID) return;

    const state = sessions.get(sessionID);
    if (!state) return;
    if (state.aborting) {
      state.aborting = false;
      return;
    }
    if (state.inRetry) return;

    const now = Date.now();
    if (now - state.lastErrorHandledAt < ERROR_DEDUP_WINDOW_MS) return;
    state.lastErrorHandledAt = now;

    if (!shouldRetryForError(error, state)) {
      if (!is429Error(error)) state.rateLimitCount = 0;
      return;
    }

    if (await isSubagentSessionCached(client, sessionID)) {
      if (is429Error(error)) {
        await showToast("warning", "Subagent rate limited — model switch skipped to preserve parent task");
      }
      return;
    }

    if (is429Error(error)) {
      state.rateLimitCount++;
      if (state.rateLimitCount < store.maxRateLimitFailures) return;
    } else {
      state.rateLimitCount = 0;
      return;
    }

    const reason = describeError(error, state, store.maxRateLimitFailures);
    await triggerRetry(sessionID, state, reason);
  };

  const handleSessionStatusRetry = async (sessionID: string, status: Record<string, unknown>) => {
    const message = status.message as string | undefined;
    const is429 = isStatusMessageRateLimited(message);
    if (!is429) return;

    const state = sessions.get(sessionID);
    if (!state) return;
    if (state.inRetry) return;

    if (await isSubagentSessionCached(client, sessionID)) return;

    reloadFromDisk();
    const errorKeyId = state?.lastUsedKeyId ?? store.lastUsedKeyId;
    if (errorKeyId) {
      recordRateLimit(store, errorKeyId);
      const modelForBlacklist = state.currentModelId ?? state.activeChainModelId;
      if (modelForBlacklist) {
        recordModelRateLimit(store, errorKeyId, modelForBlacklist);
      }
      state.lastFailedModelId = modelForBlacklist;
    }
    safeSaveStore();

    state.rateLimitCount++;
    if (state.rateLimitCount < store.maxRateLimitFailures) return;

    const reason = `Rate limited (429) — ${state.rateLimitCount}/${store.maxRateLimitFailures} consecutive`;
    await triggerRetry(sessionID, state, reason);
  };

  const handleSessionStepFailed = async (event: Record<string, unknown>) => {
    const props = event.properties as Record<string, unknown> | undefined;
    const sessionID = props?.sessionID as string | undefined;
    if (!sessionID) return;

    const error = props?.error as Record<string, unknown> | undefined;
    const errorMessage = typeof error?.message === "string" ? error.message : undefined;

    if (!isStatusMessageRateLimited(errorMessage) && !is429Error(error)) return;

    const state = sessions.get(sessionID);
    if (!state) return;
    if (state.inRetry) return;

    const now = Date.now();
    if (now - state.lastErrorHandledAt < ERROR_DEDUP_WINDOW_MS) return;
    state.lastErrorHandledAt = now;

    const errorKeyId = state?.lastUsedKeyId ?? store.lastUsedKeyId;
    reloadFromDisk();
    if (errorKeyId) {
      recordRateLimit(store, errorKeyId);
      const modelForBlacklist = state.currentModelId ?? state.activeChainModelId;
      if (modelForBlacklist) {
        recordModelRateLimit(store, errorKeyId, modelForBlacklist);
      }
      state.lastFailedModelId = modelForBlacklist;
    }
    safeSaveStore();

    if (await isSubagentSessionCached(client, sessionID)) {
      await showToast("warning", "Subagent rate limited — model switch skipped to preserve parent task");
      return;
    }

    state.rateLimitCount++;
    if (state.rateLimitCount < store.maxRateLimitFailures) return;

    const reason = `Rate limited (429) — ${state.rateLimitCount}/${store.maxRateLimitFailures} consecutive`;
    await triggerRetry(sessionID, state, reason);
  };

  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "antigravity-oauth";
  }
  if (!process.env.GEMINI_API_KEY) {
    process.env.GEMINI_API_KEY = "antigravity-oauth";
  }
  syncOpencodeAuth();

  const antigravityFetch = createAntigravityFetch(store, config, reloadFromDisk, safeSaveStore);
  installGlobalFetchInterceptor(antigravityFetch);

  const hooks: Hooks = {
    config: async (cfg: any) => {
      if (!process.env.OPENCODE_ENABLE_EXA) {
        process.env.OPENCODE_ENABLE_EXA = "1";
      }
      if (!cfg.permission) cfg.permission = {};
      if (!cfg.permission.websearch) {
        cfg.permission.websearch = "allow";
      }
      if (!cfg.provider) cfg.provider = {};
      if (!cfg.provider.antigravity) {
        cfg.provider.antigravity = {
          name: "Antigravity",
          npm: "@ai-sdk/google",
          api: "https://generativelanguage.googleapis.com/v1beta",
          apiKey: "antigravity-oauth",
          models: {},
        };
      }
      if (!cfg.provider.antigravity.models) cfg.provider.antigravity.models = {};
      for (const [id, def] of Object.entries(BASE_ANTIGRAVITY_MODELS)) {
        if (!cfg.provider.antigravity.models[id]) {
          cfg.provider.antigravity.models[id] = JSON.parse(JSON.stringify(def));
        }
      }
    },
    auth: {
      provider: "antigravity",
      loader: async (_getAuth, providerContext) => {
        if (providerContext) {
          activeProviderContextModels = providerContext.models;
          if (!providerContext.models) {
            providerContext.models = {};
            activeProviderContextModels = providerContext.models;
          }
          // Dynamically inject Antigravity models immediately (0ms)
          for (const [id, def] of Object.entries(BASE_ANTIGRAVITY_MODELS)) {
            if (!providerContext.models[id]) {
              providerContext.models[id] = JSON.parse(JSON.stringify(def));
            }
          }

          // Asynchronously query live models from both endpoints and register them in-memory
          reloadFromDisk();
          const activeKeys = getActiveKeys(store, "antigravity");
          if (activeKeys.length > 0) {
            getOrRefreshAntigravityAccessToken(activeKeys[0].key)
              .then(async (auth) => {
                if (auth) {
                  try {
                    const liveModels = await fetchLiveAntigravityModels(
                      auth.accessToken,
                      auth.projectId,
                    );
                    for (const m of liveModels) {
                      const cleanId = m.id.replace(/^antigravity-/, "");
                      if (providerContext.models && !providerContext.models[cleanId]) {
                        (providerContext.models as Record<string, any>)[cleanId] = {
                          name: m.name,
                          limit: { context: 1048576, output: 65536 },
                          modalities: { input: ["text", "image", "pdf"], output: ["text"] },
                        };
                      }
                    }
                  } catch (e) {
                    console.debug("[superoc] live model auto-injection failed:", e);
                  }
                }
              })
              .catch(() => {});
          }
        }

        return {
          apiKey: "antigravity-oauth",
          async fetch(input: string | URL | Request, init?: RequestInit) {
            return antigravityFetch(input, init, fetch);
          },
        };
      },
      methods: [
        {
          type: "api",
          label: "Enter NVIDIA NIM API Key",
          async authorize(inputs: Record<string, string>) {
            const key = inputs?.["apiKey"];
            if (!key) return { type: "failed" };
            try {
              const res = await fetch(`${NIM_BASE_URL}/v1/models`, { headers: { Authorization: `Bearer ${key}` } });
              if (!res.ok) return { type: "failed" };
            } catch (err) {
              console.debug("[superoc] authorize fetch failed:", err);
              return { type: "failed" };
            }
            return { type: "success", key, provider: "nvidia" };
          },
        },
        {
          type: "oauth",
          label: "OAuth with Google (Antigravity)",
          async authorize() {
            const auth = authorizeAntigravity();
            return {
              url: auth.url,
              instructions: "Log in with your Google account in your browser",
              method: "code" as const,
              async callback(code: string) {
                const res = await exchangeAntigravity(code, auth.state);
                if (res.type === "success") {
                  return {
                    type: "success" as const,
                    refresh: res.refresh,
                    access: res.access,
                    expires: res.expires,
                    provider: "antigravity",
                  };
                }
                return { type: "failed" as const };
              },
            };
          },
        },
      ],
    },
    "chat.headers": async (_input, _output) => {
      const provider = detectProviderForRequest(_input);
      if (!provider) return;

      reloadFromDisk();
      const prevKeyId = store.lastUsedKeyId;
      const modelIdForRotation = _input.model?.id;
      const next = getNextKey(store, config, modelIdForRotation, provider);
      if (next) {
        if (provider === "antigravity") {
          const authRes = await getOrRefreshAntigravityAccessToken(next.key.key);
          if (authRes) {
            const headers = getAntigravityHeaders(authRes.accessToken, authRes.projectId);
            Object.assign(_output.headers, headers);
          }
        } else {
          const headers = getProviderHeaders(provider, next.key.key);
          Object.assign(_output.headers, headers);
        }
        if (prevKeyId && prevKeyId !== next.key.id) {
          resetRateLimit(store, prevKeyId);
        }
        safeSaveStore();
      }
      if (modelIdForRotation && _input.sessionID) {
        const state = getState(_input.sessionID);
        state.currentModelId = modelIdForRotation;
        if (next) {
          state.lastUsedKeyId = next.key.id;
        }
      }
    },
    "chat.message": async (input, output) => {
      const reqModel = output.message.model ?? input.model;
      const reqProviderId = reqModel?.providerID;

      let matchedProvider: ProviderId | null = null;
      for (const provider of PROVIDERS) {
        const chain = getChainForProvider(provider);
        if (reqModel && findChainIndex(chain, reqModel) >= 0) {
          matchedProvider = provider;
          break;
        }
        const isProvider = typeof reqProviderId === "string" && reqProviderId.toLowerCase().includes(provider);
        if (isProvider) {
          matchedProvider = provider;
        }
      }
      if (!matchedProvider) return;

      const chain = getChainForProvider(matchedProvider);
      if (chain.length === 0) return;

      const sessionID = input.sessionID;
      const state = getState(sessionID);
      const requestedModel = output.message.model ?? input.model;
      let activeChainKey = state.activeChainKey;
      let activeChainKeyStr = activeChainKey;

      if (!activeChainKeyStr || state.pendingRetryIndex === undefined) {
        if (!requestedModel) {
          cleanupSession(sessionID);
          return;
        }
        activeChainKeyStr = modelKey(requestedModel);
      }

      const chainIndex = findChainIndex(chain, requestedModel);
      if (chainIndex < 0 && state.pendingRetryIndex === undefined) {
        cleanupSession(sessionID);
        return;
      }

      let desiredIndex: number;
      if (state.pendingRetryIndex !== undefined) {
        desiredIndex = state.pendingRetryIndex;
      } else {
        desiredIndex = chainIndex >= 0 ? chainIndex : 0;
      }

      const target = chain[desiredIndex];
      if (!target) {
        cleanupSession(sessionID);
        return;
      }

      output.message.model = {
        providerID: requestedModel?.providerID ?? matchedProvider,
        modelID: target.id,
      };

      state.activeChainKey = activeChainKeyStr;
      state.activeChainModelId = target.id;
      state.sessionProviderId = matchedProvider;
      state.attemptIndex = desiredIndex;
      state.lastUserMessageID = output.message.id;
    },
    "shell.env": async (_input, output) => {
      output.env["OPENCODE_ENABLE_EXA"] = "1";
      reloadFromDisk();
      for (const provider of PROVIDERS) {
        const envKeyName = getEnvKeyName(provider);
        if (output.env[envKeyName] !== undefined || getActiveKeys(store, provider).length > 0) {
          const next = getNextKey(store, config, undefined, provider);
          if (next) {
            output.env[envKeyName] = next.key.key;
            safeSaveStore();
          }
        }
      }
    },
    event: async ({ event }) => {
      if (event.type === "session.error") {
        await handleSessionError(event as Record<string, unknown>);
        return;
      }

      if ((event.type as string) === "session.next.step.failed") {
        await handleSessionStepFailed(event as Record<string, unknown>);
        return;
      }

      if (event.type === "session.status") {
        const props = (event as Record<string, unknown>).properties as Record<string, unknown> | undefined;
        const sessionID = props?.sessionID as string | undefined;
        const status = props?.status as Record<string, unknown> | undefined;
        const statusType = status?.type;

        if (statusType === "retry" && sessionID && status) {
          await handleSessionStatusRetry(sessionID, status);
          return;
        }

        if (statusType === "idle" && sessionID) {
          const state = sessions.get(sessionID);
          if (!state) return;
          state.rateLimitCount = 0;
          state.pendingRetryIndex = undefined;
          state.lastFailedModelId = undefined;
          if (state.inRetry) return;
          cleanupSession(sessionID);
          return;
        }
      }

      if (event.type === "session.idle") {
        const sessionID = (event.properties as Record<string, unknown>)?.sessionID as string;
        if (sessionID) {
          const state = sessions.get(sessionID);
          if (state && !state.inRetry) {
            state.pendingRetryIndex = undefined;
            state.lastFailedModelId = undefined;
            cleanupSession(sessionID);
          }
        }
      }

      if (event.type === "session.deleted") {
        const sessionID = ((event.properties as Record<string, unknown>)?.info as Record<string, unknown>)?.id as string;
        if (sessionID) cleanupSession(sessionID);
      }
    },
  };

  return hooks;
};

export interface V2Context {
  id?: string;
  location?: { directory?: string; workspaceID?: string };
  options?: Record<string, unknown>;
  session?: {
    hook?: (name: string, callback: (input: any) => Promise<void> | void, options?: any) => Promise<{ dispose: () => Promise<void> }>;
    switchModel?: (input: { sessionID: string; model: { providerID: string; modelID: string } }) => Promise<void>;
    prompt?: (input: any) => Promise<void>;
    get?: (input: any) => Promise<any>;
    [key: string]: any;
  };
  shell?: {
    hook?: (name: string, callback: (input: any) => Promise<void> | void) => Promise<{ dispose: () => Promise<void> }>;
    [key: string]: any;
  };
  provider?: {
    transform?: (callback: (editor: any) => void) => Promise<{ dispose: () => Promise<void> }>;
    list?: () => Promise<any>;
    [key: string]: any;
  };
  model?: {
    transform?: (callback: (editor: any) => void) => Promise<{ dispose: () => Promise<void> }>;
    list?: () => Promise<any>;
    [key: string]: any;
  };
  storage?: {
    get?: (key: string) => Promise<any>;
    set?: (key: string, value: any) => Promise<void>;
    remove?: (key: string) => Promise<void>;
  };
  event?: {
    subscribe?: (name: string, options?: any) => AsyncIterable<any>;
  };
  [key: string]: any;
}

export async function setupV2(context: V2Context): Promise<(() => Promise<void> | void) | void> {
  const options = context.options ?? {};
  const config: KeyStoreConfig = {
    storePath: options.storePath as string | undefined,
    rotationStrategy: isValidStrategy(options.rotationStrategy)
      ? options.rotationStrategy
      : "round-robin",
  };

  const store = loadStore(config) ?? getDefaultStore();
  if (!store.fallbackChains) store.fallbackChains = { nvidia: [], google: [], antigravity: [] };

  const sessions = new Map<string, SessionState>();

  const reloadFromDisk = () => {
    let fresh: KeyStore | null = null;
    try {
      fresh = loadStore(config);
    } catch (err) {
      console.debug("[superoc] Failed to reload store from disk:", err);
      return;
    }
    if (fresh === null) return;
    try {
      store.keys = fresh.keys;
      store.currentIndex = fresh.currentIndex;
      store.rotationStrategy = fresh.rotationStrategy;
      store.updatedAt = fresh.updatedAt;
      store.lastUsedKeyId = fresh.lastUsedKeyId;
      store.fallbackChains = {
        nvidia: Array.isArray(fresh.fallbackChains?.nvidia) ? fresh.fallbackChains.nvidia : [],
        google: Array.isArray(fresh.fallbackChains?.google) ? fresh.fallbackChains.google : [],
        antigravity: Array.isArray(fresh.fallbackChains?.antigravity) ? fresh.fallbackChains.antigravity : [],
      };
      store.maxRateLimitFailures =
        typeof fresh.maxRateLimitFailures === "number" &&
        Number.isFinite(fresh.maxRateLimitFailures) &&
        fresh.maxRateLimitFailures >= 1
          ? fresh.maxRateLimitFailures
          : getDefaultStore().maxRateLimitFailures;
    } catch (err) {
      console.debug("[superoc] Failed to apply reloaded store:", err);
    }
  };

  const safeSaveStore = () => {
    try {
      saveStore(store, config);
    } catch (err) {
      console.error("[superoc] Failed to save store:", err);
    }
  };

  for (const provider of PROVIDERS) {
    const activeKeys = getActiveKeys(store, provider);
    if (activeKeys.length === 0) {
      const envKey = process.env[getEnvKeyName(provider)];
      if (envKey) {
        const existing = store.keys.find((k) => k.name === "env-default" && k.provider === provider);
        if (!existing) {
          addKey(store, "env-default", envKey, provider);
          safeSaveStore();
        }
      }
    }
  }

  const getState = (sessionID: string): SessionState => {
    const existing = sessions.get(sessionID);
    if (existing) return existing;
    const next: SessionState = {
      attemptIndex: 0,
      inRetry: false,
      aborting: false,
      pendingRetryIndex: undefined,
      lastUserMessageID: undefined,
      activeChainKey: undefined,
      activeChainModelId: undefined,
      rateLimitCount: 0,
      currentModelId: undefined,
      lastFailedModelId: undefined,
      lastErrorHandledAt: 0,
      createdAt: Date.now(),
      sessionProviderId: undefined,
      lastUsedKeyId: undefined,
    };
    sessions.set(sessionID, next);
    return next;
  };

  // Seed environment variables
  if (!process.env.OPENCODE_ENABLE_EXA) {
    process.env.OPENCODE_ENABLE_EXA = "1";
  }
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "antigravity-oauth";
  }
  if (!process.env.GEMINI_API_KEY) {
    process.env.GEMINI_API_KEY = "antigravity-oauth";
  }
  syncOpencodeAuth();

  // Install global fetch interceptor
  const antigravityFetch = createAntigravityFetch(store, config, reloadFromDisk, safeSaveStore);
  installGlobalFetchInterceptor(antigravityFetch);

  // Shell hook in V2
  if (context.shell?.hook) {
    await context.shell.hook("create.before", async (input: any) => {
      if (input?.env) {
        input.env["OPENCODE_ENABLE_EXA"] = "1";
        reloadFromDisk();
        for (const provider of PROVIDERS) {
          const envKeyName = getEnvKeyName(provider);
          if (input.env[envKeyName] !== undefined || getActiveKeys(store, provider).length > 0) {
            const next = getNextKey(store, config, undefined, provider);
            if (next) {
              input.env[envKeyName] = next.key.key;
              safeSaveStore();
            }
          }
        }
      }
    });
  }

  // Session model.request hook in V2: inject rotated auth headers
  if (context.session?.hook) {
    await context.session.hook("model.request", async (input: any) => {
      const provider = detectProviderForRequest({
        provider: { info: { id: input.model?.providerID } },
        model: { providerID: input.model?.providerID, api: input.model?.modelID },
      });
      if (!provider) return;

      reloadFromDisk();
      const prevKeyId = store.lastUsedKeyId;
      const modelId = input.model?.modelID;
      const next = getNextKey(store, config, modelId, provider);
      if (next) {
        if (provider === "antigravity") {
          const authRes = await getOrRefreshAntigravityAccessToken(next.key.key);
          if (authRes) {
            const headers = getAntigravityHeaders(authRes.accessToken, authRes.projectId);
            input.headers = Object.assign(input.headers || {}, headers);
          }
        } else {
          const headers = getProviderHeaders(provider, next.key.key);
          input.headers = Object.assign(input.headers || {}, headers);
        }
        if (prevKeyId && prevKeyId !== next.key.id) {
          resetRateLimit(store, prevKeyId);
        }
        safeSaveStore();
      }
      if (input.sessionID) {
        const state = getState(input.sessionID);
        state.currentModelId = modelId;
        state.sessionProviderId = provider;
        if (next) state.lastUsedKeyId = next.key.id;
      }
    });

    // Session http.response hook in V2: monitor 429 rate limits
    await context.session.hook("http.response", async (input: any) => {
      if (input.response?.status === 429) {
        const state = input.sessionID ? sessions.get(input.sessionID) : undefined;
        const errorKeyId = state?.lastUsedKeyId ?? store.lastUsedKeyId;
        reloadFromDisk();
        if (errorKeyId) {
          recordRateLimit(store, errorKeyId);
          const modelForBlacklist = state?.currentModelId;
          if (modelForBlacklist) {
            recordModelRateLimit(store, errorKeyId, modelForBlacklist);
          }
          if (state) state.lastFailedModelId = modelForBlacklist;
        }
        safeSaveStore();
      }
    });

    // Session retry hook in V2: fallback model switching
    await context.session.hook("retry", async (input: any) => {
      const sessionID = input.sessionID;
      if (!sessionID) return;
      const state = getState(sessionID);
      const provider = (state.sessionProviderId as ProviderId) ?? "nvidia";
      const chain = store.fallbackChains[provider] || [];
      if (chain.length < 2) return;

      let nextIndex = (state.attemptIndex + 1) % chain.length;
      const target = chain[nextIndex];
      if (target && context.session?.switchModel) {
        state.attemptIndex = nextIndex;
        state.currentModelId = target.id;
        try {
          await context.session.switchModel({
            sessionID,
            model: { providerID: state.sessionProviderId ?? provider, modelID: target.id },
          });
        } catch (err) {
          console.debug("[superoc] switchModel failed:", err);
        }
      }
    });
  }

  // Provider & Model transform in V2
  if (context.provider?.transform) {
    await context.provider.transform((editor: any) => {
      const existing = editor.get?.("antigravity");
      if (!existing && editor.add) {
        editor.add({
          info: {
            id: "antigravity",
            name: "Antigravity",
            package: "aisdk:@ai-sdk/google",
            settings: {
              baseURL: "https://generativelanguage.googleapis.com/v1beta",
            },
          },
          models: [],
        });
      }
    });
  }

  if (context.model?.transform) {
    await context.model.transform((editor: any) => {
      for (const [id, def] of Object.entries(BASE_ANTIGRAVITY_MODELS)) {
        if (!editor.get?.("antigravity", id) && editor.update) {
          editor.update("antigravity", id, (draft: any) => {
            Object.assign(draft, {
              name: def.name,
              limit: def.limit,
              capabilities: {
                tools: true,
                input: ["text", "image", "pdf"],
                output: ["text"],
              },
            });
          });
        }
      }
    });
  }

  // Query live Antigravity models in background
  reloadFromDisk();
  const activeKeys = getActiveKeys(store, "antigravity");
  if (activeKeys.length > 0) {
    getOrRefreshAntigravityAccessToken(activeKeys[0].key)
      .then(async (auth) => {
        if (auth) {
          try {
            await fetchLiveAntigravityModels(auth.accessToken, auth.projectId);
          } catch {}
        }
      })
      .catch(() => {});
  }

  return () => {
    sessions.clear();
  };
}

export const SuperocPluginV2 = {
  id: "superoc",
  setup: setupV2,
  server: SuperocPlugin,
};

export const NimSuperPlugin = SuperocPlugin;
export { SuperocPlugin as server };
export default SuperocPluginV2;