#!/usr/bin/env node
/* Generated from server/claude-daemon.js by npm run build:daemon (do not edit). */ import { createRequire as __agentHubCreateRequire } from 'node:module'; const require = __agentHubCreateRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// server/adapters/presets.js
var acp, api, cli, TEMPLATES, DEFAULT_AGENTS;
var init_presets = __esm({
  "server/adapters/presets.js"() {
    acp = (id, name, command2, args, color, extra = {}) => ({
      id,
      name,
      type: "acp",
      command: command2,
      args,
      env: {},
      color,
      enabled: true,
      ...extra
    });
    api = (id, name, baseUrl, model, apiKeyEnv, color, extra = {}) => ({
      id,
      name,
      type: "openai",
      baseUrl,
      model,
      apiKeyEnv,
      apiKey: "",
      color,
      enabled: false,
      ...extra
    });
    cli = (id, name, command2, cliKind, args, color, extra = {}) => ({
      id,
      name,
      type: "cli",
      command: command2,
      cliKind,
      args,
      model: "",
      color,
      enabled: false,
      ...extra
    });
    TEMPLATES = [
      acp("kimi", "Kimi Code", "kimi", "acp", "#1a73e8", {
        description: "Moonshot AI \u7684 Kimi Code CLI\uFF0C\u900F\u904E `kimi acp` \u9023\u7DDA\u3002\u4F7F\u7528\u4F60\u5728\u7D42\u7AEF\u6A5F `kimi login` \u767B\u5165\u7684 Kimi \u5E33\u865F\uFF08\u8A02\u95B1\u5236\u53EF\u7528\uFF0C\u4E0D\u9700\u8981 API key\uFF09\u3002",
        install: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash   \u6216   npm i -g @moonshot-ai/kimi-code",
        login: "kimi login"
      }),
      acp("gemini-cli", "Gemini CLI", "gemini", "--experimental-acp", "#4285f4", {
        description: "Google Gemini CLI \u7684 ACP \u6A21\u5F0F\uFF0C\u6CBF\u7528 Google \u5E33\u865F\u767B\u5165\u3002",
        install: "npm i -g @google/gemini-cli",
        login: "gemini"
      }),
      acp("qwen-code", "Qwen Code", "qwen", "--experimental-acp", "#615ced", {
        description: "\u963F\u91CC Qwen Code\uFF08Gemini CLI \u5206\u652F\uFF09\u7684 ACP \u6A21\u5F0F\uFF0C\u6CBF\u7528 Qwen \u5E33\u865F\u767B\u5165\u3002",
        install: "npm i -g @qwen-code/qwen-code",
        login: "qwen",
        enabled: false
      }),
      acp("goose", "Goose", "goose", "acp", "#3f3f46", {
        description: "Block \u7684 Goose\uFF0C`goose acp`\u3002",
        install: "https://block.github.io/goose/",
        enabled: false
      }),
      acp("opencode", "OpenCode", "opencode", "acp", "#f59e0b", {
        description: "SST OpenCode\uFF0C`opencode acp`\u3002",
        install: "npm i -g opencode-ai",
        enabled: false
      }),
      acp("codex-acp", "OpenAI Codex (ACP)", "npx", "-y @zed-industries/codex-acp", "#0f0f0f", {
        description: "Zed \u7DAD\u8B77\u7684 Codex ACP \u8F49\u63A5\u5668\uFF0C\u6CBF\u7528 ChatGPT \u5E33\u865F\u767B\u5165\uFF08codex login\uFF09\u3002",
        login: "codex login",
        enabled: false
      }),
      acp("custom-acp", "\u81EA\u8A02 ACP Agent", "my-agent", "--acp", "#71717a", {
        description: "\u4EFB\u4F55\u652F\u63F4 Agent Client Protocol \u7684 agent\uFF1A\u586B\u5165\u555F\u52D5\u6307\u4EE4\u8207\u53C3\u6578\u5373\u53EF\u3002",
        enabled: false
      }),
      cli("aider", "Aider", "aider", "aider", "", "#14a37f", {
        description: "pip install aider-chat \u2014 \u6BCF\u56DE\u5408\u4EE5 `aider --message` \u57F7\u884C\uFF0C\u8F38\u51FA\u7D14\u6587\u5B57\u3002"
      }),
      cli("custom-cli", "\u81EA\u8A02 CLI", "my-agent", "plain", "{prompt}", "#71717a", {
        description: "\u4EFB\u610F\u6307\u4EE4\uFF1B{prompt} \u6703\u88AB\u66FF\u63DB\u6210\u63D0\u793A\u8A5E\uFF0C\u6C92\u6709 {prompt} \u6642\u6539\u5F9E stdin \u50B3\u5165\u3002JSON lines \u6703\u81EA\u52D5\u89E3\u6790\u3002"
      }),
      api("moonshot-api", "Kimi API\uFF08\u6309\u91CF\u8A08\u8CBB\uFF09", "https://api.moonshot.ai/v1", "kimi-k2-0905-preview", "MOONSHOT_API_KEY", "#1a73e8", {
        description: "Moonshot \u958B\u653E\u5E73\u53F0 API\uFF08\u9700 API key\uFF0C\u6309 token \u8A08\u8CBB\uFF1B\u8A02\u95B1\u5236\u8ACB\u6539\u7528\u4E0A\u9762\u7684 Kimi Code\uFF09\u3002"
      }),
      api("openai", "OpenAI API", "https://api.openai.com/v1", "gpt-5", "OPENAI_API_KEY", "#10a37f"),
      api("deepseek", "DeepSeek API", "https://api.deepseek.com/v1", "deepseek-chat", "DEEPSEEK_API_KEY", "#4d6bfe"),
      api("openrouter", "OpenRouter", "https://openrouter.ai/api/v1", "moonshotai/kimi-k2", "OPENROUTER_API_KEY", "#6467f2"),
      api("ollama", "Ollama\uFF08\u672C\u6A5F\uFF09", "http://localhost:11434/v1", "qwen2.5-coder:7b", "", "#8a8a8a"),
      {
        id: "demo",
        name: "Demo Agent",
        type: "demo",
        color: "#d97757",
        enabled: true,
        description: "\u4E0D\u9700\u8981\u4EFB\u4F55\u5E33\u865F\u7684\u6A21\u64EC agent\uFF0C\u6703\u771F\u7684\u5728\u5DE5\u4F5C\u5340\u5EFA\u7ACB\u6A94\u6848\u3001\u57F7\u884C\u6307\u4EE4\u4E26\u8ACB\u6C42\u6B0A\u9650\uFF0C\u7528\u4F86\u9AD4\u9A57\u4ECB\u9762\u3002"
      }
    ];
    DEFAULT_AGENTS = [];
  }
});

// server/store.js
var store_exports = {};
__export(store_exports, {
  DATA_DIR: () => DATA_DIR,
  ROOT_DIR: () => ROOT_DIR,
  SETTINGS_FILE: () => SETTINGS_FILE,
  WORKSPACES_DIR: () => WORKSPACES_DIR,
  createSession: () => createSession,
  deleteAgent: () => deleteAgent,
  deleteSession: () => deleteSession,
  flushAll: () => flushAll,
  getAgent: () => getAgent,
  getSession: () => getSession,
  jsonInSlices: () => jsonInSlices,
  listAgents: () => listAgents,
  listSessions: () => listSessions,
  loadAgents: () => loadAgents,
  loadSessions: () => loadSessions,
  migrateSettings: () => migrateSettings,
  newId: () => newId,
  readSettings: () => readSettings,
  saveAgents: () => saveAgents,
  saveSession: () => saveSession,
  upsertAgent: () => upsertAgent,
  writeSettings: () => writeSettings
});
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
function newId(prefix = "") {
  return prefix + crypto.randomBytes(6).toString("hex");
}
function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
function loadAgents() {
  let saved2 = [];
  try {
    saved2 = JSON.parse(fs.readFileSync(AGENTS_FILE, "utf8"));
  } catch {
    saved2 = [];
  }
  const keep = new Set(DEFAULT_AGENTS.map((a) => a.id));
  const byId = new Map(saved2.filter((a) => !a.builtin || keep.has(a.id)).map((a) => [a.id, a]));
  for (const preset of DEFAULT_AGENTS) {
    if (!byId.has(preset.id)) byId.set(preset.id, { ...preset });
    else byId.set(preset.id, { ...preset, ...byId.get(preset.id), builtin: true });
  }
  agents = [...byId.values()];
  saveAgents();
  return agents;
}
function saveAgents() {
  writeJsonAtomic(AGENTS_FILE, agents);
}
function listAgents() {
  return agents;
}
function getAgent(id) {
  return agents.find((a) => a.id === id);
}
function upsertAgent(agent) {
  const idx = agents.findIndex((a) => a.id === agent.id);
  if (idx === -1) agents.push(agent);
  else agents[idx] = agent;
  saveAgents();
  return agent;
}
function deleteAgent(id) {
  agents = agents.filter((a) => a.id !== id);
  saveAgents();
}
function loadSessions() {
  for (const file of fs.readdirSync(SESSIONS_DIR)) {
    if (file.endsWith(".tmp")) fs.rmSync(path.join(SESSIONS_DIR, file), { force: true });
    if (!file.endsWith(".json")) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), "utf8"));
      if (s.status === "running" || s.status === "awaiting_permission") s.status = "idle";
      for (const ev of s.events) {
        if (ev.type === "permission" && !ev.decision) ev.decision = "expired";
        if (ev.type === "tool_use" && ev.status === "running") ev.status = "interrupted";
      }
      sessions.set(s.id, s);
    } catch (err) {
      console.warn(`[store] skipping unreadable session ${file}: ${err.message}`);
    }
  }
}
function listSessions() {
  return [...sessions.values()];
}
function getSession(id) {
  return sessions.get(id);
}
function createSession(fields) {
  const now = Date.now();
  const session = {
    id: newId("s_"),
    title: "New session",
    status: "idle",
    permissionMode: "ask",
    allowedTools: [],
    events: [],
    state: {},
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    createdAt: now,
    updatedAt: now,
    ...fields
  };
  sessions.set(session.id, session);
  saveSessionNow(session);
  return session;
}
function saveSession(session, { immediate = false } = {}) {
  session.updatedAt = Date.now();
  if (immediate) return saveSessionNow(session);
  if (saveTimers.has(session.id)) return;
  saveTimers.set(
    session.id,
    setTimeout(() => saveSessionNow(session), SAVE_DELAY)
  );
}
function saveSessionNow(session) {
  clearTimeout(saveTimers.get(session.id));
  saveTimers.delete(session.id);
  if (!sessions.has(session.id)) return;
  const busy = saving.get(session.id);
  if (busy) return void (busy.again = true);
  const job = { again: false };
  saving.set(session.id, job);
  writeSession(session).catch((err) => console.warn(`[store] saving ${session.id}: ${err.message}`)).finally(() => {
    saving.delete(session.id);
    if (job.again) saveSessionNow(session);
  });
}
async function writeSession(session) {
  const text = await jsonInSlices(session, "events");
  if (!sessions.has(session.id)) return;
  const file = sessionFile(session.id);
  const tmp = `${file}.${process.pid}.w.tmp`;
  await fs.promises.writeFile(tmp, text);
  if (!sessions.has(session.id)) return fs.promises.rm(tmp, { force: true });
  fs.renameSync(tmp, file);
}
async function jsonInSlices(obj, key, slice = 200) {
  const list = obj[key] || [];
  const n = list.length;
  const { [key]: _, ...rest } = obj;
  const head = JSON.stringify(rest);
  const parts = [head === "{}" ? "{" : `${head.slice(0, -1)},`, `${JSON.stringify(key)}:[`];
  for (let i = 0; i < n; i += slice) {
    if (i) {
      parts.push(",");
      await new Promise((r) => setImmediate(r));
    }
    parts.push(list.slice(i, Math.min(i + slice, n)).map((x) => JSON.stringify(x)).join(","));
  }
  parts.push("]}");
  return parts.join("");
}
function deleteSession(id) {
  clearTimeout(saveTimers.get(id));
  saveTimers.delete(id);
  sessions.delete(id);
  fs.rmSync(sessionFile(id), { force: true });
}
function flushAll() {
  for (const id of /* @__PURE__ */ new Set([...saveTimers.keys(), ...saving.keys()])) {
    clearTimeout(saveTimers.get(id));
    saveTimers.delete(id);
    const s = sessions.get(id);
    if (!s) continue;
    const tmp = `${sessionFile(id)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, sessionFile(id));
  }
}
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch {
    return { defaults: {} };
  }
}
function writeSettings(settings2) {
  writeJsonAtomic(SETTINGS_FILE, settings2);
}
function migrateSettings(name, change) {
  const st2 = readSettings();
  if ((st2.migrated || []).includes(name)) return false;
  st2.defaults = { ...st2.defaults || {} };
  if (change(st2.defaults) === false) return false;
  st2.migrated = [...st2.migrated || [], name];
  writeSettings(st2);
  return true;
}
var ROOT_DIR, DATA_DIR, WORKSPACES_DIR, SESSIONS_DIR, AGENTS_FILE, agents, sessions, saveTimers, saving, SAVE_DELAY, sessionFile, SETTINGS_FILE;
var init_store = __esm({
  "server/store.js"() {
    init_presets();
    ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    DATA_DIR = path.resolve(process.env.AGENT_HUB_DATA || path.join(ROOT_DIR, "data"));
    WORKSPACES_DIR = path.resolve(process.env.AGENT_HUB_WORKSPACES || path.join(ROOT_DIR, "workspaces"));
    SESSIONS_DIR = path.join(DATA_DIR, "sessions");
    AGENTS_FILE = path.join(DATA_DIR, "agents.json");
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
    agents = [];
    sessions = /* @__PURE__ */ new Map();
    saveTimers = /* @__PURE__ */ new Map();
    saving = /* @__PURE__ */ new Map();
    SAVE_DELAY = 1500;
    sessionFile = (id) => path.join(SESSIONS_DIR, `${id}.json`);
    SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
  }
});

// node_modules/@anthropic-ai/sdk/internal/tslib.mjs
function __classPrivateFieldSet(receiver, state, value, kind, f) {
  if (kind === "m")
    throw new TypeError("Private method is not writable");
  if (kind === "a" && !f)
    throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
    throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
}
function __classPrivateFieldGet(receiver, state, kind, f) {
  if (kind === "a" && !f)
    throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
    throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
}
var init_tslib = __esm({
  "node_modules/@anthropic-ai/sdk/internal/tslib.mjs"() {
  }
});

// node_modules/@anthropic-ai/sdk/internal/errors.mjs
function isAbortError(err) {
  return typeof err === "object" && err !== null && // Spec-compliant fetch implementations
  ("name" in err && err.name === "AbortError" || // Expo fetch
  "message" in err && String(err.message).includes("FetchRequestCanceledException"));
}
var castToError;
var init_errors = __esm({
  "node_modules/@anthropic-ai/sdk/internal/errors.mjs"() {
    castToError = (err) => {
      if (err instanceof Error)
        return err;
      if (typeof err === "object" && err !== null) {
        try {
          const tag = Object.prototype.toString.call(err);
          if (tag === "[object Error]" || tag === "[object DOMException]") {
            const error = new Error(err.message, err.cause ? { cause: err.cause } : {});
            if (err.stack)
              error.stack = err.stack;
            if (err.cause && !error.cause)
              error.cause = err.cause;
            if (err.name)
              error.name = err.name;
            return error;
          }
        } catch {
        }
        try {
          return new Error(JSON.stringify(err));
        } catch {
        }
      }
      return new Error(err);
    };
  }
});

// node_modules/@anthropic-ai/sdk/core/error.mjs
var AnthropicError, APIError, APIUserAbortError, APIConnectionError, APIConnectionTimeoutError, RetryableError, BadRequestError, AuthenticationError, PermissionDeniedError, NotFoundError, ConflictError, UnprocessableEntityError, RateLimitError, InternalServerError;
var init_error = __esm({
  "node_modules/@anthropic-ai/sdk/core/error.mjs"() {
    init_errors();
    AnthropicError = /* @__PURE__ */ (() => {
      class AnthropicError2 extends Error {
      }
      return AnthropicError2;
    })();
    APIError = class _APIError extends AnthropicError {
      constructor(status, error, message, headers, type) {
        super(`${_APIError.makeMessage(status, error, message)}`);
        this.status = status;
        this.headers = headers;
        this.requestID = headers?.get("request-id");
        this.workspaceID = headers?.get("anthropic-workspace-id");
        this.error = error;
        this.type = type ?? null;
      }
      static makeMessage(status, error, message) {
        const msg = error?.message ? typeof error.message === "string" ? error.message : JSON.stringify(error.message) : error ? JSON.stringify(error) : message;
        if (status && msg) {
          return `${status} ${msg}`;
        }
        if (status) {
          return `${status} status code (no body)`;
        }
        if (msg) {
          return msg;
        }
        return "(no status code or body)";
      }
      static generate(status, errorResponse, message, headers) {
        if (!status || !headers) {
          return new APIConnectionError({ message, cause: castToError(errorResponse) });
        }
        const error = errorResponse;
        const type = error?.["error"]?.["type"];
        if (status === 400) {
          return new BadRequestError(status, error, message, headers, type);
        }
        if (status === 401) {
          return new AuthenticationError(status, error, message, headers, type);
        }
        if (status === 403) {
          return new PermissionDeniedError(status, error, message, headers, type);
        }
        if (status === 404) {
          return new NotFoundError(status, error, message, headers, type);
        }
        if (status === 409) {
          return new ConflictError(status, error, message, headers, type);
        }
        if (status === 422) {
          return new UnprocessableEntityError(status, error, message, headers, type);
        }
        if (status === 429) {
          return new RateLimitError(status, error, message, headers, type);
        }
        if (status >= 500) {
          return new InternalServerError(status, error, message, headers, type);
        }
        return new _APIError(status, error, message, headers, type);
      }
    };
    APIUserAbortError = class extends APIError {
      constructor({ message } = {}) {
        super(void 0, void 0, message || "Request was aborted.", void 0);
      }
    };
    APIConnectionError = class extends APIError {
      constructor({ message, cause }) {
        super(void 0, void 0, message || "Connection error.", void 0);
        if (cause)
          this.cause = cause;
      }
    };
    APIConnectionTimeoutError = class extends APIConnectionError {
      constructor({ message } = {}) {
        super({ message: message ?? "Request timed out." });
      }
    };
    RetryableError = class extends AnthropicError {
      constructor(message, { cause } = {}) {
        super(message ?? "Retryable error.");
        if (cause !== void 0)
          this.cause = cause;
      }
    };
    BadRequestError = class extends APIError {
    };
    AuthenticationError = class extends APIError {
    };
    PermissionDeniedError = class extends APIError {
    };
    NotFoundError = class extends APIError {
    };
    ConflictError = class extends APIError {
    };
    UnprocessableEntityError = class extends APIError {
    };
    RateLimitError = class extends APIError {
    };
    InternalServerError = class extends APIError {
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/utils/values.mjs
function maybeObj(x) {
  if (typeof x !== "object") {
    return {};
  }
  return x ?? {};
}
function isEmptyObj(obj) {
  if (!obj)
    return true;
  for (const _k in obj)
    return false;
  return true;
}
function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}
function isObj(obj) {
  return obj != null && typeof obj === "object" && !Array.isArray(obj);
}
function checkNever(_value) {
}
var startsWithSchemeRegexp, isAbsoluteURL, isArray, isReadonlyArray, validatePositiveInteger, safeJSON;
var init_values = __esm({
  "node_modules/@anthropic-ai/sdk/internal/utils/values.mjs"() {
    init_error();
    startsWithSchemeRegexp = /^[a-z][a-z0-9+.-]*:/i;
    isAbsoluteURL = (url) => {
      return startsWithSchemeRegexp.test(url);
    };
    isArray = (val) => (isArray = Array.isArray, isArray(val));
    isReadonlyArray = isArray;
    validatePositiveInteger = (name, n) => {
      if (typeof n !== "number" || !Number.isInteger(n)) {
        throw new AnthropicError(`${name} must be an integer`);
      }
      if (n < 0) {
        throw new AnthropicError(`${name} must be a positive integer`);
      }
      return n;
    };
    safeJSON = (text) => {
      try {
        return JSON.parse(text);
      } catch (err) {
        return void 0;
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/utils/sleep.mjs
var sleep;
var init_sleep = __esm({
  "node_modules/@anthropic-ai/sdk/internal/utils/sleep.mjs"() {
    sleep = (ms, signal) => new Promise((resolve2) => {
      if (signal?.aborted)
        return resolve2();
      const onAbort = () => {
        clearTimeout(timer);
        resolve2();
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve2();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
});

// node_modules/@anthropic-ai/sdk/version.mjs
var VERSION;
var init_version = __esm({
  "node_modules/@anthropic-ai/sdk/version.mjs"() {
    VERSION = "0.129.0";
  }
});

// node_modules/@anthropic-ai/sdk/internal/detect-platform.mjs
function getDetectedPlatform() {
  if (typeof Deno !== "undefined" && Deno.build != null) {
    return "deno";
  }
  if (typeof EdgeRuntime !== "undefined") {
    return "edge";
  }
  if (Object.prototype.toString.call(typeof globalThis.process !== "undefined" ? globalThis.process : 0) === "[object process]") {
    return "node";
  }
  return "unknown";
}
function getBrowserInfo() {
  if (typeof navigator === "undefined" || !navigator) {
    return null;
  }
  const browserPatterns = [
    { key: "edge", pattern: /Edge(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ },
    { key: "ie", pattern: /MSIE(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ },
    { key: "ie", pattern: /Trident(?:.*rv\:(\d+)\.(\d+)(?:\.(\d+))?)?/ },
    { key: "chrome", pattern: /Chrome(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ },
    { key: "firefox", pattern: /Firefox(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ },
    { key: "safari", pattern: /(?:Version\W+(\d+)\.(\d+)(?:\.(\d+))?)?(?:\W+Mobile\S*)?\W+Safari/ }
  ];
  for (const { key, pattern } of browserPatterns) {
    const match = pattern.exec(navigator.userAgent);
    if (match) {
      const major = match[1] || 0;
      const minor = match[2] || 0;
      const patch = match[3] || 0;
      return { browser: key, version: `${major}.${minor}.${patch}` };
    }
  }
  return null;
}
var isRunningInBrowser, getPlatformProperties, normalizeArch, normalizePlatform, _platformHeaders, getPlatformHeaders;
var init_detect_platform = __esm({
  "node_modules/@anthropic-ai/sdk/internal/detect-platform.mjs"() {
    init_version();
    isRunningInBrowser = () => {
      return (
        // @ts-ignore
        typeof window !== "undefined" && // @ts-ignore
        typeof window.document !== "undefined" && // @ts-ignore
        typeof navigator !== "undefined"
      );
    };
    getPlatformProperties = () => {
      const detectedPlatform = getDetectedPlatform();
      if (detectedPlatform === "deno") {
        return {
          "X-Stainless-Lang": "js",
          "X-Stainless-Package-Version": VERSION,
          "X-Stainless-OS": normalizePlatform(Deno.build.os),
          "X-Stainless-Arch": normalizeArch(Deno.build.arch),
          "X-Stainless-Runtime": "deno",
          "X-Stainless-Runtime-Version": typeof Deno.version === "string" ? Deno.version : Deno.version?.deno ?? "unknown"
        };
      }
      if (typeof EdgeRuntime !== "undefined") {
        return {
          "X-Stainless-Lang": "js",
          "X-Stainless-Package-Version": VERSION,
          "X-Stainless-OS": "Unknown",
          "X-Stainless-Arch": `other:${EdgeRuntime}`,
          "X-Stainless-Runtime": "edge",
          "X-Stainless-Runtime-Version": globalThis.process?.version ?? "unknown"
        };
      }
      if (detectedPlatform === "node") {
        return {
          "X-Stainless-Lang": "js",
          "X-Stainless-Package-Version": VERSION,
          "X-Stainless-OS": normalizePlatform(globalThis.process.platform ?? "unknown"),
          "X-Stainless-Arch": normalizeArch(globalThis.process.arch ?? "unknown"),
          "X-Stainless-Runtime": "node",
          "X-Stainless-Runtime-Version": globalThis.process.version ?? "unknown"
        };
      }
      const browserInfo = getBrowserInfo();
      if (browserInfo) {
        return {
          "X-Stainless-Lang": "js",
          "X-Stainless-Package-Version": VERSION,
          "X-Stainless-OS": "Unknown",
          "X-Stainless-Arch": "unknown",
          "X-Stainless-Runtime": `browser:${browserInfo.browser}`,
          "X-Stainless-Runtime-Version": browserInfo.version
        };
      }
      return {
        "X-Stainless-Lang": "js",
        "X-Stainless-Package-Version": VERSION,
        "X-Stainless-OS": "Unknown",
        "X-Stainless-Arch": "unknown",
        "X-Stainless-Runtime": "unknown",
        "X-Stainless-Runtime-Version": "unknown"
      };
    };
    normalizeArch = (arch) => {
      if (arch === "x32")
        return "x32";
      if (arch === "x86_64" || arch === "x64")
        return "x64";
      if (arch === "arm")
        return "arm";
      if (arch === "aarch64" || arch === "arm64")
        return "arm64";
      if (arch)
        return `other:${arch}`;
      return "unknown";
    };
    normalizePlatform = (platform) => {
      platform = platform.toLowerCase();
      if (platform.includes("ios"))
        return "iOS";
      if (platform === "android")
        return "Android";
      if (platform === "darwin")
        return "MacOS";
      if (platform === "win32")
        return "Windows";
      if (platform === "freebsd")
        return "FreeBSD";
      if (platform === "openbsd")
        return "OpenBSD";
      if (platform === "linux")
        return "Linux";
      if (platform)
        return `Other:${platform}`;
      return "Unknown";
    };
    getPlatformHeaders = () => {
      return _platformHeaders ?? (_platformHeaders = getPlatformProperties());
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/request-signal.mjs
function makeCleanup(signal, listener) {
  return () => signal.removeEventListener("abort", listener);
}
function registerRequestSignalCleanup(controller, signal, listener) {
  cleanups.set(controller, makeCleanup(signal, listener));
}
function armAbandonmentBackstop(body, controller) {
  if (cleanups.has(controller))
    registry?.register(body, controller, controller);
}
function releaseRequestSignal(controller) {
  const cleanup = cleanups.get(controller);
  if (cleanup) {
    cleanups.delete(controller);
    registry?.unregister(controller);
    cleanup();
  }
}
var cleanups, registry;
var init_request_signal = __esm({
  "node_modules/@anthropic-ai/sdk/internal/request-signal.mjs"() {
    cleanups = /* @__PURE__ */ new WeakMap();
    registry = typeof globalThis.FinalizationRegistry === "function" ? new globalThis.FinalizationRegistry((controller) => releaseRequestSignal(controller)) : null;
  }
});

// node_modules/@anthropic-ai/sdk/internal/shims.mjs
function getDefaultFetch() {
  if (typeof fetch !== "undefined") {
    return fetch;
  }
  throw new Error("`fetch` is not defined as a global; Either pass `fetch` to the client, `new Anthropic({ fetch })` or polyfill the global, `globalThis.fetch = fetch`");
}
function makeReadableStream(...args) {
  const ReadableStream = globalThis.ReadableStream;
  if (typeof ReadableStream === "undefined") {
    throw new Error("`ReadableStream` is not defined as a global; You will need to polyfill it, `globalThis.ReadableStream = ReadableStream`");
  }
  return new ReadableStream(...args);
}
function ReadableStreamFrom(iterable) {
  let iter = Symbol.asyncIterator in iterable ? iterable[Symbol.asyncIterator]() : iterable[Symbol.iterator]();
  return makeReadableStream({
    start() {
    },
    async pull(controller) {
      const { done, value } = await iter.next();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
    async cancel() {
      await iter.return?.();
    }
  });
}
function ReadableStreamToAsyncIterable(stream2) {
  if (stream2[Symbol.asyncIterator])
    return stream2;
  const reader = stream2.getReader();
  return {
    async next() {
      try {
        const result = await reader.read();
        if (result?.done)
          reader.releaseLock();
        return result;
      } catch (e) {
        reader.releaseLock();
        throw e;
      }
    },
    async return() {
      const cancelPromise = reader.cancel();
      reader.releaseLock();
      await cancelPromise;
      return { done: true, value: void 0 };
    },
    [Symbol.asyncIterator]() {
      return this;
    }
  };
}
async function CancelReadableStream(stream2) {
  if (stream2 === null || typeof stream2 !== "object")
    return;
  if (stream2[Symbol.asyncIterator]) {
    await stream2[Symbol.asyncIterator]().return?.();
    return;
  }
  const reader = stream2.getReader();
  const cancelPromise = reader.cancel();
  reader.releaseLock();
  await cancelPromise;
}
var init_shims = __esm({
  "node_modules/@anthropic-ai/sdk/internal/shims.mjs"() {
  }
});

// node_modules/@anthropic-ai/sdk/internal/request-options.mjs
var FallbackEncoder;
var init_request_options = __esm({
  "node_modules/@anthropic-ai/sdk/internal/request-options.mjs"() {
    FallbackEncoder = ({ headers, body }) => {
      return {
        bodyHeaders: {
          "content-type": "application/json"
        },
        body: JSON.stringify(body)
      };
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/qs/formats.mjs
var default_format, default_formatter, formatters, RFC1738;
var init_formats = __esm({
  "node_modules/@anthropic-ai/sdk/internal/qs/formats.mjs"() {
    default_format = "RFC3986";
    default_formatter = (v) => String(v);
    formatters = {
      RFC1738: (v) => String(v).replace(/%20/g, "+"),
      RFC3986: default_formatter
    };
    RFC1738 = "RFC1738";
  }
});

// node_modules/@anthropic-ai/sdk/internal/qs/utils.mjs
function is_buffer(obj) {
  if (!obj || typeof obj !== "object") {
    return false;
  }
  return !!(obj.constructor && obj.constructor.isBuffer && obj.constructor.isBuffer(obj));
}
function maybe_map(val, fn) {
  if (isArray(val)) {
    const mapped = [];
    for (let i = 0; i < val.length; i += 1) {
      mapped.push(fn(val[i]));
    }
    return mapped;
  }
  return fn(val);
}
var has, hex_table, limit, encode;
var init_utils = __esm({
  "node_modules/@anthropic-ai/sdk/internal/qs/utils.mjs"() {
    init_formats();
    init_values();
    has = (obj, key) => (has = Object.hasOwn ?? Function.prototype.call.bind(Object.prototype.hasOwnProperty), has(obj, key));
    hex_table = /* @__PURE__ */ (() => {
      const array = [];
      for (let i = 0; i < 256; ++i) {
        array.push("%" + ((i < 16 ? "0" : "") + i.toString(16)).toUpperCase());
      }
      return array;
    })();
    limit = 1024;
    encode = (str2, _defaultEncoder, charset, _kind, format) => {
      if (str2.length === 0) {
        return str2;
      }
      let string = str2;
      if (typeof str2 === "symbol") {
        string = Symbol.prototype.toString.call(str2);
      } else if (typeof str2 !== "string") {
        string = String(str2);
      }
      if (charset === "iso-8859-1") {
        return escape(string).replace(/%u[0-9a-f]{4}/gi, function($0) {
          return "%26%23" + parseInt($0.slice(2), 16) + "%3B";
        });
      }
      let out = "";
      for (let j = 0; j < string.length; j += limit) {
        const segment = string.length >= limit ? string.slice(j, j + limit) : string;
        const arr = [];
        for (let i = 0; i < segment.length; ++i) {
          let c = segment.charCodeAt(i);
          if (c === 45 || // -
          c === 46 || // .
          c === 95 || // _
          c === 126 || // ~
          c >= 48 && c <= 57 || // 0-9
          c >= 65 && c <= 90 || // a-z
          c >= 97 && c <= 122 || // A-Z
          format === RFC1738 && (c === 40 || c === 41)) {
            arr[arr.length] = segment.charAt(i);
            continue;
          }
          if (c < 128) {
            arr[arr.length] = hex_table[c];
            continue;
          }
          if (c < 2048) {
            arr[arr.length] = hex_table[192 | c >> 6] + hex_table[128 | c & 63];
            continue;
          }
          if (c < 55296 || c >= 57344) {
            arr[arr.length] = hex_table[224 | c >> 12] + hex_table[128 | c >> 6 & 63] + hex_table[128 | c & 63];
            continue;
          }
          i += 1;
          c = 65536 + ((c & 1023) << 10 | segment.charCodeAt(i) & 1023);
          arr[arr.length] = hex_table[240 | c >> 18] + hex_table[128 | c >> 12 & 63] + hex_table[128 | c >> 6 & 63] + hex_table[128 | c & 63];
        }
        out += arr.join("");
      }
      return out;
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/qs/stringify.mjs
function is_non_nullish_primitive(v) {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" || typeof v === "symbol" || typeof v === "bigint";
}
function inner_stringify(object, prefix, generateArrayPrefix, commaRoundTrip, allowEmptyArrays, strictNullHandling, skipNulls, encodeDotInKeys, encoder, filter, sort, allowDots, serializeDate, format, formatter, encodeValuesOnly, charset, sideChannel) {
  let obj = object;
  let tmp_sc = sideChannel;
  let step = 0;
  let find_flag = false;
  while ((tmp_sc = tmp_sc.get(sentinel)) !== void 0 && !find_flag) {
    const pos = tmp_sc.get(object);
    step += 1;
    if (typeof pos !== "undefined") {
      if (pos === step) {
        throw new RangeError("Cyclic object value");
      } else {
        find_flag = true;
      }
    }
    if (typeof tmp_sc.get(sentinel) === "undefined") {
      step = 0;
    }
  }
  if (typeof filter === "function") {
    obj = filter(prefix, obj);
  } else if (obj instanceof Date) {
    obj = serializeDate?.(obj);
  } else if (generateArrayPrefix === "comma" && isArray(obj)) {
    obj = maybe_map(obj, function(value) {
      if (value instanceof Date) {
        return serializeDate?.(value);
      }
      return value;
    });
  }
  if (obj === null) {
    if (strictNullHandling) {
      return encoder && !encodeValuesOnly ? (
        // @ts-expect-error
        encoder(prefix, defaults.encoder, charset, "key", format)
      ) : prefix;
    }
    obj = "";
  }
  if (is_non_nullish_primitive(obj) || is_buffer(obj)) {
    if (encoder) {
      const key_value = encodeValuesOnly ? prefix : encoder(prefix, defaults.encoder, charset, "key", format);
      return [
        formatter?.(key_value) + "=" + // @ts-expect-error
        formatter?.(encoder(obj, defaults.encoder, charset, "value", format))
      ];
    }
    return [formatter?.(prefix) + "=" + formatter?.(String(obj))];
  }
  const values = [];
  if (typeof obj === "undefined") {
    return values;
  }
  let obj_keys;
  if (generateArrayPrefix === "comma" && isArray(obj)) {
    if (encodeValuesOnly && encoder) {
      obj = maybe_map(obj, encoder);
    }
    obj_keys = [{ value: obj.length > 0 ? obj.join(",") || null : void 0 }];
  } else if (isArray(filter)) {
    obj_keys = filter;
  } else {
    const keys = Object.keys(obj);
    obj_keys = sort ? keys.sort(sort) : keys;
  }
  const encoded_prefix = encodeDotInKeys ? String(prefix).replace(/\./g, "%2E") : String(prefix);
  const adjusted_prefix = commaRoundTrip && isArray(obj) && obj.length === 1 ? encoded_prefix + "[]" : encoded_prefix;
  if (allowEmptyArrays && isArray(obj) && obj.length === 0) {
    return adjusted_prefix + "[]";
  }
  for (let j = 0; j < obj_keys.length; ++j) {
    const key = obj_keys[j];
    const value = (
      // @ts-ignore
      typeof key === "object" && typeof key.value !== "undefined" ? key.value : obj[key]
    );
    if (skipNulls && value === null) {
      continue;
    }
    const encoded_key = allowDots && encodeDotInKeys ? key.replace(/\./g, "%2E") : key;
    const key_prefix = isArray(obj) ? typeof generateArrayPrefix === "function" ? generateArrayPrefix(adjusted_prefix, encoded_key) : adjusted_prefix : adjusted_prefix + (allowDots ? "." + encoded_key : "[" + encoded_key + "]");
    sideChannel.set(object, step);
    const valueSideChannel = /* @__PURE__ */ new WeakMap();
    valueSideChannel.set(sentinel, sideChannel);
    push_to_array(values, inner_stringify(
      value,
      key_prefix,
      generateArrayPrefix,
      commaRoundTrip,
      allowEmptyArrays,
      strictNullHandling,
      skipNulls,
      encodeDotInKeys,
      // @ts-ignore
      generateArrayPrefix === "comma" && encodeValuesOnly && isArray(obj) ? null : encoder,
      filter,
      sort,
      allowDots,
      serializeDate,
      format,
      formatter,
      encodeValuesOnly,
      charset,
      valueSideChannel
    ));
  }
  return values;
}
function normalize_stringify_options(opts = defaults) {
  if (typeof opts.allowEmptyArrays !== "undefined" && typeof opts.allowEmptyArrays !== "boolean") {
    throw new TypeError("`allowEmptyArrays` option can only be `true` or `false`, when provided");
  }
  if (typeof opts.encodeDotInKeys !== "undefined" && typeof opts.encodeDotInKeys !== "boolean") {
    throw new TypeError("`encodeDotInKeys` option can only be `true` or `false`, when provided");
  }
  if (opts.encoder !== null && typeof opts.encoder !== "undefined" && typeof opts.encoder !== "function") {
    throw new TypeError("Encoder has to be a function.");
  }
  const charset = opts.charset || defaults.charset;
  if (typeof opts.charset !== "undefined" && opts.charset !== "utf-8" && opts.charset !== "iso-8859-1") {
    throw new TypeError("The charset option must be either utf-8, iso-8859-1, or undefined");
  }
  let format = default_format;
  if (typeof opts.format !== "undefined") {
    if (!has(formatters, opts.format)) {
      throw new TypeError("Unknown format option provided.");
    }
    format = opts.format;
  }
  const formatter = formatters[format];
  let filter = defaults.filter;
  if (typeof opts.filter === "function" || isArray(opts.filter)) {
    filter = opts.filter;
  }
  let arrayFormat;
  if (opts.arrayFormat && opts.arrayFormat in array_prefix_generators) {
    arrayFormat = opts.arrayFormat;
  } else if ("indices" in opts) {
    arrayFormat = opts.indices ? "indices" : "repeat";
  } else {
    arrayFormat = defaults.arrayFormat;
  }
  if ("commaRoundTrip" in opts && typeof opts.commaRoundTrip !== "boolean") {
    throw new TypeError("`commaRoundTrip` must be a boolean, or absent");
  }
  const allowDots = typeof opts.allowDots === "undefined" ? !!opts.encodeDotInKeys === true ? true : defaults.allowDots : !!opts.allowDots;
  return {
    addQueryPrefix: typeof opts.addQueryPrefix === "boolean" ? opts.addQueryPrefix : defaults.addQueryPrefix,
    // @ts-ignore
    allowDots,
    allowEmptyArrays: typeof opts.allowEmptyArrays === "boolean" ? !!opts.allowEmptyArrays : defaults.allowEmptyArrays,
    arrayFormat,
    charset,
    charsetSentinel: typeof opts.charsetSentinel === "boolean" ? opts.charsetSentinel : defaults.charsetSentinel,
    commaRoundTrip: !!opts.commaRoundTrip,
    delimiter: typeof opts.delimiter === "undefined" ? defaults.delimiter : opts.delimiter,
    encode: typeof opts.encode === "boolean" ? opts.encode : defaults.encode,
    encodeDotInKeys: typeof opts.encodeDotInKeys === "boolean" ? opts.encodeDotInKeys : defaults.encodeDotInKeys,
    encoder: typeof opts.encoder === "function" ? opts.encoder : defaults.encoder,
    encodeValuesOnly: typeof opts.encodeValuesOnly === "boolean" ? opts.encodeValuesOnly : defaults.encodeValuesOnly,
    filter,
    format,
    formatter,
    serializeDate: typeof opts.serializeDate === "function" ? opts.serializeDate : defaults.serializeDate,
    skipNulls: typeof opts.skipNulls === "boolean" ? opts.skipNulls : defaults.skipNulls,
    // @ts-ignore
    sort: typeof opts.sort === "function" ? opts.sort : null,
    strictNullHandling: typeof opts.strictNullHandling === "boolean" ? opts.strictNullHandling : defaults.strictNullHandling
  };
}
function stringify(object, opts = {}) {
  let obj = object;
  const options = normalize_stringify_options(opts);
  let obj_keys;
  let filter;
  if (typeof options.filter === "function") {
    filter = options.filter;
    obj = filter("", obj);
  } else if (isArray(options.filter)) {
    filter = options.filter;
    obj_keys = filter;
  }
  const keys = [];
  if (typeof obj !== "object" || obj === null) {
    return "";
  }
  const generateArrayPrefix = array_prefix_generators[options.arrayFormat];
  const commaRoundTrip = generateArrayPrefix === "comma" && options.commaRoundTrip;
  if (!obj_keys) {
    obj_keys = Object.keys(obj);
  }
  if (options.sort) {
    obj_keys.sort(options.sort);
  }
  const sideChannel = /* @__PURE__ */ new WeakMap();
  for (let i = 0; i < obj_keys.length; ++i) {
    const key = obj_keys[i];
    if (options.skipNulls && obj[key] === null) {
      continue;
    }
    push_to_array(keys, inner_stringify(
      obj[key],
      key,
      // @ts-expect-error
      generateArrayPrefix,
      commaRoundTrip,
      options.allowEmptyArrays,
      options.strictNullHandling,
      options.skipNulls,
      options.encodeDotInKeys,
      options.encode ? options.encoder : null,
      options.filter,
      options.sort,
      options.allowDots,
      options.serializeDate,
      options.format,
      options.formatter,
      options.encodeValuesOnly,
      options.charset,
      sideChannel
    ));
  }
  const joined = keys.join(options.delimiter);
  let prefix = options.addQueryPrefix === true ? "?" : "";
  if (options.charsetSentinel) {
    if (options.charset === "iso-8859-1") {
      prefix += "utf8=%26%2310003%3B&";
    } else {
      prefix += "utf8=%E2%9C%93&";
    }
  }
  return joined.length > 0 ? prefix + joined : "";
}
var array_prefix_generators, push_to_array, toISOString, defaults, sentinel;
var init_stringify = __esm({
  "node_modules/@anthropic-ai/sdk/internal/qs/stringify.mjs"() {
    init_utils();
    init_formats();
    init_values();
    array_prefix_generators = {
      brackets(prefix) {
        return String(prefix) + "[]";
      },
      comma: "comma",
      indices(prefix, key) {
        return String(prefix) + "[" + key + "]";
      },
      repeat(prefix) {
        return String(prefix);
      }
    };
    push_to_array = function(arr, value_or_array) {
      Array.prototype.push.apply(arr, isArray(value_or_array) ? value_or_array : [value_or_array]);
    };
    defaults = {
      addQueryPrefix: false,
      allowDots: false,
      allowEmptyArrays: false,
      arrayFormat: "indices",
      charset: "utf-8",
      charsetSentinel: false,
      delimiter: "&",
      encode: true,
      encodeDotInKeys: false,
      encoder: encode,
      encodeValuesOnly: false,
      format: default_format,
      formatter: default_formatter,
      /** @deprecated */
      indices: false,
      serializeDate(date) {
        return (toISOString ?? (toISOString = Function.prototype.call.bind(Date.prototype.toISOString)))(date);
      },
      skipNulls: false,
      strictNullHandling: false
    };
    sentinel = {};
  }
});

// node_modules/@anthropic-ai/sdk/internal/utils/query.mjs
function stringifyQuery(query) {
  return stringify(query, { arrayFormat: "brackets" });
}
var init_query = __esm({
  "node_modules/@anthropic-ai/sdk/internal/utils/query.mjs"() {
    init_stringify();
  }
});

// node_modules/@anthropic-ai/sdk/internal/node.mjs
var node_exports = {};
__export(node_exports, {
  child_process: () => child_process,
  crypto: () => crypto2,
  fs: () => fs2,
  os: () => os,
  path: () => path2,
  stream: () => stream,
  util: () => util
});
import * as child_process from "node:child_process";
import * as crypto2 from "node:crypto";
import * as fs2 from "node:fs";
import * as os from "node:os";
import * as path2 from "node:path";
import * as stream from "node:stream";
import * as util from "node:util";
var init_node = __esm({
  "node_modules/@anthropic-ai/sdk/internal/node.mjs"() {
  }
});

// node_modules/@anthropic-ai/sdk/lib/credentials/types.mjs
function requireSecureTokenEndpoint(baseURL2) {
  if (!baseURL2)
    return;
  let u;
  try {
    u = new URL(baseURL2);
  } catch (err) {
    throw new WorkloadIdentityError(`Invalid token endpoint base URL "${baseURL2}": ${err}`);
  }
  if (u.protocol === "https:")
    return;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (u.protocol === "http:" && (host === "localhost" || host === "127.0.0.1" || host === "::1")) {
    return;
  }
  throw new WorkloadIdentityError(`Refusing to send credential over non-https token endpoint "${baseURL2}"`);
}
async function parseTokenResponse(resp, requestId) {
  const text = await readLimitedText(resp);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new WorkloadIdentityError(`Token endpoint returned non-JSON response (status ${resp.status})`, resp.status, redactSensitive(text), requestId);
  }
  if (!data.access_token) {
    throw new WorkloadIdentityError(`Token endpoint response missing access_token: ${JSON.stringify(redactSensitive(data))}`, resp.status, redactSensitive(data), requestId);
  }
  if (data.token_type && data.token_type.toLowerCase() !== "bearer") {
    throw new WorkloadIdentityError(`Token endpoint response: unsupported token_type "${data.token_type}" (want Bearer)`, resp.status, redactSensitive(data), requestId);
  }
  return data;
}
function redactSensitive(body) {
  if (body == null)
    return body;
  if (typeof body === "string") {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      if (body.length <= MAX_ERROR_BODY_CHARS)
        return body;
      return body.slice(0, MAX_ERROR_BODY_CHARS) + `... <${body.length - MAX_ERROR_BODY_CHARS} more chars>`;
    }
    return JSON.stringify(redactSensitive(parsed));
  }
  if (typeof body === "object" && !Array.isArray(body)) {
    const out = {};
    for (const [k, v] of Object.entries(body)) {
      if (SAFE_ERROR_KEYS.has(k))
        out[k] = v;
    }
    return out;
  }
  return null;
}
async function checkCredentialsFileSafety(path11, onWarn = (m) => console.warn(`anthropic-sdk: ${m}`)) {
  if (typeof process === "undefined" || process.platform === "win32")
    return;
  const { fs: fs11 } = await Promise.resolve().then(() => (init_node(), node_exports));
  let resolved = path11;
  let st2;
  try {
    resolved = await fs11.promises.realpath(path11);
    st2 = await fs11.promises.stat(resolved);
  } catch {
    return;
  }
  const mode = st2.mode & 511;
  if (mode & 18) {
    throw new WorkloadIdentityError(`Credentials file at ${resolved} is group/world-writable (mode 0o${mode.toString(8)}); this allows other local users to plant tokens. Run \`chmod 600 ${resolved}\`.`);
  }
  if (mode & 36) {
    throw new WorkloadIdentityError(`Credentials file at ${resolved} is group/world-readable (mode 0o${mode.toString(8)}); run \`chmod 600 ${resolved}\` before retrying.`);
  }
  if (typeof process.getuid === "function" && st2.uid !== process.getuid()) {
    onWarn(`credentials file at ${resolved} is owned by uid ${st2.uid} (current process uid ${process.getuid()}); verify this is intentional.`);
  }
}
async function writeCredentialsFileAtomic(targetPath, data) {
  const { fs: fs11, path: path11 } = await Promise.resolve().then(() => (init_node(), node_exports));
  const dir = path11.dirname(targetPath);
  await fs11.promises.mkdir(dir, { recursive: true, mode: 448 });
  const tmpPath = `${targetPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    const fh = await fs11.promises.open(tmpPath, "w", 384);
    try {
      await fh.writeFile(JSON.stringify(data, null, 2));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs11.promises.rename(tmpPath, targetPath);
  } catch (err) {
    await fs11.promises.unlink(tmpPath).catch(() => {
    });
    throw err;
  }
  try {
    const dirFh = await fs11.promises.open(dir, "r");
    try {
      await dirFh.sync();
    } finally {
      await dirFh.close();
    }
  } catch {
  }
}
async function readLimitedText(resp) {
  if (!resp.body) {
    return "";
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let received = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done)
      break;
    if (received + value.length > MAX_TOKEN_RESPONSE_BYTES) {
      const remaining = MAX_TOKEN_RESPONSE_BYTES - received;
      if (remaining > 0)
        chunks.push(value.subarray(0, remaining));
      await reader.cancel();
      break;
    }
    chunks.push(value);
    received += value.length;
  }
  let merged;
  if (chunks.length === 1) {
    merged = chunks[0];
  } else {
    merged = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
  }
  return new TextDecoder("utf-8").decode(merged);
}
var GRANT_TYPE_JWT_BEARER, GRANT_TYPE_REFRESH_TOKEN, TOKEN_ENDPOINT, OAUTH_API_BETA_HEADER, FEDERATION_BETA_HEADER, ADVISORY_REFRESH_THRESHOLD_IN_SECONDS, MANDATORY_REFRESH_THRESHOLD_IN_SECONDS, ADVISORY_REFRESH_BACKOFF_IN_SECONDS, MAX_TOKEN_RESPONSE_BYTES, MAX_ERROR_BODY_CHARS, SAFE_ERROR_KEYS, WorkloadIdentityError;
var init_types = __esm({
  "node_modules/@anthropic-ai/sdk/lib/credentials/types.mjs"() {
    init_error();
    GRANT_TYPE_JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
    GRANT_TYPE_REFRESH_TOKEN = "refresh_token";
    TOKEN_ENDPOINT = "/v1/oauth/token";
    OAUTH_API_BETA_HEADER = "oauth-2025-04-20";
    FEDERATION_BETA_HEADER = "oidc-federation-2026-04-01";
    ADVISORY_REFRESH_THRESHOLD_IN_SECONDS = 120;
    MANDATORY_REFRESH_THRESHOLD_IN_SECONDS = 30;
    ADVISORY_REFRESH_BACKOFF_IN_SECONDS = 5;
    MAX_TOKEN_RESPONSE_BYTES = 1 << 20;
    MAX_ERROR_BODY_CHARS = 2e3;
    SAFE_ERROR_KEYS = /* @__PURE__ */ new Set(["error", "error_description", "error_uri"]);
    WorkloadIdentityError = class extends AnthropicError {
      constructor(message, statusCode = null, body = null, requestId = null) {
        super(message);
        this.statusCode = statusCode;
        this.body = body;
        this.requestId = requestId;
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/utils/time.mjs
function nowAsSeconds() {
  return Math.floor(Date.now() / 1e3);
}
var init_time = __esm({
  "node_modules/@anthropic-ai/sdk/internal/utils/time.mjs"() {
  }
});

// node_modules/@anthropic-ai/sdk/lib/credentials/token-cache.mjs
var TokenCache;
var init_token_cache = __esm({
  "node_modules/@anthropic-ai/sdk/lib/credentials/token-cache.mjs"() {
    init_types();
    init_time();
    TokenCache = class {
      constructor(provider, onAdvisoryRefreshError) {
        this.cached = null;
        this.pendingRefresh = null;
        this.nextForce = false;
        this.lastAdvisoryError = 0;
        this.provider = provider;
        this.onAdvisoryRefreshError = onAdvisoryRefreshError;
      }
      async getToken() {
        const force = this.nextForce;
        this.nextForce = false;
        const cached = this.cached;
        if (force || cached == null) {
          const token2 = await this.refresh(force);
          return token2.token;
        }
        if (cached.expiresAt == null) {
          return cached.token;
        }
        const remaining = cached.expiresAt - nowAsSeconds();
        if (remaining > ADVISORY_REFRESH_THRESHOLD_IN_SECONDS) {
          return cached.token;
        }
        if (remaining > MANDATORY_REFRESH_THRESHOLD_IN_SECONDS) {
          this.backgroundRefresh();
          return cached.token;
        }
        const token = await this.refresh();
        return token.token;
      }
      /**
       * Clears the cached token and marks the next {@link getToken} as a forced
       * refresh, so the underlying provider bypasses any on-disk freshness check.
       * Called after a 401 — the server has just told us the token is bad even
       * if its `expires_at` still looks fresh.
       */
      invalidate() {
        this.cached = null;
        this.nextForce = true;
      }
      /**
       * Mandatory refresh. Joins any in-flight refresh unless forced — a forced
       * refresh must not coalesce into a non-forced one that may re-serve the
       * same stale disk token.
       */
      refresh(force = false) {
        if (this.pendingRefresh && !force) {
          return this.pendingRefresh;
        }
        return this.doRefresh(force);
      }
      /**
       * Advisory background refresh. Shares the same in-flight promise as
       * mandatory refreshes for deduplication, but swallows errors so the
       * stale cached token keeps being served. Backs off for
       * {@link ADVISORY_REFRESH_BACKOFF_IN_SECONDS} after a failure so an
       * outage during the advisory window doesn't hammer the token endpoint.
       */
      backgroundRefresh() {
        if (this.pendingRefresh) {
          return;
        }
        if (nowAsSeconds() - this.lastAdvisoryError < ADVISORY_REFRESH_BACKOFF_IN_SECONDS) {
          return;
        }
        this.doRefresh().catch((err) => {
          this.lastAdvisoryError = nowAsSeconds();
          this.onAdvisoryRefreshError?.(err);
        });
      }
      /**
       * Core refresh. Sets {@link pendingRefresh} so concurrent callers
       * (both advisory and mandatory) coalesce into a single provider call.
       */
      doRefresh(force = false) {
        this.pendingRefresh = this.provider(force ? { forceRefresh: true } : void 0).then((token) => {
          this.cached = token;
          this.pendingRefresh = null;
          return token;
        }, (err) => {
          this.pendingRefresh = null;
          throw err;
        });
        return this.pendingRefresh;
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/utils/env.mjs
var readEnv;
var init_env = __esm({
  "node_modules/@anthropic-ai/sdk/internal/utils/env.mjs"() {
    readEnv = (env) => {
      if (typeof globalThis.process !== "undefined") {
        return globalThis.process.env?.[env]?.trim() || void 0;
      }
      if (typeof globalThis.Deno !== "undefined") {
        return globalThis.Deno.env?.get?.(env)?.trim() || void 0;
      }
      return void 0;
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/utils/bytes.mjs
function concatBytes(buffers) {
  let length = 0;
  for (const buffer of buffers) {
    length += buffer.length;
  }
  const output = new Uint8Array(length);
  let index = 0;
  for (const buffer of buffers) {
    output.set(buffer, index);
    index += buffer.length;
  }
  return output;
}
function encodeUTF8(str2) {
  let encoder;
  return (encodeUTF8_ ?? (encoder = new globalThis.TextEncoder(), encodeUTF8_ = encoder.encode.bind(encoder)))(str2);
}
function decodeUTF8(bytes) {
  let decoder;
  return (decodeUTF8_ ?? (decoder = new globalThis.TextDecoder(), decodeUTF8_ = decoder.decode.bind(decoder)))(bytes);
}
var encodeUTF8_, decodeUTF8_;
var init_bytes = __esm({
  "node_modules/@anthropic-ai/sdk/internal/utils/bytes.mjs"() {
  }
});

// node_modules/@anthropic-ai/sdk/internal/utils/base64.mjs
var fromBase64;
var init_base64 = __esm({
  "node_modules/@anthropic-ai/sdk/internal/utils/base64.mjs"() {
    init_error();
    fromBase64 = (str2) => {
      if (typeof globalThis.Buffer !== "undefined") {
        const buf = globalThis.Buffer.from(str2, "base64");
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      }
      if (typeof atob !== "undefined") {
        const bstr = atob(str2);
        const buf = new Uint8Array(bstr.length);
        for (let i = 0; i < bstr.length; i++) {
          buf[i] = bstr.charCodeAt(i);
        }
        return buf;
      }
      throw new AnthropicError("Cannot decode base64 string; Expected `Buffer` or `atob` to be defined");
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/utils/log.mjs
function noop() {
}
function makeLogFn(fnLevel, logger, logLevel) {
  if (!logger || levelNumbers[fnLevel] > levelNumbers[logLevel]) {
    return noop;
  } else {
    return logger[fnLevel].bind(logger);
  }
}
function filterLogger(logger, logLevel) {
  const cachedLogger = cachedLoggers.get(logger);
  if (cachedLogger && cachedLogger[0] === logLevel) {
    return cachedLogger[1];
  }
  const levelLogger = {
    error: makeLogFn("error", logger, logLevel),
    warn: makeLogFn("warn", logger, logLevel),
    info: makeLogFn("info", logger, logLevel),
    debug: makeLogFn("debug", logger, logLevel)
  };
  cachedLoggers.set(logger, [logLevel, levelLogger]);
  return levelLogger;
}
function loggerFor(client2) {
  const logger = client2.logger;
  const logLevel = client2.logLevel ?? "off";
  if (!logger) {
    return noopLogger;
  }
  return filterLogger(logger, logLevel);
}
function defaultLogger() {
  const envLevel = readEnv("ANTHROPIC_LOG");
  if (!cachedDefaultLogger || envLevel !== lastEnvLevel) {
    lastEnvLevel = envLevel;
    cachedDefaultLogger = filterLogger(console, parseLogLevel(envLevel, "process.env['ANTHROPIC_LOG']", filterLogger(console, defaultLogLevel)) ?? defaultLogLevel);
  }
  return cachedDefaultLogger;
}
function debugLogRequestDetails(logger, message, details) {
  if (logger.debug === noop) {
    return;
  }
  logger.debug(message, formatRequestDetails(details));
}
var defaultLogLevel, levelNumbers, parseLogLevel, noopLogger, cachedLoggers, lastEnvLevel, cachedDefaultLogger, formatRequestDetails;
var init_log = __esm({
  "node_modules/@anthropic-ai/sdk/internal/utils/log.mjs"() {
    init_values();
    init_env();
    defaultLogLevel = "warn";
    levelNumbers = {
      off: 0,
      error: 200,
      warn: 300,
      info: 400,
      debug: 500
    };
    parseLogLevel = (maybeLevel, sourceName, logger) => {
      if (!maybeLevel) {
        return void 0;
      }
      if (hasOwn(levelNumbers, maybeLevel)) {
        return maybeLevel;
      }
      logger.warn(`${sourceName} was set to ${JSON.stringify(maybeLevel)}, expected one of ${JSON.stringify(Object.keys(levelNumbers))}`);
      return void 0;
    };
    noopLogger = {
      error: noop,
      warn: noop,
      info: noop,
      debug: noop
    };
    cachedLoggers = /* @__PURE__ */ new WeakMap();
    formatRequestDetails = (details) => {
      if (details.options) {
        details.options = { ...details.options };
        delete details.options["headers"];
      }
      if (details.headers) {
        details.headers = Object.fromEntries((details.headers instanceof Headers ? [...details.headers] : Object.entries(details.headers)).map(([name, value]) => [
          name,
          name.toLowerCase() === "authorization" || name.toLowerCase() === "api-key" || name.toLowerCase() === "x-api-key" || name.toLowerCase() === "cookie" || name.toLowerCase() === "set-cookie" ? "***" : value
        ]));
      }
      if ("retryOfRequestLogID" in details) {
        if (details.retryOfRequestLogID) {
          details.retryOf = details.retryOfRequestLogID;
        }
        delete details.retryOfRequestLogID;
      }
      return details;
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/utils/uuid.mjs
var uuid4;
var init_uuid = __esm({
  "node_modules/@anthropic-ai/sdk/internal/utils/uuid.mjs"() {
    uuid4 = function() {
      const { crypto: crypto8 } = globalThis;
      if (crypto8?.randomUUID) {
        uuid4 = crypto8.randomUUID.bind(crypto8);
        return crypto8.randomUUID();
      }
      const u8 = new Uint8Array(1);
      const randomByte = crypto8 ? () => crypto8.getRandomValues(u8)[0] : () => Math.random() * 255 & 255;
      return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (+c ^ randomByte() & 15 >> +c / 4).toString(16));
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/utils.mjs
var init_utils2 = __esm({
  "node_modules/@anthropic-ai/sdk/internal/utils.mjs"() {
    init_values();
    init_base64();
    init_env();
    init_log();
    init_uuid();
    init_sleep();
    init_query();
  }
});

// node_modules/@anthropic-ai/sdk/core/credentials.mjs
function validateProfileName(name) {
  if (!name) {
    throw new Error("profile name is empty");
  }
  if (name === "." || name === "..") {
    throw new Error(`profile name "${name}" is not allowed`);
  }
  if (name.includes("/") || name.includes("\\")) {
    throw new Error(`profile name "${name}" must not contain path separators`);
  }
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw new Error(`profile name "${name}" contains disallowed characters (allowed: letters, digits, '_', '.', '-')`);
  }
}
var CREDENTIALS_FILE_VERSION, PROFILE_NAME_PATTERN, loadConfigWithSource, getCredentialsPath, getRootConfigPath, supportsLocalConfigFiles, getActiveProfileName;
var init_credentials = __esm({
  "node_modules/@anthropic-ai/sdk/core/credentials.mjs"() {
    init_detect_platform();
    init_utils2();
    CREDENTIALS_FILE_VERSION = "1.0";
    PROFILE_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
    loadConfigWithSource = async (profile) => {
      var _a2, _b;
      const rootConfigPath = await getRootConfigPath();
      if (rootConfigPath === null) {
        return null;
      }
      const profileName = profile ?? await getActiveProfileName();
      if (profileName === null) {
        return null;
      }
      validateProfileName(profileName);
      const { fs: fs11, path: path11 } = await Promise.resolve().then(() => (init_node(), node_exports));
      const configPath = path11.join(rootConfigPath, "configs", `${profileName}.json`);
      let configRaw;
      try {
        configRaw = await fs11.promises.readFile(configPath, "utf-8");
      } catch (err) {
        if (err?.code !== "ENOENT") {
          throw new Error(`failed to read config file ${configPath}: ${err}`);
        }
        configRaw = null;
      }
      if (configRaw === null) {
        const organizationId = readEnv("ANTHROPIC_ORGANIZATION_ID");
        const identityTokenFile = readEnv("ANTHROPIC_IDENTITY_TOKEN_FILE");
        const federationRuleId = readEnv("ANTHROPIC_FEDERATION_RULE_ID");
        if (federationRuleId && organizationId) {
          return {
            fromFile: false,
            config: {
              organization_id: organizationId,
              // A defaulted-but-empty CI variable (`ANTHROPIC_WORKSPACE_ID=""`) is
              // treated as unset — readEnv coerces empty to undefined, and the body
              // builder's truthy check skips it — so `"workspace_id": ""` never goes
              // on the wire.
              workspace_id: readEnv("ANTHROPIC_WORKSPACE_ID"),
              base_url: readEnv("ANTHROPIC_BASE_URL"),
              authentication: {
                type: "oidc_federation",
                federation_rule_id: federationRuleId,
                service_account_id: readEnv("ANTHROPIC_SERVICE_ACCOUNT_ID"),
                identity_token: identityTokenFile ? { source: "file", path: identityTokenFile } : void 0,
                scope: readEnv("ANTHROPIC_SCOPE")
              }
            }
          };
        }
        return null;
      }
      let config;
      try {
        config = JSON.parse(configRaw);
      } catch (err) {
        throw new Error(`failed to parse config file ${configPath}: ${err}`);
      }
      if (!config.authentication) {
        throw new Error(`config file ${configPath} is missing "authentication"`);
      }
      const authType = config.authentication.type;
      if (authType !== "oidc_federation" && authType !== "user_oauth") {
        throw new Error(`authentication.type "${authType}" is not a known authentication type`);
      }
      config.organization_id ?? (config.organization_id = readEnv("ANTHROPIC_ORGANIZATION_ID"));
      config.workspace_id ?? (config.workspace_id = readEnv("ANTHROPIC_WORKSPACE_ID"));
      config.base_url ?? (config.base_url = readEnv("ANTHROPIC_BASE_URL"));
      (_a2 = config.authentication).scope ?? (_a2.scope = readEnv("ANTHROPIC_SCOPE"));
      if (config.authentication.type === "oidc_federation") {
        if (!config.authentication.identity_token) {
          const identityTokenFile = readEnv("ANTHROPIC_IDENTITY_TOKEN_FILE");
          if (identityTokenFile) {
            config.authentication.identity_token = {
              source: "file",
              path: identityTokenFile
            };
          }
        }
        if (!config.authentication.federation_rule_id) {
          config.authentication.federation_rule_id = readEnv("ANTHROPIC_FEDERATION_RULE_ID") ?? "";
        }
        (_b = config.authentication).service_account_id ?? (_b.service_account_id = readEnv("ANTHROPIC_SERVICE_ACCOUNT_ID"));
      }
      return { config, fromFile: true };
    };
    getCredentialsPath = async (config, profile) => {
      if (config?.authentication.credentials_path) {
        return config.authentication.credentials_path;
      }
      const rootConfigPath = await getRootConfigPath();
      if (!rootConfigPath) {
        return null;
      }
      const profileName = profile ?? await getActiveProfileName();
      if (!profileName) {
        return null;
      }
      validateProfileName(profileName);
      const { path: path11 } = await Promise.resolve().then(() => (init_node(), node_exports));
      return path11.join(rootConfigPath, "credentials", `${profileName}.json`);
    };
    getRootConfigPath = async () => {
      if (!supportsLocalConfigFiles()) {
        return null;
      }
      const { path: path11 } = await Promise.resolve().then(() => (init_node(), node_exports));
      const configDir = readEnv("ANTHROPIC_CONFIG_DIR");
      if (configDir) {
        return configDir;
      }
      const os3 = getPlatformHeaders()["X-Stainless-OS"];
      if (os3 === "Windows") {
        const appData = readEnv("APPDATA");
        if (appData) {
          return path11.join(appData, "Anthropic");
        }
        const userProfile = readEnv("USERPROFILE");
        if (userProfile) {
          return path11.join(userProfile, "AppData", "Roaming", "Anthropic");
        }
        return null;
      }
      const xdgConfigHome = readEnv("XDG_CONFIG_HOME");
      if (xdgConfigHome) {
        return path11.join(xdgConfigHome, "anthropic");
      }
      const home = readEnv("HOME");
      if (home) {
        return path11.join(home, ".config", "anthropic");
      }
      return null;
    };
    supportsLocalConfigFiles = () => {
      const runtime = getPlatformHeaders()["X-Stainless-Runtime"];
      return runtime === "node" || runtime === "deno";
    };
    getActiveProfileName = async () => {
      const rootConfigPath = await getRootConfigPath();
      if (!rootConfigPath) {
        return null;
      }
      const profileName = readEnv("ANTHROPIC_PROFILE");
      if (profileName) {
        return profileName;
      }
      const { fs: fs11, path: path11 } = await Promise.resolve().then(() => (init_node(), node_exports));
      const filePath = path11.join(rootConfigPath, "active_config");
      try {
        return (await fs11.promises.readFile(filePath, "utf-8")).trim() || "default";
      } catch (err) {
        if (err?.code !== "ENOENT") {
          throw new Error(`failed to read ${filePath}: ${err}`);
        }
        return "default";
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/lib/credentials/identity-token.mjs
function identityTokenFromFile(path11) {
  if (!path11) {
    throw new AnthropicError("Identity token file path is empty");
  }
  return async () => {
    const { fs: fs11 } = await Promise.resolve().then(() => (init_node(), node_exports));
    let content;
    try {
      content = await fs11.promises.readFile(path11, "utf-8");
    } catch (err) {
      throw new AnthropicError(`Failed to read identity token file at ${path11}: ${err}`);
    }
    const token = content.trim();
    if (!token) {
      throw new AnthropicError(`Identity token file at ${path11} is empty`);
    }
    return token;
  };
}
function identityTokenFromValue(token) {
  if (!token) {
    throw new AnthropicError("Identity token value is empty");
  }
  return () => token;
}
var init_identity_token = __esm({
  "node_modules/@anthropic-ai/sdk/lib/credentials/identity-token.mjs"() {
    init_error();
  }
});

// node_modules/@anthropic-ai/sdk/lib/credentials/oidc-federation.mjs
function oidcFederationProvider(config) {
  return async () => {
    requireSecureTokenEndpoint(config.baseURL);
    const jwt = await config.identityTokenProvider();
    if (jwt.length > 16 * 1024) {
      throw new WorkloadIdentityError(`Identity token is ${Math.ceil(jwt.length / 1024)} KiB, exceeds the 16 KiB assertion limit`);
    }
    const body = {
      grant_type: GRANT_TYPE_JWT_BEARER,
      assertion: jwt,
      federation_rule_id: config.federationRuleId,
      organization_id: config.organizationId
    };
    if (config.serviceAccountId) {
      body["service_account_id"] = config.serviceAccountId;
    }
    if (config.workspaceId) {
      body["workspace_id"] = config.workspaceId;
    }
    const url = `${config.baseURL}${TOKEN_ENDPOINT}`;
    let resp;
    try {
      resp = await config.fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-beta": `${OAUTH_API_BETA_HEADER},${FEDERATION_BETA_HEADER}`,
          "User-Agent": config.userAgent || `anthropic-sdk-typescript/${VERSION} oidcFederationProvider`
        },
        body: JSON.stringify(body)
      });
    } catch (err) {
      throw new WorkloadIdentityError(`Failed to reach token endpoint ${url}: ${err}`);
    }
    const requestId = resp.headers.get("Request-Id");
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      const redacted = redactSensitive(text);
      let hint = "";
      if (resp.status === 401) {
        const hintMiddle = config.workspaceId ? "" : "If your federation rule is scoped to multiple workspaces, set the ANTHROPIC_WORKSPACE_ID environment variable, the 'workspace_id' config key, or the `workspaceId` option. ";
        hint = ` Ensure your federation rule matches your identity token. ${hintMiddle}View your authentication events in the Workload identity page of Claude Console for more details.`;
      }
      throw new WorkloadIdentityError(`Token exchange failed with status ${resp.status}${requestId ? ` (request-id ${requestId})` : ""}: ${redacted}${hint}`, resp.status, redacted, requestId);
    }
    const data = await parseTokenResponse(resp, requestId);
    const expiresIn = Number(data.expires_in);
    if (!Number.isFinite(expiresIn)) {
      throw new WorkloadIdentityError(`Token endpoint response missing required fields: ${JSON.stringify(redactSensitive(data))}`, resp.status, redactSensitive(data), requestId);
    }
    return {
      token: data.access_token,
      expiresAt: nowAsSeconds() + expiresIn
    };
  };
}
var init_oidc_federation = __esm({
  "node_modules/@anthropic-ai/sdk/lib/credentials/oidc-federation.mjs"() {
    init_types();
    init_time();
    init_version();
  }
});

// node_modules/@anthropic-ai/sdk/lib/credentials/user-oauth.mjs
function userOAuthProvider(config) {
  return async (opts) => {
    const { fs: fs11 } = await Promise.resolve().then(() => (init_node(), node_exports));
    await checkCredentialsFileSafety(config.credentialsPath, config.onSafetyWarning);
    let raw;
    try {
      raw = await fs11.promises.readFile(config.credentialsPath, "utf-8");
    } catch (err) {
      throw new WorkloadIdentityError(`Credentials file not found at ${config.credentialsPath}: ${err}`);
    }
    let creds;
    try {
      creds = JSON.parse(raw);
    } catch (err) {
      throw new WorkloadIdentityError(`Credentials file at ${config.credentialsPath} is not valid JSON: ${err}`);
    }
    const accessToken = creds.access_token;
    if (!accessToken) {
      throw new WorkloadIdentityError(`Credentials file at ${config.credentialsPath} must include 'access_token'`);
    }
    const expiresAt = creds.expires_at;
    if (!opts?.forceRefresh && (expiresAt == null || nowAsSeconds() < expiresAt - MANDATORY_REFRESH_THRESHOLD_IN_SECONDS)) {
      return { token: accessToken, expiresAt: expiresAt ?? null };
    }
    const refreshToken = creds.refresh_token;
    if (!config.clientId || !refreshToken) {
      throw new WorkloadIdentityError(`Access token at ${config.credentialsPath} has expired and no refresh is available (client_id ${config.clientId ? "set" : "empty"}, refresh_token ${refreshToken ? "set" : "empty"})`);
    }
    requireSecureTokenEndpoint(config.baseURL);
    const body = {
      grant_type: GRANT_TYPE_REFRESH_TOKEN,
      refresh_token: refreshToken,
      client_id: config.clientId
    };
    const url = `${config.baseURL}${TOKEN_ENDPOINT}`;
    let resp;
    try {
      resp = await config.fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-beta": OAUTH_API_BETA_HEADER,
          "User-Agent": config.userAgent || `anthropic-sdk-typescript/${VERSION} userOAuthProvider`
        },
        body: JSON.stringify(body)
      });
    } catch (err) {
      throw new WorkloadIdentityError(`User OAuth refresh failed to reach token endpoint: ${err}`);
    }
    const requestId = resp.headers.get("Request-Id");
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new WorkloadIdentityError(`User OAuth refresh failed (HTTP ${resp.status}): ${redactSensitive(text)}`, resp.status, redactSensitive(text), requestId);
    }
    const data = await parseTokenResponse(resp, requestId);
    const expiresIn = Number(data.expires_in);
    if (!Number.isFinite(expiresIn)) {
      throw new WorkloadIdentityError(`User OAuth refresh response missing or invalid expires_in: ${JSON.stringify(redactSensitive(data))}`, resp.status, redactSensitive(data), requestId);
    }
    const newExpiresAt = nowAsSeconds() + expiresIn;
    const newRefreshToken = data.refresh_token || refreshToken;
    await writeCredentialsFileAtomic(config.credentialsPath, {
      ...creds,
      version: CREDENTIALS_FILE_VERSION,
      type: "oauth_token",
      access_token: data.access_token,
      expires_at: newExpiresAt,
      refresh_token: newRefreshToken
    });
    return { token: data.access_token, expiresAt: newExpiresAt };
  };
}
var init_user_oauth = __esm({
  "node_modules/@anthropic-ai/sdk/lib/credentials/user-oauth.mjs"() {
    init_credentials();
    init_types();
    init_time();
    init_version();
  }
});

// node_modules/@anthropic-ai/sdk/lib/credentials/credential-chain.mjs
function resolveCredentialsFromConfig(config, options) {
  const credentialsPath = config.authentication.credentials_path ?? null;
  const effectiveBaseURL = (config.base_url || options.baseURL).replace(/\/+$/, "");
  const provider = buildProvider(config, credentialsPath, effectiveBaseURL, options);
  const extraHeaders = {};
  if (config.workspace_id && config.authentication.type === "user_oauth") {
    extraHeaders["anthropic-workspace-id"] = config.workspace_id;
  }
  return { provider, extraHeaders, baseURL: config.base_url || void 0 };
}
async function defaultCredentials(options, profile) {
  const loaded = await loadConfigWithSource(profile);
  if (!loaded) {
    return null;
  }
  const { config, fromFile } = loaded;
  const withPath = config.authentication.credentials_path || !fromFile ? config : {
    ...config,
    authentication: {
      ...config.authentication,
      credentials_path: await getCredentialsPath(config, profile) ?? void 0
    }
  };
  return resolveCredentialsFromConfig(withPath, options);
}
function buildProvider(config, credentialsPath, baseURL2, options) {
  switch (config.authentication.type) {
    case "oidc_federation": {
      const auth = config.authentication;
      const identityProvider = resolveIdentityTokenProvider(auth);
      if (!identityProvider) {
        throw new WorkloadIdentityError("oidc_federation config requires an identity token (set authentication.identity_token, ANTHROPIC_IDENTITY_TOKEN_FILE, or ANTHROPIC_IDENTITY_TOKEN)");
      }
      if (!auth.federation_rule_id) {
        throw new WorkloadIdentityError("oidc_federation config requires 'federation_rule_id'. Set it in authentication.federation_rule_id in your profile, or via ANTHROPIC_FEDERATION_RULE_ID (profile takes precedence).");
      }
      if (!config.organization_id) {
        throw new WorkloadIdentityError("oidc_federation config requires organization_id (set ANTHROPIC_ORGANIZATION_ID or config.organization_id)");
      }
      const exchange = oidcFederationProvider({
        identityTokenProvider: identityProvider,
        federationRuleId: auth.federation_rule_id,
        organizationId: config.organization_id,
        serviceAccountId: auth.service_account_id,
        workspaceId: config.workspace_id,
        baseURL: baseURL2,
        fetch: options.fetch,
        userAgent: options.userAgent
      });
      if (credentialsPath) {
        return cachedExchangeProvider(exchange, credentialsPath, options.onCacheWriteError, options.onSafetyWarning);
      }
      return exchange;
    }
    case "user_oauth": {
      if (!credentialsPath) {
        throw new WorkloadIdentityError("user_oauth config requires authentication.credentials_path (or load via a profile so it defaults to <config_dir>/credentials/<profile>.json)");
      }
      return userOAuthProvider({
        credentialsPath,
        clientId: config.authentication.client_id,
        baseURL: baseURL2,
        fetch: options.fetch,
        userAgent: options.userAgent,
        onSafetyWarning: options.onSafetyWarning
      });
    }
    default: {
      const t = config.authentication.type;
      throw new WorkloadIdentityError(`authentication.type "${t}" is not a known authentication type`);
    }
  }
}
function resolveIdentityTokenProvider(auth) {
  if (auth.identity_token) {
    const source = auth.identity_token.source;
    if (source !== "file") {
      throw new WorkloadIdentityError(`identity_token.source "${source}" is not supported by this SDK version (only "file")`);
    }
    if (!auth.identity_token.path) {
      throw new WorkloadIdentityError(`identity_token.source "file" requires a non-empty path`);
    }
    return identityTokenFromFile(auth.identity_token.path);
  }
  const tokenFile = readEnv("ANTHROPIC_IDENTITY_TOKEN_FILE");
  if (tokenFile) {
    return identityTokenFromFile(tokenFile);
  }
  const tokenValue = readEnv("ANTHROPIC_IDENTITY_TOKEN");
  if (tokenValue) {
    return identityTokenFromValue(tokenValue);
  }
  return null;
}
function cachedExchangeProvider(exchange, credentialsPath, onCacheWriteError, onSafetyWarning) {
  return async (opts) => {
    const { fs: fs11 } = await Promise.resolve().then(() => (init_node(), node_exports));
    await checkCredentialsFileSafety(credentialsPath, onSafetyWarning);
    let existing;
    try {
      const raw = await fs11.promises.readFile(credentialsPath, "utf-8");
      existing = JSON.parse(raw);
      const token = existing?.["access_token"];
      if (token && !opts?.forceRefresh) {
        const expiresAt = existing?.["expires_at"];
        if (expiresAt == null || nowAsSeconds() < expiresAt - MANDATORY_REFRESH_THRESHOLD_IN_SECONDS) {
          return { token, expiresAt: expiresAt ?? null };
        }
      }
    } catch (err) {
      const code = err?.code;
      if (code !== "ENOENT" && !(err instanceof SyntaxError)) {
        onCacheWriteError?.(err);
      }
    }
    const result = await exchange(opts);
    try {
      await writeCredentialsFileAtomic(credentialsPath, {
        ...existing ?? {},
        version: CREDENTIALS_FILE_VERSION,
        type: "oauth_token",
        access_token: result.token,
        expires_at: result.expiresAt
      });
    } catch (err) {
      onCacheWriteError?.(err);
    }
    return result;
  };
}
var init_credential_chain = __esm({
  "node_modules/@anthropic-ai/sdk/lib/credentials/credential-chain.mjs"() {
    init_env();
    init_credentials();
    init_types();
    init_time();
    init_identity_token();
    init_oidc_federation();
    init_user_oauth();
  }
});

// node_modules/@anthropic-ai/sdk/internal/decoders/line.mjs
function findNewlineIndex(buffer, startIndex) {
  const newline = 10;
  const carriage = 13;
  for (let i = startIndex ?? 0; i < buffer.length; i++) {
    if (buffer[i] === newline) {
      return { preceding: i, index: i + 1, carriage: false };
    }
    if (buffer[i] === carriage) {
      return { preceding: i, index: i + 1, carriage: true };
    }
  }
  return null;
}
var _LineDecoder_buffer, _LineDecoder_carriageReturnIndex, LineDecoder;
var init_line = __esm({
  "node_modules/@anthropic-ai/sdk/internal/decoders/line.mjs"() {
    init_tslib();
    init_bytes();
    LineDecoder = /* @__PURE__ */ (() => {
      class LineDecoder2 {
        constructor() {
          _LineDecoder_buffer.set(this, void 0);
          _LineDecoder_carriageReturnIndex.set(this, void 0);
          __classPrivateFieldSet(this, _LineDecoder_buffer, new Uint8Array(), "f");
          __classPrivateFieldSet(this, _LineDecoder_carriageReturnIndex, null, "f");
        }
        decode(chunk) {
          if (chunk == null) {
            return [];
          }
          const binaryChunk = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : typeof chunk === "string" ? encodeUTF8(chunk) : chunk;
          __classPrivateFieldSet(this, _LineDecoder_buffer, concatBytes([__classPrivateFieldGet(this, _LineDecoder_buffer, "f"), binaryChunk]), "f");
          const lines = [];
          let patternIndex;
          while ((patternIndex = findNewlineIndex(__classPrivateFieldGet(this, _LineDecoder_buffer, "f"), __classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f"))) != null) {
            if (patternIndex.carriage && __classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f") == null) {
              __classPrivateFieldSet(this, _LineDecoder_carriageReturnIndex, patternIndex.index, "f");
              continue;
            }
            if (__classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f") != null && (patternIndex.index !== __classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f") + 1 || patternIndex.carriage)) {
              lines.push(decodeUTF8(__classPrivateFieldGet(this, _LineDecoder_buffer, "f").subarray(0, __classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f") - 1)));
              __classPrivateFieldSet(this, _LineDecoder_buffer, __classPrivateFieldGet(this, _LineDecoder_buffer, "f").subarray(__classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f")), "f");
              __classPrivateFieldSet(this, _LineDecoder_carriageReturnIndex, null, "f");
              continue;
            }
            const endIndex = __classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f") !== null ? patternIndex.preceding - 1 : patternIndex.preceding;
            const line = decodeUTF8(__classPrivateFieldGet(this, _LineDecoder_buffer, "f").subarray(0, endIndex));
            lines.push(line);
            __classPrivateFieldSet(this, _LineDecoder_buffer, __classPrivateFieldGet(this, _LineDecoder_buffer, "f").subarray(patternIndex.index), "f");
            __classPrivateFieldSet(this, _LineDecoder_carriageReturnIndex, null, "f");
          }
          return lines;
        }
        flush() {
          if (!__classPrivateFieldGet(this, _LineDecoder_buffer, "f").length) {
            return [];
          }
          return this.decode("\n");
        }
      }
      _LineDecoder_buffer = /* @__PURE__ */ new WeakMap(), _LineDecoder_carriageReturnIndex = /* @__PURE__ */ new WeakMap();
      LineDecoder2.NEWLINE_CHARS = /* @__PURE__ */ new Set(["\n", "\r"]);
      LineDecoder2.NEWLINE_REGEXP = /\r\n|[\n\r]/g;
      return LineDecoder2;
    })();
  }
});

// node_modules/@anthropic-ai/sdk/core/streaming.mjs
async function* _iterSSEMessages(response, controller) {
  if (!response.body) {
    controller.abort();
    if (typeof globalThis.navigator !== "undefined" && globalThis.navigator.product === "ReactNative") {
      throw new AnthropicError(`The default react-native fetch implementation does not support streaming. Please use expo/fetch: https://docs.expo.dev/versions/latest/sdk/expo/#expofetch-api`);
    }
    throw new AnthropicError(`Attempted to iterate over a response with no body`);
  }
  const sseDecoder = new SSEDecoder();
  const lineDecoder = new LineDecoder();
  const iter = ReadableStreamToAsyncIterable(response.body);
  for await (const chunk of iter) {
    for (const line of lineDecoder.decode(chunk)) {
      const sse = sseDecoder.decode(line);
      if (sse)
        yield sse;
    }
  }
  for (const line of lineDecoder.flush()) {
    const sse = sseDecoder.decode(line);
    if (sse)
      yield sse;
  }
}
function partition(str2, delimiter2) {
  const index = str2.indexOf(delimiter2);
  if (index !== -1) {
    return [str2.substring(0, index), delimiter2, str2.substring(index + delimiter2.length)];
  }
  return [str2, "", ""];
}
var _Stream_client, Stream, SSEDecoder;
var init_streaming = __esm({
  "node_modules/@anthropic-ai/sdk/core/streaming.mjs"() {
    init_tslib();
    init_error();
    init_shims();
    init_line();
    init_shims();
    init_errors();
    init_values();
    init_bytes();
    init_log();
    init_error();
    init_request_signal();
    Stream = /* @__PURE__ */ (() => {
      class Stream2 {
        constructor(iterator, controller, client2) {
          this.iterator = iterator;
          _Stream_client.set(this, void 0);
          this.controller = controller;
          __classPrivateFieldSet(this, _Stream_client, client2, "f");
        }
        /**
         * Iterate the raw Server-Sent Events from `response` — `{event, data, raw}`
         * objects, before any JSON parsing or event-name filtering.
         *
         * This reads `response.body` directly (not a clone), so the response is
         * consumed. Use this in middleware that fully replaces the stream body; for
         * read-only observation of parsed events, use `ctx.parse()` instead.
         */
        static rawEvents(response, controller = new AbortController()) {
          return _iterSSEMessages(response, controller);
        }
        static fromSSEResponse(response, controller, client2) {
          let consumed = false;
          const logger = client2 ? loggerFor(client2) : console;
          async function* iterator() {
            if (consumed) {
              throw new AnthropicError("Cannot iterate over a consumed stream, use `.tee()` to split the stream.");
            }
            consumed = true;
            let done = false;
            try {
              for await (const sse of _iterSSEMessages(response, controller)) {
                if (sse.event === "completion") {
                  try {
                    yield JSON.parse(sse.data);
                  } catch (e) {
                    logger.error(`Could not parse message into JSON:`, sse.data);
                    logger.error(`From chunk:`, sse.raw);
                    throw e;
                  }
                }
                if (sse.event === "message_start" || sse.event === "message_delta" || sse.event === "message_stop" || sse.event === "content_block_start" || sse.event === "content_block_delta" || sse.event === "content_block_stop" || sse.event === "message" || sse.event === "user.message" || sse.event === "user.interrupt" || sse.event === "user.tool_confirmation" || sse.event === "user.custom_tool_result" || sse.event === "user.tool_result" || sse.event === "agent.message" || sse.event === "agent.thinking" || sse.event === "agent.tool_use" || sse.event === "agent.tool_result" || sse.event === "agent.mcp_tool_use" || sse.event === "agent.mcp_tool_result" || sse.event === "agent.custom_tool_use" || sse.event === "agent.thread_context_compacted" || sse.event === "session.status_running" || sse.event === "session.status_idle" || sse.event === "session.status_rescheduled" || sse.event === "session.status_terminated" || sse.event === "session.error" || sse.event === "session.deleted" || sse.event === "session.updated" || sse.event === "span.model_request_start" || sse.event === "span.model_request_end" || sse.event === "span.outcome_evaluation_start" || sse.event === "span.outcome_evaluation_ongoing" || sse.event === "span.outcome_evaluation_end" || sse.event === "user.define_outcome" || sse.event === "agent.thread_message_received" || sse.event === "agent.thread_message_sent" || sse.event === "agent.session_thread_message_received" || sse.event === "agent.session_thread_message_sent" || sse.event === "session.thread_created" || sse.event === "session.thread_status_created" || sse.event === "session.thread_status_running" || sse.event === "session.thread_status_idle" || sse.event === "session.thread_status_rescheduled" || sse.event === "session.thread_status_terminated" || sse.event === "event_start" || sse.event === "event_delta" || sse.event === "system.message") {
                  try {
                    yield JSON.parse(sse.data);
                  } catch (e) {
                    logger.error(`Could not parse message into JSON:`, sse.data);
                    logger.error(`From chunk:`, sse.raw);
                    throw e;
                  }
                }
                if (sse.event === "ping") {
                  continue;
                }
                if (sse.event === "error") {
                  const body = safeJSON(sse.data) ?? sse.data;
                  const type = body?.error?.type;
                  throw new APIError(void 0, body, void 0, response.headers, type);
                }
              }
              done = true;
            } catch (e) {
              if (isAbortError(e))
                return;
              throw e;
            } finally {
              if (!done)
                controller.abort();
              releaseRequestSignal(controller);
            }
          }
          return new Stream2(iterator, controller, client2);
        }
        /**
         * Generates a Stream from a newline-separated ReadableStream
         * where each item is a JSON value.
         */
        static fromReadableStream(readableStream, controller, client2) {
          let consumed = false;
          async function* iterLines() {
            const lineDecoder = new LineDecoder();
            const iter = ReadableStreamToAsyncIterable(readableStream);
            for await (const chunk of iter) {
              for (const line of lineDecoder.decode(chunk)) {
                yield line;
              }
            }
            for (const line of lineDecoder.flush()) {
              yield line;
            }
          }
          async function* iterator() {
            if (consumed) {
              throw new AnthropicError("Cannot iterate over a consumed stream, use `.tee()` to split the stream.");
            }
            consumed = true;
            let done = false;
            try {
              for await (const line of iterLines()) {
                if (done)
                  continue;
                if (line)
                  yield JSON.parse(line);
              }
              done = true;
            } catch (e) {
              if (isAbortError(e))
                return;
              throw e;
            } finally {
              if (!done)
                controller.abort();
              releaseRequestSignal(controller);
            }
          }
          return new Stream2(iterator, controller, client2);
        }
        [(_Stream_client = /* @__PURE__ */ new WeakMap(), Symbol.asyncIterator)]() {
          return this.iterator();
        }
        /**
         * Splits the stream into two streams which can be
         * independently read from at different speeds.
         */
        tee() {
          const left = [];
          const right = [];
          const iterator = this.iterator();
          const teeIterator = (queue2) => {
            return {
              next: () => {
                if (queue2.length === 0) {
                  const result = iterator.next();
                  left.push(result);
                  right.push(result);
                }
                return queue2.shift();
              }
            };
          };
          return [
            new Stream2(() => teeIterator(left), this.controller, __classPrivateFieldGet(this, _Stream_client, "f")),
            new Stream2(() => teeIterator(right), this.controller, __classPrivateFieldGet(this, _Stream_client, "f"))
          ];
        }
        /**
         * Converts this stream to a newline-separated ReadableStream of
         * JSON stringified values in the stream
         * which can be turned back into a Stream with `Stream.fromReadableStream()`.
         */
        toReadableStream() {
          const self = this;
          let iter;
          return makeReadableStream({
            async start() {
              iter = self[Symbol.asyncIterator]();
            },
            async pull(ctrl) {
              try {
                const { value, done } = await iter.next();
                if (done)
                  return ctrl.close();
                const bytes = encodeUTF8(JSON.stringify(value) + "\n");
                ctrl.enqueue(bytes);
              } catch (err) {
                ctrl.error(err);
              }
            },
            async cancel() {
              await iter.return?.();
            }
          });
        }
      }
      return Stream2;
    })();
    SSEDecoder = class {
      constructor() {
        this.event = null;
        this.data = [];
        this.chunks = [];
      }
      decode(line) {
        if (line.endsWith("\r")) {
          line = line.substring(0, line.length - 1);
        }
        if (!line) {
          if (!this.event && !this.data.length)
            return null;
          const sse = {
            event: this.event,
            data: this.data.join("\n"),
            raw: this.chunks
          };
          this.event = null;
          this.data = [];
          this.chunks = [];
          return sse;
        }
        this.chunks.push(line);
        if (line.startsWith(":")) {
          return null;
        }
        let [fieldname, _, value] = partition(line, ":");
        if (value.startsWith(" ")) {
          value = value.substring(1);
        }
        if (fieldname === "event") {
          this.event = value;
        } else if (fieldname === "data") {
          this.data.push(value);
        }
        return null;
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/parse.mjs
async function defaultParseResponse(client2, props) {
  const { response, requestLogID, retryOfRequestLogID, startTime } = props;
  const body = await (async () => {
    if (props.options.stream) {
      loggerFor(client2).debug("response", response.status, response.url, response.headers, response.body);
      return Stream.fromSSEResponse(response, props.controller, client2);
    }
    if (response.status === 204) {
      return null;
    }
    if (props.options.__binaryResponse) {
      return response;
    }
    const contentType = response.headers.get("content-type");
    const mediaType = contentType?.split(";")[0]?.trim();
    const isJSON = mediaType?.includes("application/json") || mediaType?.endsWith("+json");
    if (isJSON) {
      const contentLength = response.headers.get("content-length");
      if (contentLength === "0") {
        return void 0;
      }
      const json = await response.json();
      return addResponseIDs(json, response);
    }
    const text = await response.text();
    return text;
  })().finally(() => {
    if (!props.options.stream && !props.options.__binaryResponse) {
      releaseRequestSignal(props.controller);
    }
  });
  debugLogRequestDetails(loggerFor(client2), `[${requestLogID}] response parsed`, {
    retryOfRequestLogID,
    url: response.url,
    status: response.status,
    body,
    durationMs: Date.now() - startTime
  });
  return body;
}
function addResponseIDs(value, response) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  return Object.defineProperties(value, {
    _request_id: { value: response.headers.get("request-id"), enumerable: false },
    _workspace_id: { value: response.headers.get("anthropic-workspace-id"), enumerable: false }
  });
}
var init_parse = __esm({
  "node_modules/@anthropic-ai/sdk/internal/parse.mjs"() {
    init_streaming();
    init_log();
    init_request_signal();
  }
});

// node_modules/@anthropic-ai/sdk/core/middleware.mjs
function isFetchOriginError(err) {
  return typeof err === "object" && err !== null && fetchOriginErrors.has(err);
}
function isRetryableError(err) {
  const seen = /* @__PURE__ */ new Set();
  while (typeof err === "object" && err !== null && !seen.has(err)) {
    seen.add(err);
    if (isFetchOriginError(err) || isAbortError(err) || err instanceof APIConnectionError || err instanceof RetryableError) {
      return true;
    }
    err = err.cause;
  }
  return false;
}
function wrapFetchWithMiddleware(fetchFn, middleware, options, client2) {
  return async (url, init2 = {}) => {
    if (middleware.length === 0) {
      return fetchFn.call(void 0, url, init2);
    }
    const headers = init2.headers instanceof Headers ? init2.headers : new Headers(init2.headers);
    const response = await applyMiddleware(fetchFn, middleware, options, client2)({
      ...init2,
      headers,
      url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url
    });
    if (response.bodyUsed || response.body?.locked) {
      throw new AnthropicError("middleware consumed the response body; use response.clone() to inspect it, or return new Response(body, response) to consume and replace it");
    }
    return response;
  };
}
function createMiddlewareContext(options, client2) {
  const cache = /* @__PURE__ */ new WeakMap();
  return {
    options,
    // Resolved per chain, so changes to the client's `logLevel`/`logger`
    // apply to subsequent requests.
    logger: client2 ? loggerFor(client2) : defaultLogger(),
    parse(response) {
      if (options?.stream && response.ok) {
        return parseMiddlewareResponse(response, options, client2);
      }
      let parsed = cache.get(response);
      if (!parsed) {
        parsed = parseMiddlewareResponse(response, options, client2);
        cache.set(response, parsed);
      }
      return parsed;
    }
  };
}
async function parseMiddlewareResponse(response, options, client2) {
  if (response.bodyUsed || response.body?.locked) {
    throw new AnthropicError("cannot ctx.parse() a response whose body was already consumed; call ctx.parse() instead of reading the body, or read via response.clone()");
  }
  if (options?.stream && response.ok) {
    return Stream.fromSSEResponse(response.clone(), new AbortController(), client2);
  }
  if (response.status === 204) {
    return null;
  }
  if (options?.__binaryResponse) {
    return response;
  }
  const contentType = response.headers.get("content-type");
  const mediaType = contentType?.split(";")[0]?.trim();
  const isJSON = mediaType?.includes("application/json") || mediaType?.endsWith("+json");
  if (isJSON) {
    if (response.headers.get("content-length") === "0") {
      return void 0;
    }
    return addResponseIDs(await response.clone().json(), response);
  }
  return await response.clone().text();
}
function applyMiddleware(fetchFn, middleware, options, client2) {
  let next2 = async ({ url, ...init2 }) => {
    try {
      return await fetchFn.call(void 0, url, init2);
    } catch (err) {
      const error = castToError(err);
      fetchOriginErrors.add(error);
      throw error;
    }
  };
  const ctx = createMiddlewareContext(options, client2);
  for (let i = middleware.length - 1; i >= 0; i--) {
    const mw = middleware[i];
    const nextInner = next2;
    next2 = async (request) => mw(request, nextInner, ctx);
  }
  return next2;
}
var fetchOriginErrors;
var init_middleware = __esm({
  "node_modules/@anthropic-ai/sdk/core/middleware.mjs"() {
    init_errors();
    init_parse();
    init_log();
    init_error();
    init_streaming();
    fetchOriginErrors = /* @__PURE__ */ new WeakSet();
  }
});

// node_modules/@anthropic-ai/sdk/core/api-promise.mjs
var _APIPromise_client, APIPromise;
var init_api_promise = __esm({
  "node_modules/@anthropic-ai/sdk/core/api-promise.mjs"() {
    init_tslib();
    init_parse();
    APIPromise = /* @__PURE__ */ (() => {
      class APIPromise2 extends Promise {
        constructor(client2, responsePromise, parseResponse = defaultParseResponse) {
          super((resolve2) => {
            resolve2(null);
          });
          this.responsePromise = responsePromise;
          this.parseResponse = parseResponse;
          _APIPromise_client.set(this, void 0);
          __classPrivateFieldSet(this, _APIPromise_client, client2, "f");
        }
        _thenUnwrap(transform) {
          return new APIPromise2(__classPrivateFieldGet(this, _APIPromise_client, "f"), this.responsePromise, async (client2, props) => addResponseIDs(transform(await this.parseResponse(client2, props), props), props.response));
        }
        /**
         * Gets the raw `Response` instance instead of parsing the response
         * data.
         *
         * If you want to parse the response body but still get the `Response`
         * instance, you can use {@link withResponse()}.
         *
         * 👋 Getting the wrong TypeScript type for `Response`?
         * Try setting `"moduleResolution": "NodeNext"` or add `"lib": ["DOM"]`
         * to your `tsconfig.json`.
         */
        asResponse() {
          return this.responsePromise.then((p) => p.response);
        }
        /**
         * Gets the parsed response data, the raw `Response` instance and the ID of the request,
         * returned via the `request-id` header which is useful for debugging requests and resporting
         * issues to Anthropic.
         *
         * If you just want to get the raw `Response` instance without parsing it,
         * you can use {@link asResponse()}.
         *
         * 👋 Getting the wrong TypeScript type for `Response`?
         * Try setting `"moduleResolution": "NodeNext"` or add `"lib": ["DOM"]`
         * to your `tsconfig.json`.
         */
        async withResponse() {
          const [data, response] = await Promise.all([this.parse(), this.asResponse()]);
          return {
            data,
            response,
            request_id: response.headers.get("request-id"),
            workspace_id: response.headers.get("anthropic-workspace-id")
          };
        }
        parse() {
          if (!this.parsedPromise) {
            this.parsedPromise = this.responsePromise.then((data) => this.parseResponse(__classPrivateFieldGet(this, _APIPromise_client, "f"), data));
          }
          return this.parsedPromise;
        }
        then(onfulfilled, onrejected) {
          return this.parse().then(onfulfilled, onrejected);
        }
        catch(onrejected) {
          return this.parse().catch(onrejected);
        }
        finally(onfinally) {
          return this.parse().finally(onfinally);
        }
      }
      _APIPromise_client = /* @__PURE__ */ new WeakMap();
      return APIPromise2;
    })();
  }
});

// node_modules/@anthropic-ai/sdk/core/pagination.mjs
var _AbstractPage_client, AbstractPage, PagePromise, Page, PageCursor, BidirectionalPageCursor;
var init_pagination = __esm({
  "node_modules/@anthropic-ai/sdk/core/pagination.mjs"() {
    init_tslib();
    init_error();
    init_parse();
    init_api_promise();
    init_values();
    AbstractPage = /* @__PURE__ */ (() => {
      class AbstractPage2 {
        constructor(client2, response, body, options) {
          _AbstractPage_client.set(this, void 0);
          __classPrivateFieldSet(this, _AbstractPage_client, client2, "f");
          this.options = options;
          this.response = response;
          this.body = body;
        }
        hasNextPage() {
          const items = this.getPaginatedItems();
          if (!items.length)
            return false;
          return this.nextPageRequestOptions() != null;
        }
        async getNextPage() {
          const nextOptions = this.nextPageRequestOptions();
          if (!nextOptions) {
            throw new AnthropicError("No next page expected; please check `.hasNextPage()` before calling `.getNextPage()`.");
          }
          return await __classPrivateFieldGet(this, _AbstractPage_client, "f").requestAPIList(this.constructor, nextOptions);
        }
        async *iterPages() {
          let page = this;
          yield page;
          while (page.hasNextPage()) {
            page = await page.getNextPage();
            yield page;
          }
        }
        async *[(_AbstractPage_client = /* @__PURE__ */ new WeakMap(), Symbol.asyncIterator)]() {
          for await (const page of this.iterPages()) {
            for (const item of page.getPaginatedItems()) {
              yield item;
            }
          }
        }
      }
      return AbstractPage2;
    })();
    PagePromise = /* @__PURE__ */ (() => {
      class PagePromise2 extends APIPromise {
        constructor(client2, request, Page2) {
          super(client2, request, async (client3, props) => new Page2(client3, props.response, await defaultParseResponse(client3, props), props.options));
        }
        /**
         * Allow auto-paginating iteration on an unawaited list call, eg:
         *
         *    for await (const item of client.items.list()) {
         *      console.log(item)
         *    }
         */
        async *[Symbol.asyncIterator]() {
          const page = await this;
          for await (const item of page) {
            yield item;
          }
        }
      }
      return PagePromise2;
    })();
    Page = class extends AbstractPage {
      constructor(client2, response, body, options) {
        super(client2, response, body, options);
        this.data = body.data || [];
        this.has_more = body.has_more || false;
        this.first_id = body.first_id || null;
        this.last_id = body.last_id || null;
      }
      getPaginatedItems() {
        return this.data ?? [];
      }
      hasNextPage() {
        if (this.has_more === false) {
          return false;
        }
        return super.hasNextPage();
      }
      nextPageRequestOptions() {
        if (this.options.query?.["before_id"]) {
          const first_id = this.first_id;
          if (!first_id) {
            return null;
          }
          return {
            ...this.options,
            query: {
              ...maybeObj(this.options.query),
              before_id: first_id
            }
          };
        }
        const cursor = this.last_id;
        if (!cursor) {
          return null;
        }
        return {
          ...this.options,
          query: {
            ...maybeObj(this.options.query),
            after_id: cursor
          }
        };
      }
    };
    PageCursor = class extends AbstractPage {
      constructor(client2, response, body, options) {
        super(client2, response, body, options);
        this.data = body.data || [];
        this.next_page = body.next_page || null;
      }
      getPaginatedItems() {
        return this.data ?? [];
      }
      nextPageRequestOptions() {
        const cursor = this.next_page;
        if (!cursor) {
          return null;
        }
        return {
          ...this.options,
          query: {
            ...maybeObj(this.options.query),
            page: cursor
          }
        };
      }
    };
    BidirectionalPageCursor = class extends AbstractPage {
      constructor(client2, response, body, options) {
        super(client2, response, body, options);
        this.data = body.data || [];
        this.next_page = body.next_page || null;
        this.prev_page = body.prev_page || null;
      }
      getPaginatedItems() {
        return this.data ?? [];
      }
      nextPageRequestOptions() {
        const cursor = this.next_page;
        if (!cursor) {
          return null;
        }
        return {
          ...this.options,
          query: {
            ...maybeObj(this.options.query),
            page: cursor
          }
        };
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/uploads.mjs
function makeFile(fileBits, fileName, options) {
  checkFileSupport();
  return new File(fileBits, fileName ?? "", options);
}
function getName(value, stripPath) {
  const val = typeof value === "object" && value !== null && ("name" in value && value.name && String(value.name) || "url" in value && value.url && String(value.url) || "filename" in value && value.filename && String(value.filename) || "path" in value && value.path && String(value.path)) || "";
  return stripPath ? val.split(/[\\/]/).pop() || void 0 : val;
}
function supportsFormData(fetchObject) {
  const fetch2 = typeof fetchObject === "function" ? fetchObject : fetchObject.fetch;
  const cached = supportsFormDataMap.get(fetch2);
  if (cached)
    return cached;
  const promise = (async () => {
    try {
      const FetchResponse = "Response" in fetch2 ? fetch2.Response : (await fetch2("data:,")).constructor;
      const data = new FormData();
      if (data.toString() === await new FetchResponse(data).text()) {
        return false;
      }
      return true;
    } catch {
      return true;
    }
  })();
  supportsFormDataMap.set(fetch2, promise);
  return promise;
}
var checkFileSupport, isAsyncIterable, multipartFormRequestOptions, supportsFormDataMap, createForm, addFormValue;
var init_uploads = __esm({
  "node_modules/@anthropic-ai/sdk/internal/uploads.mjs"() {
    init_shims();
    checkFileSupport = () => {
      if (typeof File === "undefined") {
        const { process: process2 } = globalThis;
        const isOldNode = typeof process2?.versions?.node === "string" && parseInt(process2.versions.node.split(".")) < 20;
        throw new Error("`File` is not defined as a global, which is required for file uploads." + (isOldNode ? " Update to Node 20 LTS or newer, or set `globalThis.File` to `import('node:buffer').File`." : ""));
      }
    };
    isAsyncIterable = (value) => value != null && typeof value === "object" && typeof value[Symbol.asyncIterator] === "function";
    multipartFormRequestOptions = async (opts, fetch2, stripFilenames = true) => {
      return { ...opts, body: await createForm(opts.body, fetch2, stripFilenames) };
    };
    supportsFormDataMap = /* @__PURE__ */ new WeakMap();
    createForm = async (body, fetch2, stripFilenames = true) => {
      if (!await supportsFormData(fetch2)) {
        throw new TypeError("The provided fetch function does not support file uploads with the current global FormData class.");
      }
      const form = new FormData();
      await Promise.all(Object.entries(body || {}).map(([key, value]) => addFormValue(form, key, value, stripFilenames)));
      return form;
    };
    addFormValue = async (form, key, value, stripFilenames) => {
      if (value === void 0)
        return;
      if (value == null) {
        throw new TypeError(`Received null for "${key}"; to pass null in FormData, you must use the string 'null'`);
      }
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        form.append(key, String(value));
      } else if (value instanceof Response) {
        let options = {};
        const contentType = value.headers.get("Content-Type");
        if (contentType) {
          options = { type: contentType };
        }
        form.append(key, makeFile([await value.blob()], getName(value, stripFilenames), options));
      } else if (isAsyncIterable(value)) {
        form.append(key, makeFile([await new Response(ReadableStreamFrom(value)).blob()], getName(value, stripFilenames)));
      } else if (value instanceof Blob) {
        const isFile = typeof File !== "undefined" && value instanceof File;
        const name = isFile ? value.name : getName(value, stripFilenames);
        form.append(key, makeFile([value], name, { type: value.type }));
      } else if (Array.isArray(value)) {
        await Promise.all(value.map((entry) => addFormValue(form, key + "[]", entry, stripFilenames)));
      } else if (typeof value.then === "function") {
        throw new TypeError(`Received a Promise for "${key}"; await it first, e.g. \`await toFile(...)\``);
      } else if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        throw new TypeError(`Received ${value.constructor.name} for "${key}"; to upload raw bytes, wrap them with \`await toFile(bytes, 'filename')\``);
      } else if (typeof value === "object") {
        await Promise.all(Object.entries(value).map(([name, prop]) => addFormValue(form, `${key}[${name}]`, prop, stripFilenames)));
      } else {
        throw new TypeError(`Invalid value given to form, expected a string, number, boolean, object, Array, File or Blob but got ${value} instead`);
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/to-file.mjs
async function toFile(value, name, options) {
  checkFileSupport();
  value = await value;
  name || (name = value instanceof File ? value.name : getName(value, true));
  if (isFileLike(value)) {
    if (value instanceof File && name == null && options == null) {
      return value;
    }
    return makeFile([await value.arrayBuffer()], name ?? value.name, {
      type: value.type,
      lastModified: value.lastModified,
      ...options
    });
  }
  if (isResponseLike(value)) {
    const blob = await value.blob();
    name || (name = new URL(value.url).pathname.split(/[\\/]/).pop());
    return makeFile(await getBytes(blob), name, options);
  }
  const parts = await getBytes(value);
  if (!options?.type) {
    const type = parts.find((part) => typeof part === "object" && "type" in part && part.type);
    if (typeof type === "string") {
      options = { ...options, type };
    }
  }
  return makeFile(parts, name, options);
}
async function getBytes(value) {
  let parts = [];
  if (typeof value === "string" || ArrayBuffer.isView(value) || // includes Uint8Array, Buffer, etc.
  value instanceof ArrayBuffer) {
    parts.push(value);
  } else if (isBlobLike(value)) {
    parts.push(value instanceof Blob ? value : await value.arrayBuffer());
  } else if (isAsyncIterable(value)) {
    for await (const chunk of value) {
      parts.push(...await getBytes(chunk));
    }
  } else {
    const constructor = value?.constructor?.name;
    throw new Error(`Unexpected data type: ${typeof value}${constructor ? `; constructor: ${constructor}` : ""}${propsForError(value)}`);
  }
  return parts;
}
function propsForError(value) {
  if (typeof value !== "object" || value === null)
    return "";
  const props = Object.getOwnPropertyNames(value);
  return `; props: [${props.map((p) => `"${p}"`).join(", ")}]`;
}
var isBlobLike, isFileLike, isResponseLike;
var init_to_file = __esm({
  "node_modules/@anthropic-ai/sdk/internal/to-file.mjs"() {
    init_uploads();
    init_uploads();
    isBlobLike = (value) => value != null && typeof value === "object" && typeof value.size === "number" && typeof value.type === "string" && typeof value.text === "function" && typeof value.slice === "function" && typeof value.arrayBuffer === "function";
    isFileLike = (value) => value != null && typeof value === "object" && typeof value.name === "string" && typeof value.lastModified === "number" && isBlobLike(value);
    isResponseLike = (value) => value != null && typeof value === "object" && typeof value.url === "string" && typeof value.blob === "function";
  }
});

// node_modules/@anthropic-ai/sdk/core/uploads.mjs
var init_uploads2 = __esm({
  "node_modules/@anthropic-ai/sdk/core/uploads.mjs"() {
    init_to_file();
  }
});

// node_modules/@anthropic-ai/sdk/resources/shared.mjs
var init_shared = __esm({
  "node_modules/@anthropic-ai/sdk/resources/shared.mjs"() {
  }
});

// node_modules/@anthropic-ai/sdk/core/resource.mjs
var APIResource;
var init_resource = __esm({
  "node_modules/@anthropic-ai/sdk/core/resource.mjs"() {
    APIResource = class {
      constructor(client2) {
        this._client = client2;
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/headers.mjs
function* iterateHeaders(headers) {
  if (!headers)
    return;
  if (brand_privateNullableHeaders in headers) {
    const { values, nulls } = headers;
    yield* values.entries();
    for (const name of nulls) {
      yield [name, null];
    }
    return;
  }
  let shouldClear = false;
  let iter;
  if (headers instanceof Headers) {
    iter = headers.entries();
  } else if (isReadonlyArray(headers)) {
    iter = headers;
  } else {
    shouldClear = true;
    iter = Object.entries(headers ?? {});
  }
  for (let row of iter) {
    const name = row[0];
    if (typeof name !== "string")
      throw new TypeError("expected header name to be a string");
    const values = isReadonlyArray(row[1]) ? row[1] : [row[1]];
    let didClear = false;
    for (const value of values) {
      if (value === void 0)
        continue;
      if (shouldClear && !didClear) {
        didClear = true;
        yield [name, clearSentinel];
      }
      yield [name, value];
    }
  }
}
var brand_privateNullableHeaders, clearSentinel, APPEND_HEADERS, appendHeaderValue, buildHeaders;
var init_headers = __esm({
  "node_modules/@anthropic-ai/sdk/internal/headers.mjs"() {
    init_values();
    brand_privateNullableHeaders = /* @__PURE__ */ Symbol.for("brand.privateNullableHeaders");
    clearSentinel = /* @__PURE__ */ Symbol("clear");
    APPEND_HEADERS = /* @__PURE__ */ new Set(["x-stainless-helper"]);
    appendHeaderValue = (existing, addition) => {
      const tokens = existing ? existing.split(",").map((t) => t.trim()).filter(Boolean) : [];
      for (const tok of addition.split(",").map((t) => t.trim())) {
        if (tok && !tokens.includes(tok))
          tokens.push(tok);
      }
      return tokens.join(", ");
    };
    buildHeaders = (newHeaders) => {
      const targetHeaders = new Headers();
      const nullHeaders = /* @__PURE__ */ new Set();
      for (const headers of newHeaders) {
        const seenHeaders = /* @__PURE__ */ new Set();
        for (const [name, value] of iterateHeaders(headers)) {
          const lowerName = name.toLowerCase();
          if (APPEND_HEADERS.has(lowerName)) {
            if (value === clearSentinel)
              continue;
            if (value === null) {
              targetHeaders.delete(name);
              nullHeaders.add(lowerName);
            } else {
              targetHeaders.set(name, appendHeaderValue(targetHeaders.get(name), value));
              nullHeaders.delete(lowerName);
            }
            continue;
          }
          if (value === clearSentinel || !seenHeaders.has(lowerName)) {
            targetHeaders.delete(name);
            seenHeaders.add(lowerName);
            if (value === clearSentinel)
              continue;
          }
          if (value === null) {
            targetHeaders.delete(name);
            nullHeaders.add(lowerName);
          } else {
            targetHeaders.append(name, value);
            nullHeaders.delete(lowerName);
          }
        }
      }
      return { [brand_privateNullableHeaders]: true, values: targetHeaders, nulls: nullHeaders };
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/utils/path.mjs
function encodeURIPath(str2) {
  return str2.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@]+/g, encodeURIComponent);
}
var EMPTY, createPathTagFunction, path3;
var init_path = __esm({
  "node_modules/@anthropic-ai/sdk/internal/utils/path.mjs"() {
    init_error();
    EMPTY = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.create(null));
    createPathTagFunction = (pathEncoder = encodeURIPath) => function path11(statics, ...params) {
      if (statics.length === 1)
        return statics[0];
      let postPath = false;
      const invalidSegments = [];
      const path12 = statics.reduce((previousValue, currentValue, index) => {
        if (/[?#]/.test(currentValue)) {
          postPath = true;
        }
        const value = params[index];
        let encoded = (postPath ? encodeURIComponent : pathEncoder)("" + value);
        if (index !== params.length && (value == null || typeof value === "object" && // handle values from other realms
        value.toString === Object.getPrototypeOf(Object.getPrototypeOf(value.hasOwnProperty ?? EMPTY) ?? EMPTY)?.toString)) {
          encoded = value + "";
          invalidSegments.push({
            start: previousValue.length + currentValue.length,
            length: encoded.length,
            error: `Value of type ${Object.prototype.toString.call(value).slice(8, -1)} is not a valid path parameter`
          });
        }
        return previousValue + currentValue + (index === params.length ? "" : encoded);
      }, "");
      const pathOnly = path12.split(/[?#]/, 1)[0];
      const invalidSegmentPattern = /(?<=^|\/)(?:\.|%2e){1,2}(?=\/|$)/gi;
      let match;
      while ((match = invalidSegmentPattern.exec(pathOnly)) !== null) {
        invalidSegments.push({
          start: match.index,
          length: match[0].length,
          error: `Value "${match[0]}" can't be safely passed as a path parameter`
        });
      }
      invalidSegments.sort((a, b) => a.start - b.start);
      if (invalidSegments.length > 0) {
        let lastEnd = 0;
        const underline = invalidSegments.reduce((acc, segment) => {
          const spaces = " ".repeat(segment.start - lastEnd);
          const arrows = "^".repeat(segment.length);
          lastEnd = segment.start + segment.length;
          return acc + spaces + arrows;
        }, "");
        throw new AnthropicError(`Path parameters result in path with invalid segments:
${invalidSegments.map((e) => e.error).join("\n")}
${path12}
${underline}`);
      }
      return path12;
    };
    path3 = /* @__PURE__ */ createPathTagFunction(encodeURIPath);
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/deployment-runs.mjs
var DeploymentRuns;
var init_deployment_runs = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/deployment-runs.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_path();
    DeploymentRuns = class extends APIResource {
      /**
       * Get Deployment Run
       *
       * @example
       * ```ts
       * const betaManagedAgentsDeploymentRun =
       *   await client.beta.deploymentRuns.retrieve(
       *     'deployment_run_id',
       *   );
       * ```
       */
      retrieve(deploymentRunID, params = {}, options) {
        const { betas, workspace_id } = params ?? {};
        return this._client.get(path3`/v1/deployment_runs/${deploymentRunID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * List Deployment Runs
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaManagedAgentsDeploymentRun of client.beta.deploymentRuns.list()) {
       *   // ...
       * }
       * ```
       */
      list(params = {}, options) {
        const { betas, workspace_id, ...query } = params ?? {};
        return this._client.getAPIList("/v1/deployment_runs?beta=true", PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/deployments.mjs
var Deployments;
var init_deployments = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/deployments.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_path();
    Deployments = class extends APIResource {
      /**
       * Create Deployment
       *
       * @example
       * ```ts
       * const betaManagedAgentsDeployment =
       *   await client.beta.deployments.create({
       *     agent: 'string',
       *     environment_id: 'x',
       *     initial_events: [
       *       {
       *         content: [
       *           {
       *             text: 'Where is my order #1234?',
       *             type: 'text',
       *           },
       *         ],
       *         type: 'user.message',
       *       },
       *     ],
       *     name: 'x',
       *   });
       * ```
       */
      create(params, options) {
        const { betas, workspace_id, ...body } = params;
        return this._client.post("/v1/deployments?beta=true", {
          body,
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * Get Deployment
       *
       * @example
       * ```ts
       * const betaManagedAgentsDeployment =
       *   await client.beta.deployments.retrieve(
       *     'depl_011CZkZcDH3vPqd7xnEfwTai',
       *   );
       * ```
       */
      retrieve(deploymentID, params = {}, options) {
        const { betas, workspace_id } = params ?? {};
        return this._client.get(path3`/v1/deployments/${deploymentID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * Update Deployment
       *
       * @example
       * ```ts
       * const betaManagedAgentsDeployment =
       *   await client.beta.deployments.update(
       *     'depl_011CZkZcDH3vPqd7xnEfwTai',
       *   );
       * ```
       */
      update(deploymentID, params, options) {
        const { betas, workspace_id, ...body } = params;
        return this._client.post(path3`/v1/deployments/${deploymentID}?beta=true`, {
          body,
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * List Deployments
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaManagedAgentsDeployment of client.beta.deployments.list()) {
       *   // ...
       * }
       * ```
       */
      list(params = {}, options) {
        const { betas, workspace_id, ...query } = params ?? {};
        return this._client.getAPIList("/v1/deployments?beta=true", PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * Archive Deployment
       *
       * @example
       * ```ts
       * const betaManagedAgentsDeployment =
       *   await client.beta.deployments.archive(
       *     'depl_011CZkZcDH3vPqd7xnEfwTai',
       *   );
       * ```
       */
      archive(deploymentID, params = {}, options) {
        const { betas, workspace_id } = params ?? {};
        return this._client.post(path3`/v1/deployments/${deploymentID}/archive?beta=true`, {
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * Pause Deployment
       *
       * @example
       * ```ts
       * const betaManagedAgentsDeployment =
       *   await client.beta.deployments.pause(
       *     'depl_011CZkZcDH3vPqd7xnEfwTai',
       *   );
       * ```
       */
      pause(deploymentID, params = {}, options) {
        const { betas, workspace_id } = params ?? {};
        return this._client.post(path3`/v1/deployments/${deploymentID}/pause?beta=true`, {
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * Run Deployment Now
       *
       * @example
       * ```ts
       * const betaManagedAgentsDeploymentRun =
       *   await client.beta.deployments.run(
       *     'depl_011CZkZcDH3vPqd7xnEfwTai',
       *   );
       * ```
       */
      run(deploymentID, params = {}, options) {
        const { betas, workspace_id } = params ?? {};
        return this._client.post(path3`/v1/deployments/${deploymentID}/run?beta=true`, {
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * Unpause Deployment
       *
       * @example
       * ```ts
       * const betaManagedAgentsDeployment =
       *   await client.beta.deployments.unpause(
       *     'depl_011CZkZcDH3vPqd7xnEfwTai',
       *   );
       * ```
       */
      unpause(deploymentID, params = {}, options) {
        const { betas, workspace_id } = params ?? {};
        return this._client.post(path3`/v1/deployments/${deploymentID}/unpause?beta=true`, {
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/dreams.mjs
var Dreams;
var init_dreams = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/dreams.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_path();
    Dreams = class extends APIResource {
      /**
       * Start an asynchronous job that uses past sessions to produce a reorganized
       * version of a memory store and get back the dream to poll for the result.
       *
       * By default the dream writes its result to a new memory store and doesn't change
       * the input memory store. The response has `status` set to `pending` and an empty
       * `outputs` array. Poll the dream until `status` is `completed`, `failed`, or
       * `canceled`.
       *
       * See the
       * [Dreams guide](https://platform.claude.com/docs/en/managed-agents/dreams#create-a-dream)
       * to learn more about creating dreams.
       *
       * @example
       * ```ts
       * const betaDream = await client.beta.dreams.create({
       *   inputs: [{ memory_store_id: 'x', type: 'memory_store' }],
       *   model: 'string',
       * });
       * ```
       */
      create(params, options) {
        const { betas, workspace_id, ...body } = params;
        return this._client.post("/v1/dreams?beta=true", {
          body,
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "dreaming-2026-04-21"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * Get a dream by ID to check its status, output memory store, and token usage.
       *
       * Archived dreams are returned too.
       *
       * See the
       * [Dreams guide](https://platform.claude.com/docs/en/managed-agents/dreams#track-progress)
       * for how to poll a dream and what each status means.
       *
       * @example
       * ```ts
       * const betaDream = await client.beta.dreams.retrieve(
       *   'dream_id',
       * );
       * ```
       */
      retrieve(dreamID, params = {}, options) {
        const { betas, workspace_id } = params ?? {};
        return this._client.get(path3`/v1/dreams/${dreamID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "dreaming-2026-04-21"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * List the dreams in the workspace, newest first.
       *
       * Archived dreams are left out unless `include_archived` is `true`.
       *
       * See the
       * [Dreams guide](https://platform.claude.com/docs/en/managed-agents/dreams#list-dreams)
       * for how to page through dreams.
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaDream of client.beta.dreams.list()) {
       *   // ...
       * }
       * ```
       */
      list(params = {}, options) {
        const { betas, workspace_id, ...query } = params ?? {};
        return this._client.getAPIList("/v1/dreams?beta=true", PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "dreaming-2026-04-21"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * Hide a `completed`, `failed`, or `canceled` dream from the default list of
       * dreams.
       *
       * Archiving a `pending` or `running` dream returns a 400 error, so cancel it
       * first. Archiving an archived dream returns it unchanged. An archived dream can
       * still be fetched by ID. Archiving can't be undone.
       *
       * See the
       * [Dreams guide](https://platform.claude.com/docs/en/managed-agents/dreams#archive-a-dream)
       * to learn more about archiving dreams.
       *
       * @example
       * ```ts
       * const betaDream = await client.beta.dreams.archive(
       *   'dream_id',
       * );
       * ```
       */
      archive(dreamID, params = {}, options) {
        const { betas, workspace_id } = params ?? {};
        return this._client.post(path3`/v1/dreams/${dreamID}/archive?beta=true`, {
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "dreaming-2026-04-21"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * Stop a `pending` or `running` dream.
       *
       * The response shows `status` as `canceled`, unless the dream reached `completed`
       * or `failed` first. `usage` can keep changing after the response. Canceling a
       * `canceled` dream returns it unchanged. Canceling a `completed` or `failed` dream
       * returns a 400 error.
       *
       * See the
       * [Dreams guide](https://platform.claude.com/docs/en/managed-agents/dreams#cancel-a-dream)
       * to learn more about canceling dreams.
       *
       * @example
       * ```ts
       * const betaDream = await client.beta.dreams.cancel(
       *   'dream_id',
       * );
       * ```
       */
      cancel(dreamID, params = {}, options) {
        const { betas, workspace_id } = params ?? {};
        return this._client.post(path3`/v1/dreams/${dreamID}/cancel?beta=true`, {
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "dreaming-2026-04-21"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/stainless-helper-header.mjs
function helperHeader(value) {
  return { [STAINLESS_HELPER_HEADER]: value };
}
function wasCreatedByStainlessHelper(value) {
  return typeof value === "object" && value !== null && SDK_HELPER_SYMBOL in value;
}
function collectStainlessHelpers(tools, messages) {
  const helpers = /* @__PURE__ */ new Set();
  if (tools) {
    for (const tool of tools) {
      if (wasCreatedByStainlessHelper(tool)) {
        helpers.add(tool[SDK_HELPER_SYMBOL]);
      }
    }
  }
  if (messages) {
    for (const message of messages) {
      if (wasCreatedByStainlessHelper(message)) {
        helpers.add(message[SDK_HELPER_SYMBOL]);
      }
      const content = message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (wasCreatedByStainlessHelper(block)) {
            helpers.add(block[SDK_HELPER_SYMBOL]);
          }
          const definition = block?.tool?.definition;
          if (wasCreatedByStainlessHelper(definition)) {
            helpers.add(definition[SDK_HELPER_SYMBOL]);
          }
        }
      }
    }
  }
  return Array.from(helpers);
}
function stainlessHelperHeader(tools, messages) {
  const helpers = collectStainlessHelpers(tools, messages);
  if (helpers.length === 0)
    return {};
  return { [STAINLESS_HELPER_HEADER]: helpers.join(", ") };
}
function stainlessHelperHeaderFromFile(file) {
  if (wasCreatedByStainlessHelper(file)) {
    return { [STAINLESS_HELPER_HEADER]: file[SDK_HELPER_SYMBOL] };
  }
  return {};
}
var STAINLESS_HELPER_HEADER, STAINLESS_HELPER_METHOD_HEADER, SDK_HELPER_SYMBOL;
var init_stainless_helper_header = __esm({
  "node_modules/@anthropic-ai/sdk/internal/stainless-helper-header.mjs"() {
    STAINLESS_HELPER_HEADER = "x-stainless-helper";
    STAINLESS_HELPER_METHOD_HEADER = "x-stainless-helper-method";
    SDK_HELPER_SYMBOL = /* @__PURE__ */ Symbol("anthropic.sdk.stainlessHelper");
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/files.mjs
var Files;
var init_files = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/files.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_stainless_helper_header();
    init_uploads();
    init_path();
    Files = class extends APIResource {
      /**
       * List Files
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaFileMetadata of client.beta.files.list()) {
       *   // ...
       * }
       * ```
       */
      list(params = {}, options) {
        const { betas, workspace_id, ...query } = params ?? {};
        return this._client.getAPIList("/v1/files?beta=true", PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            {
              ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0,
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * Delete File
       *
       * @example
       * ```ts
       * const betaDeletedFile = await client.beta.files.delete(
       *   'file_id',
       * );
       * ```
       */
      delete(fileID, params = {}, options) {
        const { betas, workspace_id } = params ?? {};
        return this._client.delete(path3`/v1/files/${fileID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            {
              ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0,
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * Download File
       *
       * @example
       * ```ts
       * const response = await client.beta.files.download(
       *   'file_id',
       * );
       *
       * const content = await response.blob();
       * console.log(content);
       * ```
       */
      download(fileID, params = {}, options) {
        const { betas, workspace_id } = params ?? {};
        return this._client.get(path3`/v1/files/${fileID}/content?beta=true`, {
          ...options,
          headers: buildHeaders([
            {
              Accept: "application/binary",
              ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0,
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ]),
          __binaryResponse: true
        });
      }
      /**
       * Get File Metadata
       *
       * @example
       * ```ts
       * const betaFileMetadata =
       *   await client.beta.files.retrieveMetadata('file_id');
       * ```
       */
      retrieveMetadata(fileID, params = {}, options) {
        const { betas, workspace_id } = params ?? {};
        return this._client.get(path3`/v1/files/${fileID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            {
              ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0,
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * Upload File
       *
       * @example
       * ```ts
       * const betaFileMetadata = await client.beta.files.upload({
       *   file: fs.createReadStream('path/to/file'),
       * });
       * ```
       */
      upload(params, options) {
        const { betas, workspace_id, ...body } = params;
        return this._client.post("/v1/files?beta=true", multipartFormRequestOptions({
          body,
          ...options,
          headers: buildHeaders([
            {
              ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0,
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            stainlessHelperHeaderFromFile(body.file),
            options?.headers
          ])
        }, this._client));
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/models.mjs
var Models;
var init_models = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/models.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_path();
    Models = class extends APIResource {
      /**
       * Get a specific model.
       *
       * The Models API response can be used to determine information about a specific
       * model or resolve a model alias to a model ID.
       *
       * @example
       * ```ts
       * const betaModelInfo = await client.beta.models.retrieve(
       *   'model_id',
       * );
       * ```
       */
      retrieve(modelID, params = {}, options) {
        const { betas, workspace_id } = params ?? {};
        return this._client.get(path3`/v1/models/${modelID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            {
              ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0,
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * List available models.
       *
       * The Models API response can be used to determine which models are available for
       * use in the API. More recently released models are listed first.
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaModelInfo of client.beta.models.list()) {
       *   // ...
       * }
       * ```
       */
      list(params = {}, options) {
        const { betas, workspace_id, ...query } = params ?? {};
        return this._client.getAPIList("/v1/models?beta=true", Page, {
          query,
          ...options,
          headers: buildHeaders([
            {
              ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0,
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/user-profiles.mjs
var UserProfiles;
var init_user_profiles = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/user-profiles.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_path();
    UserProfiles = class extends APIResource {
      /**
       * Create User Profile
       *
       * @example
       * ```ts
       * const betaUserProfile =
       *   await client.beta.userProfiles.create();
       * ```
       */
      create(params, options) {
        const { betas, workspace_id, ...body } = params;
        return this._client.post("/v1/user_profiles?beta=true", {
          body,
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "user-profiles-2026-08-18"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * Get User Profile
       *
       * @example
       * ```ts
       * const betaUserProfile =
       *   await client.beta.userProfiles.retrieve(
       *     'uprof_011CZkZCu8hGbp5mYRQgUmz9',
       *   );
       * ```
       */
      retrieve(userProfileID, params = {}, options) {
        const { betas, workspace_id } = params ?? {};
        return this._client.get(path3`/v1/user_profiles/${userProfileID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "user-profiles-2026-08-18"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * Update User Profile
       *
       * @example
       * ```ts
       * const betaUserProfile =
       *   await client.beta.userProfiles.update(
       *     'uprof_011CZkZCu8hGbp5mYRQgUmz9',
       *   );
       * ```
       */
      update(userProfileID, params, options) {
        const { betas, workspace_id, ...body } = params;
        return this._client.post(path3`/v1/user_profiles/${userProfileID}?beta=true`, {
          body,
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "user-profiles-2026-08-18"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * List User Profiles
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaUserProfile of client.beta.userProfiles.list()) {
       *   // ...
       * }
       * ```
       */
      list(params = {}, options) {
        const { betas, workspace_id, ...query } = params ?? {};
        return this._client.getAPIList("/v1/user_profiles?beta=true", PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "user-profiles-2026-08-18"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * Create Enrollment URL
       *
       * @example
       * ```ts
       * const betaUserProfileEnrollmentURL =
       *   await client.beta.userProfiles.createEnrollmentURL(
       *     'uprof_011CZkZCu8hGbp5mYRQgUmz9',
       *   );
       * ```
       */
      createEnrollmentURL(userProfileID, params = {}, options) {
        const { betas, workspace_id } = params ?? {};
        return this._client.post(path3`/v1/user_profiles/${userProfileID}/enrollment_url?beta=true`, {
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "user-profiles-2026-08-18"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
    };
  }
});

// node_modules/@stablelib/base64/lib/base64.js
var require_base64 = __commonJS({
  "node_modules/@stablelib/base64/lib/base64.js"(exports) {
    "use strict";
    var __extends = exports && exports.__extends || /* @__PURE__ */ (function() {
      var extendStatics = function(d, b) {
        extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d2, b2) {
          d2.__proto__ = b2;
        } || function(d2, b2) {
          for (var p in b2) if (b2.hasOwnProperty(p)) d2[p] = b2[p];
        };
        return extendStatics(d, b);
      };
      return function(d, b) {
        extendStatics(d, b);
        function __() {
          this.constructor = d;
        }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
      };
    })();
    Object.defineProperty(exports, "__esModule", { value: true });
    var INVALID_BYTE = 256;
    var Coder = (
      /** @class */
      (function() {
        function Coder2(_paddingCharacter) {
          if (_paddingCharacter === void 0) {
            _paddingCharacter = "=";
          }
          this._paddingCharacter = _paddingCharacter;
        }
        Coder2.prototype.encodedLength = function(length) {
          if (!this._paddingCharacter) {
            return (length * 8 + 5) / 6 | 0;
          }
          return (length + 2) / 3 * 4 | 0;
        };
        Coder2.prototype.encode = function(data) {
          var out = "";
          var i = 0;
          for (; i < data.length - 2; i += 3) {
            var c = data[i] << 16 | data[i + 1] << 8 | data[i + 2];
            out += this._encodeByte(c >>> 3 * 6 & 63);
            out += this._encodeByte(c >>> 2 * 6 & 63);
            out += this._encodeByte(c >>> 1 * 6 & 63);
            out += this._encodeByte(c >>> 0 * 6 & 63);
          }
          var left = data.length - i;
          if (left > 0) {
            var c = data[i] << 16 | (left === 2 ? data[i + 1] << 8 : 0);
            out += this._encodeByte(c >>> 3 * 6 & 63);
            out += this._encodeByte(c >>> 2 * 6 & 63);
            if (left === 2) {
              out += this._encodeByte(c >>> 1 * 6 & 63);
            } else {
              out += this._paddingCharacter || "";
            }
            out += this._paddingCharacter || "";
          }
          return out;
        };
        Coder2.prototype.maxDecodedLength = function(length) {
          if (!this._paddingCharacter) {
            return (length * 6 + 7) / 8 | 0;
          }
          return length / 4 * 3 | 0;
        };
        Coder2.prototype.decodedLength = function(s) {
          return this.maxDecodedLength(s.length - this._getPaddingLength(s));
        };
        Coder2.prototype.decode = function(s) {
          if (s.length === 0) {
            return new Uint8Array(0);
          }
          var paddingLength = this._getPaddingLength(s);
          var length = s.length - paddingLength;
          var out = new Uint8Array(this.maxDecodedLength(length));
          var op = 0;
          var i = 0;
          var haveBad = 0;
          var v0 = 0, v1 = 0, v2 = 0, v3 = 0;
          for (; i < length - 4; i += 4) {
            v0 = this._decodeChar(s.charCodeAt(i + 0));
            v1 = this._decodeChar(s.charCodeAt(i + 1));
            v2 = this._decodeChar(s.charCodeAt(i + 2));
            v3 = this._decodeChar(s.charCodeAt(i + 3));
            out[op++] = v0 << 2 | v1 >>> 4;
            out[op++] = v1 << 4 | v2 >>> 2;
            out[op++] = v2 << 6 | v3;
            haveBad |= v0 & INVALID_BYTE;
            haveBad |= v1 & INVALID_BYTE;
            haveBad |= v2 & INVALID_BYTE;
            haveBad |= v3 & INVALID_BYTE;
          }
          if (i < length - 1) {
            v0 = this._decodeChar(s.charCodeAt(i));
            v1 = this._decodeChar(s.charCodeAt(i + 1));
            out[op++] = v0 << 2 | v1 >>> 4;
            haveBad |= v0 & INVALID_BYTE;
            haveBad |= v1 & INVALID_BYTE;
          }
          if (i < length - 2) {
            v2 = this._decodeChar(s.charCodeAt(i + 2));
            out[op++] = v1 << 4 | v2 >>> 2;
            haveBad |= v2 & INVALID_BYTE;
          }
          if (i < length - 3) {
            v3 = this._decodeChar(s.charCodeAt(i + 3));
            out[op++] = v2 << 6 | v3;
            haveBad |= v3 & INVALID_BYTE;
          }
          if (haveBad !== 0) {
            throw new Error("Base64Coder: incorrect characters for decoding");
          }
          return out;
        };
        Coder2.prototype._encodeByte = function(b) {
          var result = b;
          result += 65;
          result += 25 - b >>> 8 & 0 - 65 - 26 + 97;
          result += 51 - b >>> 8 & 26 - 97 - 52 + 48;
          result += 61 - b >>> 8 & 52 - 48 - 62 + 43;
          result += 62 - b >>> 8 & 62 - 43 - 63 + 47;
          return String.fromCharCode(result);
        };
        Coder2.prototype._decodeChar = function(c) {
          var result = INVALID_BYTE;
          result += (42 - c & c - 44) >>> 8 & -INVALID_BYTE + c - 43 + 62;
          result += (46 - c & c - 48) >>> 8 & -INVALID_BYTE + c - 47 + 63;
          result += (47 - c & c - 58) >>> 8 & -INVALID_BYTE + c - 48 + 52;
          result += (64 - c & c - 91) >>> 8 & -INVALID_BYTE + c - 65 + 0;
          result += (96 - c & c - 123) >>> 8 & -INVALID_BYTE + c - 97 + 26;
          return result;
        };
        Coder2.prototype._getPaddingLength = function(s) {
          var paddingLength = 0;
          if (this._paddingCharacter) {
            for (var i = s.length - 1; i >= 0; i--) {
              if (s[i] !== this._paddingCharacter) {
                break;
              }
              paddingLength++;
            }
            if (s.length < 4 || paddingLength > 2) {
              throw new Error("Base64Coder: incorrect padding");
            }
          }
          return paddingLength;
        };
        return Coder2;
      })()
    );
    exports.Coder = Coder;
    var stdCoder = new Coder();
    function encode2(data) {
      return stdCoder.encode(data);
    }
    exports.encode = encode2;
    function decode(s) {
      return stdCoder.decode(s);
    }
    exports.decode = decode;
    var URLSafeCoder = (
      /** @class */
      (function(_super) {
        __extends(URLSafeCoder2, _super);
        function URLSafeCoder2() {
          return _super !== null && _super.apply(this, arguments) || this;
        }
        URLSafeCoder2.prototype._encodeByte = function(b) {
          var result = b;
          result += 65;
          result += 25 - b >>> 8 & 0 - 65 - 26 + 97;
          result += 51 - b >>> 8 & 26 - 97 - 52 + 48;
          result += 61 - b >>> 8 & 52 - 48 - 62 + 45;
          result += 62 - b >>> 8 & 62 - 45 - 63 + 95;
          return String.fromCharCode(result);
        };
        URLSafeCoder2.prototype._decodeChar = function(c) {
          var result = INVALID_BYTE;
          result += (44 - c & c - 46) >>> 8 & -INVALID_BYTE + c - 45 + 62;
          result += (94 - c & c - 96) >>> 8 & -INVALID_BYTE + c - 95 + 63;
          result += (47 - c & c - 58) >>> 8 & -INVALID_BYTE + c - 48 + 52;
          result += (64 - c & c - 91) >>> 8 & -INVALID_BYTE + c - 65 + 0;
          result += (96 - c & c - 123) >>> 8 & -INVALID_BYTE + c - 97 + 26;
          return result;
        };
        return URLSafeCoder2;
      })(Coder)
    );
    exports.URLSafeCoder = URLSafeCoder;
    var urlSafeCoder = new URLSafeCoder();
    function encodeURLSafe(data) {
      return urlSafeCoder.encode(data);
    }
    exports.encodeURLSafe = encodeURLSafe;
    function decodeURLSafe(s) {
      return urlSafeCoder.decode(s);
    }
    exports.decodeURLSafe = decodeURLSafe;
    exports.encodedLength = function(length) {
      return stdCoder.encodedLength(length);
    };
    exports.maxDecodedLength = function(length) {
      return stdCoder.maxDecodedLength(length);
    };
    exports.decodedLength = function(s) {
      return stdCoder.decodedLength(s);
    };
  }
});

// node_modules/fast-sha256/sha256.js
var require_sha256 = __commonJS({
  "node_modules/fast-sha256/sha256.js"(exports, module) {
    (function(root, factory) {
      var exports2 = {};
      factory(exports2);
      var sha256 = exports2["default"];
      for (var k in exports2) {
        sha256[k] = exports2[k];
      }
      if (typeof module === "object" && typeof module.exports === "object") {
        module.exports = sha256;
      } else if (typeof define === "function" && define.amd) {
        define(function() {
          return sha256;
        });
      } else {
        root.sha256 = sha256;
      }
    })(exports, function(exports2) {
      "use strict";
      exports2.__esModule = true;
      exports2.digestLength = 32;
      exports2.blockSize = 64;
      var K = new Uint32Array([
        1116352408,
        1899447441,
        3049323471,
        3921009573,
        961987163,
        1508970993,
        2453635748,
        2870763221,
        3624381080,
        310598401,
        607225278,
        1426881987,
        1925078388,
        2162078206,
        2614888103,
        3248222580,
        3835390401,
        4022224774,
        264347078,
        604807628,
        770255983,
        1249150122,
        1555081692,
        1996064986,
        2554220882,
        2821834349,
        2952996808,
        3210313671,
        3336571891,
        3584528711,
        113926993,
        338241895,
        666307205,
        773529912,
        1294757372,
        1396182291,
        1695183700,
        1986661051,
        2177026350,
        2456956037,
        2730485921,
        2820302411,
        3259730800,
        3345764771,
        3516065817,
        3600352804,
        4094571909,
        275423344,
        430227734,
        506948616,
        659060556,
        883997877,
        958139571,
        1322822218,
        1537002063,
        1747873779,
        1955562222,
        2024104815,
        2227730452,
        2361852424,
        2428436474,
        2756734187,
        3204031479,
        3329325298
      ]);
      function hashBlocks(w, v, p, pos, len) {
        var a, b, c, d, e, f, g, h, u, i, j, t1, t2;
        while (len >= 64) {
          a = v[0];
          b = v[1];
          c = v[2];
          d = v[3];
          e = v[4];
          f = v[5];
          g = v[6];
          h = v[7];
          for (i = 0; i < 16; i++) {
            j = pos + i * 4;
            w[i] = (p[j] & 255) << 24 | (p[j + 1] & 255) << 16 | (p[j + 2] & 255) << 8 | p[j + 3] & 255;
          }
          for (i = 16; i < 64; i++) {
            u = w[i - 2];
            t1 = (u >>> 17 | u << 32 - 17) ^ (u >>> 19 | u << 32 - 19) ^ u >>> 10;
            u = w[i - 15];
            t2 = (u >>> 7 | u << 32 - 7) ^ (u >>> 18 | u << 32 - 18) ^ u >>> 3;
            w[i] = (t1 + w[i - 7] | 0) + (t2 + w[i - 16] | 0);
          }
          for (i = 0; i < 64; i++) {
            t1 = (((e >>> 6 | e << 32 - 6) ^ (e >>> 11 | e << 32 - 11) ^ (e >>> 25 | e << 32 - 25)) + (e & f ^ ~e & g) | 0) + (h + (K[i] + w[i] | 0) | 0) | 0;
            t2 = ((a >>> 2 | a << 32 - 2) ^ (a >>> 13 | a << 32 - 13) ^ (a >>> 22 | a << 32 - 22)) + (a & b ^ a & c ^ b & c) | 0;
            h = g;
            g = f;
            f = e;
            e = d + t1 | 0;
            d = c;
            c = b;
            b = a;
            a = t1 + t2 | 0;
          }
          v[0] += a;
          v[1] += b;
          v[2] += c;
          v[3] += d;
          v[4] += e;
          v[5] += f;
          v[6] += g;
          v[7] += h;
          pos += 64;
          len -= 64;
        }
        return pos;
      }
      var Hash = (
        /** @class */
        (function() {
          function Hash2() {
            this.digestLength = exports2.digestLength;
            this.blockSize = exports2.blockSize;
            this.state = new Int32Array(8);
            this.temp = new Int32Array(64);
            this.buffer = new Uint8Array(128);
            this.bufferLength = 0;
            this.bytesHashed = 0;
            this.finished = false;
            this.reset();
          }
          Hash2.prototype.reset = function() {
            this.state[0] = 1779033703;
            this.state[1] = 3144134277;
            this.state[2] = 1013904242;
            this.state[3] = 2773480762;
            this.state[4] = 1359893119;
            this.state[5] = 2600822924;
            this.state[6] = 528734635;
            this.state[7] = 1541459225;
            this.bufferLength = 0;
            this.bytesHashed = 0;
            this.finished = false;
            return this;
          };
          Hash2.prototype.clean = function() {
            for (var i = 0; i < this.buffer.length; i++) {
              this.buffer[i] = 0;
            }
            for (var i = 0; i < this.temp.length; i++) {
              this.temp[i] = 0;
            }
            this.reset();
          };
          Hash2.prototype.update = function(data, dataLength) {
            if (dataLength === void 0) {
              dataLength = data.length;
            }
            if (this.finished) {
              throw new Error("SHA256: can't update because hash was finished.");
            }
            var dataPos = 0;
            this.bytesHashed += dataLength;
            if (this.bufferLength > 0) {
              while (this.bufferLength < 64 && dataLength > 0) {
                this.buffer[this.bufferLength++] = data[dataPos++];
                dataLength--;
              }
              if (this.bufferLength === 64) {
                hashBlocks(this.temp, this.state, this.buffer, 0, 64);
                this.bufferLength = 0;
              }
            }
            if (dataLength >= 64) {
              dataPos = hashBlocks(this.temp, this.state, data, dataPos, dataLength);
              dataLength %= 64;
            }
            while (dataLength > 0) {
              this.buffer[this.bufferLength++] = data[dataPos++];
              dataLength--;
            }
            return this;
          };
          Hash2.prototype.finish = function(out) {
            if (!this.finished) {
              var bytesHashed = this.bytesHashed;
              var left = this.bufferLength;
              var bitLenHi = bytesHashed / 536870912 | 0;
              var bitLenLo = bytesHashed << 3;
              var padLength = bytesHashed % 64 < 56 ? 64 : 128;
              this.buffer[left] = 128;
              for (var i = left + 1; i < padLength - 8; i++) {
                this.buffer[i] = 0;
              }
              this.buffer[padLength - 8] = bitLenHi >>> 24 & 255;
              this.buffer[padLength - 7] = bitLenHi >>> 16 & 255;
              this.buffer[padLength - 6] = bitLenHi >>> 8 & 255;
              this.buffer[padLength - 5] = bitLenHi >>> 0 & 255;
              this.buffer[padLength - 4] = bitLenLo >>> 24 & 255;
              this.buffer[padLength - 3] = bitLenLo >>> 16 & 255;
              this.buffer[padLength - 2] = bitLenLo >>> 8 & 255;
              this.buffer[padLength - 1] = bitLenLo >>> 0 & 255;
              hashBlocks(this.temp, this.state, this.buffer, 0, padLength);
              this.finished = true;
            }
            for (var i = 0; i < 8; i++) {
              out[i * 4 + 0] = this.state[i] >>> 24 & 255;
              out[i * 4 + 1] = this.state[i] >>> 16 & 255;
              out[i * 4 + 2] = this.state[i] >>> 8 & 255;
              out[i * 4 + 3] = this.state[i] >>> 0 & 255;
            }
            return this;
          };
          Hash2.prototype.digest = function() {
            var out = new Uint8Array(this.digestLength);
            this.finish(out);
            return out;
          };
          Hash2.prototype._saveState = function(out) {
            for (var i = 0; i < this.state.length; i++) {
              out[i] = this.state[i];
            }
          };
          Hash2.prototype._restoreState = function(from, bytesHashed) {
            for (var i = 0; i < this.state.length; i++) {
              this.state[i] = from[i];
            }
            this.bytesHashed = bytesHashed;
            this.finished = false;
            this.bufferLength = 0;
          };
          return Hash2;
        })()
      );
      exports2.Hash = Hash;
      var HMAC = (
        /** @class */
        (function() {
          function HMAC2(key) {
            this.inner = new Hash();
            this.outer = new Hash();
            this.blockSize = this.inner.blockSize;
            this.digestLength = this.inner.digestLength;
            var pad = new Uint8Array(this.blockSize);
            if (key.length > this.blockSize) {
              new Hash().update(key).finish(pad).clean();
            } else {
              for (var i = 0; i < key.length; i++) {
                pad[i] = key[i];
              }
            }
            for (var i = 0; i < pad.length; i++) {
              pad[i] ^= 54;
            }
            this.inner.update(pad);
            for (var i = 0; i < pad.length; i++) {
              pad[i] ^= 54 ^ 92;
            }
            this.outer.update(pad);
            this.istate = new Uint32Array(8);
            this.ostate = new Uint32Array(8);
            this.inner._saveState(this.istate);
            this.outer._saveState(this.ostate);
            for (var i = 0; i < pad.length; i++) {
              pad[i] = 0;
            }
          }
          HMAC2.prototype.reset = function() {
            this.inner._restoreState(this.istate, this.inner.blockSize);
            this.outer._restoreState(this.ostate, this.outer.blockSize);
            return this;
          };
          HMAC2.prototype.clean = function() {
            for (var i = 0; i < this.istate.length; i++) {
              this.ostate[i] = this.istate[i] = 0;
            }
            this.inner.clean();
            this.outer.clean();
          };
          HMAC2.prototype.update = function(data) {
            this.inner.update(data);
            return this;
          };
          HMAC2.prototype.finish = function(out) {
            if (this.outer.finished) {
              this.outer.finish(out);
            } else {
              this.inner.finish(out);
              this.outer.update(out, this.digestLength).finish(out);
            }
            return this;
          };
          HMAC2.prototype.digest = function() {
            var out = new Uint8Array(this.digestLength);
            this.finish(out);
            return out;
          };
          return HMAC2;
        })()
      );
      exports2.HMAC = HMAC;
      function hash(data) {
        var h = new Hash().update(data);
        var digest = h.digest();
        h.clean();
        return digest;
      }
      exports2.hash = hash;
      exports2["default"] = hash;
      function hmac(key, data) {
        var h = new HMAC(key).update(data);
        var digest = h.digest();
        h.clean();
        return digest;
      }
      exports2.hmac = hmac;
      function fillBuffer(buffer, hmac2, info2, counter) {
        var num = counter[0];
        if (num === 0) {
          throw new Error("hkdf: cannot expand more");
        }
        hmac2.reset();
        if (num > 1) {
          hmac2.update(buffer);
        }
        if (info2) {
          hmac2.update(info2);
        }
        hmac2.update(counter);
        hmac2.finish(buffer);
        counter[0]++;
      }
      var hkdfSalt = new Uint8Array(exports2.digestLength);
      function hkdf(key, salt, info2, length) {
        if (salt === void 0) {
          salt = hkdfSalt;
        }
        if (length === void 0) {
          length = 32;
        }
        var counter = new Uint8Array([1]);
        var okm = hmac(salt, key);
        var hmac_ = new HMAC(okm);
        var buffer = new Uint8Array(hmac_.digestLength);
        var bufpos = buffer.length;
        var out = new Uint8Array(length);
        for (var i = 0; i < length; i++) {
          if (bufpos === buffer.length) {
            fillBuffer(buffer, hmac_, info2, counter);
            bufpos = 0;
          }
          out[i] = buffer[bufpos++];
        }
        hmac_.clean();
        buffer.fill(0);
        counter.fill(0);
        return out;
      }
      exports2.hkdf = hkdf;
      function pbkdf2(password, salt, iterations, dkLen) {
        var prf = new HMAC(password);
        var len = prf.digestLength;
        var ctr = new Uint8Array(4);
        var t = new Uint8Array(len);
        var u = new Uint8Array(len);
        var dk = new Uint8Array(dkLen);
        for (var i = 0; i * len < dkLen; i++) {
          var c = i + 1;
          ctr[0] = c >>> 24 & 255;
          ctr[1] = c >>> 16 & 255;
          ctr[2] = c >>> 8 & 255;
          ctr[3] = c >>> 0 & 255;
          prf.reset();
          prf.update(salt);
          prf.update(ctr);
          prf.finish(u);
          for (var j = 0; j < len; j++) {
            t[j] = u[j];
          }
          for (var j = 2; j <= iterations; j++) {
            prf.reset();
            prf.update(u).finish(u);
            for (var k = 0; k < len; k++) {
              t[k] ^= u[k];
            }
          }
          for (var j = 0; j < len && i * len + j < dkLen; j++) {
            dk[i * len + j] = t[j];
          }
        }
        for (var i = 0; i < len; i++) {
          t[i] = u[i] = 0;
        }
        for (var i = 0; i < 4; i++) {
          ctr[i] = 0;
        }
        prf.clean();
        return dk;
      }
      exports2.pbkdf2 = pbkdf2;
    });
  }
});

// node_modules/standardwebhooks/dist/timing_safe_equal.js
var require_timing_safe_equal = __commonJS({
  "node_modules/standardwebhooks/dist/timing_safe_equal.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.timingSafeEqual = timingSafeEqual;
    function assert(expr, msg = "") {
      if (!expr) {
        throw new Error(msg);
      }
    }
    function timingSafeEqual(a, b) {
      if (a.byteLength !== b.byteLength) {
        return false;
      }
      if (!(a instanceof DataView)) {
        a = new DataView(ArrayBuffer.isView(a) ? a.buffer : a);
      }
      if (!(b instanceof DataView)) {
        b = new DataView(ArrayBuffer.isView(b) ? b.buffer : b);
      }
      assert(a instanceof DataView);
      assert(b instanceof DataView);
      const length = a.byteLength;
      let out = 0;
      let i = -1;
      while (++i < length) {
        out |= a.getUint8(i) ^ b.getUint8(i);
      }
      return out === 0;
    }
  }
});

// node_modules/standardwebhooks/dist/index.js
var require_dist = __commonJS({
  "node_modules/standardwebhooks/dist/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Webhook = exports.WebhookVerificationError = void 0;
    var base64 = require_base64();
    var sha256 = require_sha256();
    var timing_safe_equal_1 = require_timing_safe_equal();
    var WEBHOOK_TOLERANCE_IN_SECONDS = 5 * 60;
    var ExtendableError = class _ExtendableError extends Error {
      constructor(message) {
        super(message);
        Object.setPrototypeOf(this, _ExtendableError.prototype);
        this.name = "ExtendableError";
        this.stack = new Error(message).stack;
      }
    };
    var WebhookVerificationError = class _WebhookVerificationError extends ExtendableError {
      constructor(message) {
        super(message);
        Object.setPrototypeOf(this, _WebhookVerificationError.prototype);
        this.name = "WebhookVerificationError";
      }
    };
    exports.WebhookVerificationError = WebhookVerificationError;
    var Webhook2 = class _Webhook {
      constructor(secret, options) {
        if ((options === null || options === void 0 ? void 0 : options.format) === "raw") {
          if (secret instanceof Uint8Array) {
            this.key = secret;
          } else {
            this.key = Uint8Array.from(secret, (c) => c.charCodeAt(0));
          }
        } else {
          if (typeof secret !== "string") {
            throw new Error("Expected secret to be of type string");
          }
          if (secret.startsWith(_Webhook.prefix)) {
            secret = secret.substring(_Webhook.prefix.length);
          }
          this.key = base64.decode(secret);
        }
        if (this.key.length === 0) {
          throw new Error("Secret can't be empty.");
        }
      }
      verify(payload, headers, options) {
        var _a2;
        const jsonParse = (_a2 = options === null || options === void 0 ? void 0 : options.jsonParse) !== null && _a2 !== void 0 ? _a2 : true;
        const normalizedHeaders = {};
        for (const key of Object.keys(headers)) {
          normalizedHeaders[key.toLowerCase()] = headers[key];
        }
        const msgId = normalizedHeaders["webhook-id"];
        const msgSignature = normalizedHeaders["webhook-signature"];
        const msgTimestamp = normalizedHeaders["webhook-timestamp"];
        if (!msgSignature || !msgId || !msgTimestamp) {
          throw new WebhookVerificationError("Missing required headers");
        }
        const timestamp = this.verifyTimestamp(msgTimestamp);
        const computedSignature = this.sign(msgId, timestamp, payload);
        const expectedSignature = computedSignature.split(",")[1];
        const passedSignatures = msgSignature.split(" ");
        const encoder = new globalThis.TextEncoder();
        for (const versionedSignature of passedSignatures) {
          const [version, signature] = versionedSignature.split(",");
          if (version !== "v1") {
            continue;
          }
          if ((0, timing_safe_equal_1.timingSafeEqual)(encoder.encode(signature), encoder.encode(expectedSignature))) {
            const payloadString = payload.toString();
            if (payloadString === "") {
              return void 0;
            }
            if (jsonParse) {
              return JSON.parse(payloadString);
            } else {
              return void 0;
            }
          }
        }
        throw new WebhookVerificationError("No matching signature found");
      }
      sign(msgId, timestamp, payload) {
        if (typeof payload === "string") {
        } else if (payload.constructor.name === "Buffer") {
          payload = payload.toString();
        } else {
          throw new Error("Expected payload to be of type string or Buffer.");
        }
        const encoder = new TextEncoder();
        const timestampNumber = Math.floor(timestamp.getTime() / 1e3);
        const toSign = encoder.encode(`${msgId}.${timestampNumber}.${payload}`);
        const expectedSignature = base64.encode(sha256.hmac(this.key, toSign));
        return `v1,${expectedSignature}`;
      }
      verifyTimestamp(timestampHeader) {
        const now = Math.floor(Date.now() / 1e3);
        const timestamp = parseInt(timestampHeader, 10);
        if (Number.isNaN(timestamp)) {
          throw new WebhookVerificationError("Invalid Signature Headers");
        }
        if (now - timestamp > WEBHOOK_TOLERANCE_IN_SECONDS) {
          throw new WebhookVerificationError("Message timestamp too old");
        }
        if (timestamp > now + WEBHOOK_TOLERANCE_IN_SECONDS) {
          throw new WebhookVerificationError("Message timestamp too new");
        }
        return new Date(timestamp * 1e3);
      }
    };
    exports.Webhook = Webhook2;
    Webhook2.prefix = "whsec_";
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/webhooks.mjs
var import_standardwebhooks, Webhooks;
var init_webhooks = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/webhooks.mjs"() {
    init_resource();
    import_standardwebhooks = __toESM(require_dist(), 1);
    Webhooks = class extends APIResource {
      /**
       * Parses a webhook payload into an event without verifying its signature. Prefer
       * `unwrap()` unless you have already verified the signature yourself.
       */
      parseUnverified(body) {
        return JSON.parse(body);
      }
      /**
       * Verifies the webhook signature from the `webhook-id`, `webhook-timestamp` and
       * `webhook-signature` headers using your webhook signing key, then parses the
       * payload into an event. Fails if the signature is missing or invalid.
       */
      unwrap(body, options) {
        const headers = options?.headers;
        if (headers == null)
          throw new Error("Webhook headers are required in order to verify the signature");
        const keyStr = options.key === void 0 ? this._client.webhookKey : options.key;
        if (!keyStr)
          throw new Error("Webhook key must not be null or empty in order to unwrap");
        const wh = new import_standardwebhooks.Webhook(keyStr);
        wh.verify(body, headers);
        return JSON.parse(body);
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/agents/versions.mjs
var Versions;
var init_versions = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/agents/versions.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_path();
    Versions = class extends APIResource {
      /**
       * List Agent Versions
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaManagedAgentsAgent of client.beta.agents.versions.list(
       *   'agent_011CZkYpogX7uDKUyvBTophP',
       * )) {
       *   // ...
       * }
       * ```
       */
      list(agentID, params = {}, options) {
        const { betas, workspace_id, ...query } = params ?? {};
        return this._client.getAPIList(path3`/v1/agents/${agentID}/versions?beta=true`, PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/agents/agents.mjs
var Agents;
var init_agents = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/agents/agents.mjs"() {
    init_resource();
    init_versions();
    init_versions();
    init_pagination();
    init_headers();
    init_path();
    Agents = /* @__PURE__ */ (() => {
      class Agents2 extends APIResource {
        constructor() {
          super(...arguments);
          this.versions = new Versions(this._client);
        }
        /**
         * Create Agent
         *
         * @example
         * ```ts
         * const betaManagedAgentsAgent =
         *   await client.beta.agents.create({
         *     model: 'claude-opus-5',
         *     name: 'My First Agent',
         *   });
         * ```
         */
        create(params, options) {
          const { betas, workspace_id, ...body } = params;
          return this._client.post("/v1/agents?beta=true", {
            body,
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * Get Agent
         *
         * @example
         * ```ts
         * const betaManagedAgentsAgent =
         *   await client.beta.agents.retrieve(
         *     'agent_011CZkYpogX7uDKUyvBTophP',
         *   );
         * ```
         */
        retrieve(agentID, params = {}, options) {
          const { betas, workspace_id, ...query } = params ?? {};
          return this._client.get(path3`/v1/agents/${agentID}?beta=true`, {
            query,
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * Update Agent
         *
         * @example
         * ```ts
         * const betaManagedAgentsAgent =
         *   await client.beta.agents.update(
         *     'agent_011CZkYpogX7uDKUyvBTophP',
         *     { description: 'updated' },
         *   );
         * ```
         */
        update(agentID, params, options) {
          const { betas, workspace_id, ...body } = params;
          return this._client.post(path3`/v1/agents/${agentID}?beta=true`, {
            body,
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * List Agents
         *
         * @example
         * ```ts
         * // Automatically fetches more pages as needed.
         * for await (const betaManagedAgentsAgent of client.beta.agents.list()) {
         *   // ...
         * }
         * ```
         */
        list(params = {}, options) {
          const { betas, workspace_id, ...query } = params ?? {};
          return this._client.getAPIList("/v1/agents?beta=true", PageCursor, {
            query,
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * Archive Agent
         *
         * @example
         * ```ts
         * const betaManagedAgentsAgent =
         *   await client.beta.agents.archive(
         *     'agent_011CZkYpogX7uDKUyvBTophP',
         *   );
         * ```
         */
        archive(agentID, params = {}, options) {
          const { betas, workspace_id } = params ?? {};
          return this._client.post(path3`/v1/agents/${agentID}/archive?beta=true`, {
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
      }
      Agents2.Versions = Versions;
      return Agents2;
    })();
  }
});

// node_modules/@anthropic-ai/sdk/internal/utils/abort.mjs
function linkAbort(external, controller) {
  if (!external)
    return () => {
    };
  if (external.aborted) {
    controller.abort();
    return () => {
    };
  }
  const onAbort = () => controller.abort();
  external.addEventListener("abort", onAbort);
  return () => external.removeEventListener("abort", onAbort);
}
var init_abort = __esm({
  "node_modules/@anthropic-ai/sdk/internal/utils/abort.mjs"() {
  }
});

// node_modules/@anthropic-ai/sdk/internal/utils/backoff.mjs
function isStatus(e, code) {
  return e instanceof APIError && e.status === code;
}
function is4xx(e) {
  return e instanceof APIError && typeof e.status === "number" && e.status >= 400 && e.status < 500;
}
function isFatal4xx(e) {
  return is4xx(e) && !isStatus(e, 408) && !isStatus(e, 409) && !isStatus(e, 429);
}
function backoff(attempt, baseMs, capMs) {
  return Math.min(baseMs * 2 ** attempt, capMs);
}
function jitter(lowMs, highMs) {
  return lowMs + Math.random() * (highMs - lowMs);
}
function applyJitter(ms) {
  return ms * (1 - Math.random() * 0.25);
}
var init_backoff = __esm({
  "node_modules/@anthropic-ai/sdk/internal/utils/backoff.mjs"() {
    init_error();
  }
});

// node_modules/@anthropic-ai/sdk/lib/helper-client.mjs
function copyClientForHelper(client2, { authToken, helper }) {
  if (!authToken) {
    throw new AnthropicError(`copyClientForHelper: expected a non-empty authToken but received ${JSON.stringify(authToken)}`);
  }
  const internal = client2;
  const parentDefaults = internal._options.defaultHeaders;
  const parentAuthExtraHeaders = internal._authState?.extraHeaders;
  const inheritedAuthExtraHeaders = parentAuthExtraHeaders ? Object.fromEntries(Object.entries(parentAuthExtraHeaders).filter(([name]) => {
    const lower = name.toLowerCase();
    return lower !== "authorization" && lower !== "x-api-key";
  })) : void 0;
  const defaultHeaders = buildHeaders([
    inheritedAuthExtraHeaders,
    parentDefaults,
    { [STAINLESS_HELPER_HEADER]: helper }
  ]);
  return client2.withOptions({
    apiKey: null,
    authToken,
    baseURL: client2.baseURL,
    credentials: void 0,
    defaultHeaders
  });
}
var init_helper_client = __esm({
  "node_modules/@anthropic-ai/sdk/lib/helper-client.mjs"() {
    init_error();
    init_headers();
    init_stainless_helper_header();
  }
});

// node_modules/@anthropic-ai/sdk/lib/environments/poller.mjs
function backoff2(attempt) {
  return backoff(attempt, POLL_BACKOFF_BASE_MS, POLL_BACKOFF_CAP_MS);
}
function defaultWorkerId() {
  const env = globalThis.process?.env;
  const host = env?.["HOSTNAME"];
  return host ? `${host}-${uuid4()}` : uuid4();
}
var _WorkPoller_runnerClient, _WorkPoller_consumed, _WorkPoller_controller, _WorkPoller_detachExternal, _WorkPoller_autoStop, _WorkPoller_drain, _WorkPoller_blockMs, _WorkPoller_reclaimOlderThanMs, _WorkPoller_requestOpts, _IdleLog_log, _IdleLog_environmentId, _IdleLog_idleSince, _IdleLog_lastReport, POLL_BLOCK_MS, POLL_BACKOFF_BASE_MS, POLL_BACKOFF_CAP_MS, IDLE_REPORT_INTERVAL_MS, WorkPoller, IdleLog;
var init_poller = __esm({
  "node_modules/@anthropic-ai/sdk/lib/environments/poller.mjs"() {
    init_tslib();
    init_error();
    init_log();
    init_sleep();
    init_uuid();
    init_abort();
    init_headers();
    init_backoff();
    init_helper_client();
    POLL_BLOCK_MS = 999;
    POLL_BACKOFF_BASE_MS = 1e3;
    POLL_BACKOFF_CAP_MS = 6e4;
    IDLE_REPORT_INTERVAL_MS = 3e5;
    WorkPoller = /* @__PURE__ */ (() => {
      class WorkPoller2 {
        constructor(opts) {
          _WorkPoller_runnerClient.set(this, void 0);
          _WorkPoller_consumed.set(this, false);
          _WorkPoller_controller.set(this, void 0);
          _WorkPoller_detachExternal.set(this, void 0);
          _WorkPoller_autoStop.set(this, void 0);
          _WorkPoller_drain.set(this, void 0);
          _WorkPoller_blockMs.set(this, void 0);
          _WorkPoller_reclaimOlderThanMs.set(this, void 0);
          _WorkPoller_requestOpts.set(this, void 0);
          this.client = opts.client;
          this.environmentId = opts.environmentId;
          this.environmentKey = opts.environmentKey;
          this.workerId = opts.workerId ?? defaultWorkerId();
          __classPrivateFieldSet(this, _WorkPoller_runnerClient, copyClientForHelper(opts.client, {
            authToken: opts.environmentKey,
            helper: "environments-work-poller"
          }), "f");
          __classPrivateFieldSet(this, _WorkPoller_autoStop, opts.autoStop ?? true, "f");
          __classPrivateFieldSet(this, _WorkPoller_drain, opts.drain ?? false, "f");
          __classPrivateFieldSet(this, _WorkPoller_blockMs, opts.blockMs === void 0 ? POLL_BLOCK_MS : opts.blockMs, "f");
          __classPrivateFieldSet(this, _WorkPoller_reclaimOlderThanMs, opts.reclaimOlderThanMs ?? null, "f");
          __classPrivateFieldSet(this, _WorkPoller_requestOpts, opts.requestOptions, "f");
          __classPrivateFieldSet(this, _WorkPoller_controller, new AbortController(), "f");
          __classPrivateFieldSet(this, _WorkPoller_detachExternal, linkAbort(opts.signal, __classPrivateFieldGet(this, _WorkPoller_controller, "f")), "f");
        }
        /** Read-only view of this iterator's abort signal. */
        get signal() {
          return __classPrivateFieldGet(this, _WorkPoller_controller, "f").signal;
        }
        /** Abort the iterator. The current `for await` will exit cleanly. */
        abort() {
          __classPrivateFieldGet(this, _WorkPoller_controller, "f").abort();
        }
        async *[(_WorkPoller_runnerClient = /* @__PURE__ */ new WeakMap(), _WorkPoller_consumed = /* @__PURE__ */ new WeakMap(), _WorkPoller_controller = /* @__PURE__ */ new WeakMap(), _WorkPoller_detachExternal = /* @__PURE__ */ new WeakMap(), _WorkPoller_autoStop = /* @__PURE__ */ new WeakMap(), _WorkPoller_drain = /* @__PURE__ */ new WeakMap(), _WorkPoller_blockMs = /* @__PURE__ */ new WeakMap(), _WorkPoller_reclaimOlderThanMs = /* @__PURE__ */ new WeakMap(), _WorkPoller_requestOpts = /* @__PURE__ */ new WeakMap(), Symbol.asyncIterator)]() {
          if (__classPrivateFieldGet(this, _WorkPoller_consumed, "f")) {
            throw new AnthropicError("Cannot iterate over a consumed WorkPoller");
          }
          __classPrivateFieldSet(this, _WorkPoller_consumed, true, "f");
          const log = loggerFor(this.client);
          log.info("poller starting", {
            component: "work-poller",
            environment_id: this.environmentId
          });
          const idle = new IdleLog(log, this.environmentId);
          try {
            let attempt = 0;
            while (!__classPrivateFieldGet(this, _WorkPoller_controller, "f").signal.aborted) {
              let work;
              try {
                work = await __classPrivateFieldGet(this, _WorkPoller_runnerClient, "f").beta.environments.work.poll(this.environmentId, {
                  "Anthropic-Worker-ID": this.workerId,
                  ...__classPrivateFieldGet(this, _WorkPoller_blockMs, "f") !== null ? { block_ms: __classPrivateFieldGet(this, _WorkPoller_blockMs, "f") } : {},
                  ...__classPrivateFieldGet(this, _WorkPoller_reclaimOlderThanMs, "f") !== null ? { reclaim_older_than_ms: __classPrivateFieldGet(this, _WorkPoller_reclaimOlderThanMs, "f") } : {}
                }, { headers: buildHeaders([__classPrivateFieldGet(this, _WorkPoller_requestOpts, "f")?.headers]), signal: __classPrivateFieldGet(this, _WorkPoller_controller, "f").signal });
              } catch (e) {
                if (__classPrivateFieldGet(this, _WorkPoller_controller, "f").signal.aborted)
                  return;
                if (isFatal4xx(e)) {
                  log.error("poll failed permanently, stopping poller", { error: String(e) });
                  throw e;
                }
                const wait = applyJitter(backoff2(attempt));
                log.warn("poll failed, backing off", { error: String(e), backoff_ms: wait });
                attempt++;
                await sleep(wait, __classPrivateFieldGet(this, _WorkPoller_controller, "f").signal);
                continue;
              }
              attempt = 0;
              if (work == null) {
                if (__classPrivateFieldGet(this, _WorkPoller_drain, "f"))
                  return;
                idle.onEmptyPoll();
                await sleep(jitter(1e3, 3e3), __classPrivateFieldGet(this, _WorkPoller_controller, "f").signal);
                continue;
              }
              idle.onClaim();
              log.info("claimed work", {
                component: "work-poller",
                environment_id: this.environmentId,
                work_id: work.id,
                work_type: work.data.type
              });
              try {
                await __classPrivateFieldGet(this, _WorkPoller_runnerClient, "f").beta.environments.work.ack(work.id, { environment_id: work.environment_id }, { headers: buildHeaders([__classPrivateFieldGet(this, _WorkPoller_requestOpts, "f")?.headers]), signal: __classPrivateFieldGet(this, _WorkPoller_controller, "f").signal });
              } catch (e) {
                log.error("ack failed", { work_id: work.id, error: String(e) });
                continue;
              }
              try {
                yield work;
              } finally {
                if (__classPrivateFieldGet(this, _WorkPoller_autoStop, "f")) {
                  try {
                    await __classPrivateFieldGet(this, _WorkPoller_runnerClient, "f").beta.environments.work.stop(work.id, { environment_id: work.environment_id }, { headers: buildHeaders([__classPrivateFieldGet(this, _WorkPoller_requestOpts, "f")?.headers]) });
                  } catch (e) {
                    if (!isStatus(e, 409))
                      log.warn("stop failed", { work_id: work.id, error: String(e) });
                  }
                }
              }
            }
          } finally {
            __classPrivateFieldGet(this, _WorkPoller_detachExternal, "f").call(this);
          }
        }
      }
      return WorkPoller2;
    })();
    IdleLog = /* @__PURE__ */ (() => {
      class IdleLog2 {
        constructor(log, environmentId) {
          _IdleLog_log.set(this, void 0);
          _IdleLog_environmentId.set(this, void 0);
          _IdleLog_idleSince.set(this, void 0);
          _IdleLog_lastReport.set(this, 0);
          __classPrivateFieldSet(this, _IdleLog_log, log, "f");
          __classPrivateFieldSet(this, _IdleLog_environmentId, environmentId, "f");
        }
        onEmptyPoll() {
          const now = Date.now();
          const fields = { component: "work-poller", environment_id: __classPrivateFieldGet(this, _IdleLog_environmentId, "f") };
          if (__classPrivateFieldGet(this, _IdleLog_idleSince, "f") === void 0) {
            __classPrivateFieldSet(this, _IdleLog_idleSince, __classPrivateFieldSet(this, _IdleLog_lastReport, now, "f"), "f");
            __classPrivateFieldGet(this, _IdleLog_log, "f").info("idle; polling for work", fields);
          } else if (now - __classPrivateFieldGet(this, _IdleLog_lastReport, "f") >= IDLE_REPORT_INTERVAL_MS) {
            __classPrivateFieldSet(this, _IdleLog_lastReport, now, "f");
            __classPrivateFieldGet(this, _IdleLog_log, "f").info(`still polling; idle for ${Math.round((now - __classPrivateFieldGet(this, _IdleLog_idleSince, "f")) / 1e3)}s`, fields);
          } else {
            __classPrivateFieldGet(this, _IdleLog_log, "f").debug("poll returned no work", fields);
          }
        }
        onClaim() {
          __classPrivateFieldSet(this, _IdleLog_idleSince, void 0, "f");
        }
      }
      _IdleLog_log = /* @__PURE__ */ new WeakMap(), _IdleLog_environmentId = /* @__PURE__ */ new WeakMap(), _IdleLog_idleSince = /* @__PURE__ */ new WeakMap(), _IdleLog_lastReport = /* @__PURE__ */ new WeakMap();
      return IdleLog2;
    })();
  }
});

// node_modules/@anthropic-ai/sdk/internal/utils/async-queue.mjs
var _AsyncQueue_items, _AsyncQueue_waiters, _AsyncQueue_closed, AsyncQueue;
var init_async_queue = __esm({
  "node_modules/@anthropic-ai/sdk/internal/utils/async-queue.mjs"() {
    init_tslib();
    AsyncQueue = /* @__PURE__ */ (() => {
      class AsyncQueue2 {
        constructor() {
          _AsyncQueue_items.set(this, []);
          _AsyncQueue_waiters.set(this, []);
          _AsyncQueue_closed.set(this, false);
        }
        /** Enqueue an item, or hand it directly to a waiting reader. Returns `false` once closed. */
        push(item) {
          if (__classPrivateFieldGet(this, _AsyncQueue_closed, "f"))
            return false;
          const w = __classPrivateFieldGet(this, _AsyncQueue_waiters, "f").shift();
          if (w)
            w({ done: false, value: item });
          else
            __classPrivateFieldGet(this, _AsyncQueue_items, "f").push(item);
          return true;
        }
        /** Mark the queue done. Idempotent; wakes every pending reader with `done: true`. */
        close() {
          if (__classPrivateFieldGet(this, _AsyncQueue_closed, "f"))
            return;
          __classPrivateFieldSet(this, _AsyncQueue_closed, true, "f");
          while (__classPrivateFieldGet(this, _AsyncQueue_waiters, "f").length > 0) {
            const w = __classPrivateFieldGet(this, _AsyncQueue_waiters, "f").shift();
            w({ done: true, value: void 0 });
          }
        }
        /**
         * Resolve with the next item, or `done: true` once the queue is closed and
         * drained. When `signal` is supplied, aborting it resolves a pending read
         * with `done: true` (cancellation is pushed down here rather than handled by
         * an outer `Promise.race`).
         */
        next(signal) {
          if (__classPrivateFieldGet(this, _AsyncQueue_items, "f").length > 0) {
            return Promise.resolve({ done: false, value: __classPrivateFieldGet(this, _AsyncQueue_items, "f").shift() });
          }
          if (__classPrivateFieldGet(this, _AsyncQueue_closed, "f") || signal?.aborted) {
            return Promise.resolve({ done: true, value: void 0 });
          }
          return new Promise((resolve2) => {
            const waiter = (r) => {
              signal?.removeEventListener("abort", onAbort);
              resolve2(r);
            };
            const onAbort = () => {
              const idx = __classPrivateFieldGet(this, _AsyncQueue_waiters, "f").indexOf(waiter);
              if (idx >= 0)
                __classPrivateFieldGet(this, _AsyncQueue_waiters, "f").splice(idx, 1);
              resolve2({ done: true, value: void 0 });
            };
            __classPrivateFieldGet(this, _AsyncQueue_waiters, "f").push(waiter);
            signal?.addEventListener("abort", onAbort, { once: true });
          });
        }
        /** Synchronously remove and return the next buffered item, or `undefined` if empty. */
        tryShift() {
          return __classPrivateFieldGet(this, _AsyncQueue_items, "f").shift();
        }
      }
      _AsyncQueue_items = /* @__PURE__ */ new WeakMap(), _AsyncQueue_waiters = /* @__PURE__ */ new WeakMap(), _AsyncQueue_closed = /* @__PURE__ */ new WeakMap();
      return AsyncQueue2;
    })();
  }
});

// node_modules/@anthropic-ai/sdk/lib/tools/ToolError.mjs
var ToolError;
var init_ToolError = __esm({
  "node_modules/@anthropic-ai/sdk/lib/tools/ToolError.mjs"() {
    ToolError = /* @__PURE__ */ (() => {
      class ToolError2 extends Error {
        constructor(content) {
          const message = typeof content === "string" ? content : content.map((block) => {
            if (block.type === "text")
              return block.text;
            return `[${block.type}]`;
          }).join(" ");
          super(message);
          this.name = "ToolError";
          this.content = content;
        }
      }
      return ToolError2;
    })();
  }
});

// node_modules/@anthropic-ai/sdk/lib/tools/BetaRunnableTool.mjs
function toolName(tool) {
  return "name" in tool ? tool.name : "mcp_server_name" in tool ? tool.mcp_server_name : tool.type;
}
function toolErrorContent(e) {
  return e instanceof ToolError ? e.content : `Error: ${e instanceof Error ? e.message : String(e)}`;
}
async function runRunnableTool(tool, rawInput, context) {
  try {
    const input = tool.parse ? tool.parse(rawInput) : rawInput;
    const content = await tool.run(input, context);
    return { content, isError: false };
  } catch (e) {
    return { content: toolErrorContent(e), isError: true };
  }
}
var init_BetaRunnableTool = __esm({
  "node_modules/@anthropic-ai/sdk/lib/tools/BetaRunnableTool.mjs"() {
    init_ToolError();
  }
});

// node_modules/@anthropic-ai/sdk/lib/tools/SessionToolRunner.mjs
function isEndTurnIdle(ev) {
  return ev.type === "session.status_idle" && ev.stop_reason?.type === "end_turn";
}
function buildResultEvent(ev, isError, content) {
  if (ev.type === "agent.custom_tool_use") {
    return { type: "user.custom_tool_result", custom_tool_use_id: ev.id, is_error: isError, content };
  }
  return { type: "user.tool_result", tool_use_id: ev.id, is_error: isError, content };
}
function toSessionContent(content) {
  if (typeof content === "string")
    return [{ type: "text", text: content || "(no output)" }];
  const out = content.map((b) => {
    if (b.type === "text")
      return { type: "text", text: b.text || "(no output)" };
    if (b.type === "image" || b.type === "document")
      return b;
    if (b.type === "search_result") {
      return {
        type: "search_result",
        source: b.source,
        title: b.title,
        content: b.content.map((c) => ({ type: "text", text: c.text })),
        citations: { enabled: b.citations?.enabled ?? false }
      };
    }
    return { type: "text", text: JSON.stringify(b) };
  });
  return out.length > 0 ? out : [{ type: "text", text: "(no output)" }];
}
var _IdleClock_maxIdleMs, _IdleClock_onExpire, _IdleClock_blockers, _IdleClock_armPending, _IdleClock_timer, _SessionToolRunner_instances, _SessionToolRunner_consumed, _SessionToolRunner_controller, _SessionToolRunner_detachExternal, _SessionToolRunner_requestOpts, _SessionToolRunner_toolByName, _SessionToolRunner_logger, _SessionToolRunner_seen, _SessionToolRunner_answered, _SessionToolRunner_confirmationVerdicts, _SessionToolRunner_awaitingConfirmation, _SessionToolRunner_results, _SessionToolRunner_inFlightCount, _SessionToolRunner_sendRetryWindowMs, _SessionToolRunner_onIdle, _SessionToolRunner_idleClock, _SessionToolRunner_requestOptions, _SessionToolRunner_streamLoop, _SessionToolRunner_reconcile, _SessionToolRunner_ingestHistory, _SessionToolRunner_handleStreamEvent, _SessionToolRunner_routeToolEvent, _SessionToolRunner_noteConfirmation, _SessionToolRunner_applyVerdict, _SessionToolRunner_surfaceCall, _SessionToolRunner_execute, _SessionToolRunner_sendResult, _SessionToolRunner_drain, STREAM_BACKOFF_START_MS, STREAM_BACKOFF_CAP_MS, TOOL_TIMEOUT_MS, DRAIN_TIMEOUT_MS, SEND_BACKOFF_START_MS, SEND_BACKOFF_CAP_MS, SEND_RETRY_WINDOW_MS, DEFAULT_MAX_IDLE_MS, IdleClock, SessionToolRunner;
var init_SessionToolRunner = __esm({
  "node_modules/@anthropic-ai/sdk/lib/tools/SessionToolRunner.mjs"() {
    init_tslib();
    init_error();
    init_log();
    init_sleep();
    init_backoff();
    init_abort();
    init_async_queue();
    init_headers();
    init_stainless_helper_header();
    init_BetaRunnableTool();
    STREAM_BACKOFF_START_MS = 500;
    STREAM_BACKOFF_CAP_MS = 1e4;
    TOOL_TIMEOUT_MS = 12e4;
    DRAIN_TIMEOUT_MS = 3e4;
    SEND_BACKOFF_START_MS = 1e3;
    SEND_BACKOFF_CAP_MS = 3e4;
    SEND_RETRY_WINDOW_MS = 5 * 6e4;
    DEFAULT_MAX_IDLE_MS = 6e4;
    IdleClock = /* @__PURE__ */ (() => {
      class IdleClock2 {
        constructor(maxIdleMs, onExpire) {
          _IdleClock_maxIdleMs.set(this, void 0);
          _IdleClock_onExpire.set(this, void 0);
          _IdleClock_blockers.set(this, /* @__PURE__ */ new Set());
          _IdleClock_armPending.set(this, false);
          _IdleClock_timer.set(this, void 0);
          __classPrivateFieldSet(this, _IdleClock_maxIdleMs, maxIdleMs, "f");
          __classPrivateFieldSet(this, _IdleClock_onExpire, onExpire, "f");
        }
        /**
         * Arm on `status_idle{end_turn}`; disarm otherwise. `user.tool_confirmation`
         * is neutral: it signals neither agent activity nor an idle, and its effect
         * on the clock flows through {@link block} / {@link unblock} instead —
         * disarming here would discard the pending arm the verdict is about to
         * settle.
         */
        noteEvent(ev) {
          if (ev.type === "user.tool_confirmation")
            return;
          if (isEndTurnIdle(ev))
            this.arm();
          else
            this.disarm();
        }
        /** Register gated work that must resolve before an idle countdown starts. */
        block(toolUseId) {
          __classPrivateFieldGet(this, _IdleClock_blockers, "f").add(toolUseId);
          if (__classPrivateFieldGet(this, _IdleClock_timer, "f") !== void 0) {
            __classPrivateFieldSet(this, _IdleClock_armPending, true, "f");
            clearTimeout(__classPrivateFieldGet(this, _IdleClock_timer, "f"));
            __classPrivateFieldSet(this, _IdleClock_timer, void 0, "f");
          }
        }
        /**
         * Retire gated work (a no-op for ids never blocked); applies a pending arm —
         * with a fresh full `maxIdleMs` window — once the last blocker retires.
         */
        unblock(toolUseId) {
          __classPrivateFieldGet(this, _IdleClock_blockers, "f").delete(toolUseId);
          if (__classPrivateFieldGet(this, _IdleClock_blockers, "f").size === 0 && __classPrivateFieldGet(this, _IdleClock_armPending, "f"))
            this.arm();
        }
        /**
         * (Re)start the idle countdown — or, while blockers are outstanding, hold
         * the arm pending instead. Stopping then would drop a held call when its
         * verdict later arrives, or cut the runner off before a released call's
         * result can drive the next turn.
         */
        arm() {
          if (__classPrivateFieldGet(this, _IdleClock_maxIdleMs, "f") <= 0)
            return;
          if (__classPrivateFieldGet(this, _IdleClock_blockers, "f").size > 0) {
            __classPrivateFieldSet(this, _IdleClock_armPending, true, "f");
            return;
          }
          __classPrivateFieldSet(this, _IdleClock_armPending, false, "f");
          if (__classPrivateFieldGet(this, _IdleClock_timer, "f") !== void 0)
            clearTimeout(__classPrivateFieldGet(this, _IdleClock_timer, "f"));
          __classPrivateFieldSet(this, _IdleClock_timer, setTimeout(__classPrivateFieldGet(this, _IdleClock_onExpire, "f"), __classPrivateFieldGet(this, _IdleClock_maxIdleMs, "f")), "f");
        }
        /**
         * Cancel the idle countdown and any pending arm. Blockers persist — they
         * track real outstanding work, retired only by {@link unblock}.
         */
        disarm() {
          __classPrivateFieldSet(this, _IdleClock_armPending, false, "f");
          if (__classPrivateFieldGet(this, _IdleClock_timer, "f") !== void 0) {
            clearTimeout(__classPrivateFieldGet(this, _IdleClock_timer, "f"));
            __classPrivateFieldSet(this, _IdleClock_timer, void 0, "f");
          }
        }
      }
      _IdleClock_maxIdleMs = /* @__PURE__ */ new WeakMap(), _IdleClock_onExpire = /* @__PURE__ */ new WeakMap(), _IdleClock_blockers = /* @__PURE__ */ new WeakMap(), _IdleClock_armPending = /* @__PURE__ */ new WeakMap(), _IdleClock_timer = /* @__PURE__ */ new WeakMap();
      return IdleClock2;
    })();
    SessionToolRunner = /* @__PURE__ */ (() => {
      class SessionToolRunner2 {
        constructor(sessionId, opts) {
          _SessionToolRunner_instances.add(this);
          _SessionToolRunner_consumed.set(this, false);
          _SessionToolRunner_controller.set(this, void 0);
          _SessionToolRunner_detachExternal.set(this, void 0);
          _SessionToolRunner_requestOpts.set(this, void 0);
          _SessionToolRunner_toolByName.set(this, void 0);
          _SessionToolRunner_logger.set(this, void 0);
          _SessionToolRunner_seen.set(this, /* @__PURE__ */ new Set());
          _SessionToolRunner_answered.set(this, /* @__PURE__ */ new Set());
          _SessionToolRunner_confirmationVerdicts.set(this, /* @__PURE__ */ new Map());
          _SessionToolRunner_awaitingConfirmation.set(this, /* @__PURE__ */ new Map());
          _SessionToolRunner_results.set(this, new AsyncQueue());
          _SessionToolRunner_inFlightCount.set(this, 0);
          _SessionToolRunner_sendRetryWindowMs.set(this, SEND_RETRY_WINDOW_MS);
          _SessionToolRunner_onIdle.set(this, null);
          _SessionToolRunner_idleClock.set(this, void 0);
          this.client = opts.client;
          this.sessionId = sessionId;
          this.tools = opts.tools;
          this.maxIdleMs = opts.maxIdleMs ?? DEFAULT_MAX_IDLE_MS;
          __classPrivateFieldSet(this, _SessionToolRunner_logger, loggerFor(opts.client), "f");
          __classPrivateFieldSet(this, _SessionToolRunner_toolByName, new Map(opts.tools.map((t) => [toolName(t), t])), "f");
          __classPrivateFieldSet(this, _SessionToolRunner_controller, new AbortController(), "f");
          __classPrivateFieldSet(this, _SessionToolRunner_detachExternal, linkAbort(opts.signal, __classPrivateFieldGet(this, _SessionToolRunner_controller, "f")), "f");
          __classPrivateFieldSet(this, _SessionToolRunner_requestOpts, opts.requestOptions, "f");
          __classPrivateFieldSet(this, _SessionToolRunner_idleClock, new IdleClock(this.maxIdleMs, () => {
            __classPrivateFieldGet(this, _SessionToolRunner_logger, "f").info("session idle after end_turn; stopping", {
              component: "session-tool-runner",
              session_id: this.sessionId,
              max_idle_ms: this.maxIdleMs
            });
            __classPrivateFieldGet(this, _SessionToolRunner_controller, "f").abort();
          }), "f");
        }
        /** Read-only view of this runner's abort signal. */
        get signal() {
          return __classPrivateFieldGet(this, _SessionToolRunner_controller, "f").signal;
        }
        /** Abort the runner. Background tasks will wind down and `for await` will exit cleanly. */
        abort() {
          __classPrivateFieldGet(this, _SessionToolRunner_controller, "f").abort();
        }
        /**
         * @internal
         * `EnvironmentWorker` keeps this equal to the lease TTL each heartbeat
         * reports; applies to a send already retrying.
         */
        _setSendRetryWindow(ms) {
          __classPrivateFieldSet(this, _SessionToolRunner_sendRetryWindowMs, ms, "f");
        }
        async *[(_SessionToolRunner_consumed = /* @__PURE__ */ new WeakMap(), _SessionToolRunner_controller = /* @__PURE__ */ new WeakMap(), _SessionToolRunner_detachExternal = /* @__PURE__ */ new WeakMap(), _SessionToolRunner_requestOpts = /* @__PURE__ */ new WeakMap(), _SessionToolRunner_toolByName = /* @__PURE__ */ new WeakMap(), _SessionToolRunner_logger = /* @__PURE__ */ new WeakMap(), _SessionToolRunner_seen = /* @__PURE__ */ new WeakMap(), _SessionToolRunner_answered = /* @__PURE__ */ new WeakMap(), _SessionToolRunner_confirmationVerdicts = /* @__PURE__ */ new WeakMap(), _SessionToolRunner_awaitingConfirmation = /* @__PURE__ */ new WeakMap(), _SessionToolRunner_results = /* @__PURE__ */ new WeakMap(), _SessionToolRunner_inFlightCount = /* @__PURE__ */ new WeakMap(), _SessionToolRunner_sendRetryWindowMs = /* @__PURE__ */ new WeakMap(), _SessionToolRunner_onIdle = /* @__PURE__ */ new WeakMap(), _SessionToolRunner_idleClock = /* @__PURE__ */ new WeakMap(), _SessionToolRunner_instances = /* @__PURE__ */ new WeakSet(), Symbol.asyncIterator)]() {
          if (__classPrivateFieldGet(this, _SessionToolRunner_consumed, "f")) {
            throw new AnthropicError("Cannot iterate over a consumed SessionToolRunner");
          }
          __classPrivateFieldSet(this, _SessionToolRunner_consumed, true, "f");
          __classPrivateFieldGet(this, _SessionToolRunner_logger, "f").info("session tool runner starting", {
            component: "session-tool-runner",
            session_id: this.sessionId
          });
          const streamPromise = __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_streamLoop).call(this).catch((e) => {
            if (!__classPrivateFieldGet(this, _SessionToolRunner_controller, "f").signal.aborted) {
              __classPrivateFieldGet(this, _SessionToolRunner_logger, "f").error("stream loop failed", { error: String(e) });
            }
            __classPrivateFieldGet(this, _SessionToolRunner_controller, "f").abort();
          });
          try {
            while (true) {
              const next2 = await __classPrivateFieldGet(this, _SessionToolRunner_results, "f").next(__classPrivateFieldGet(this, _SessionToolRunner_controller, "f").signal);
              if (next2.done)
                break;
              yield next2.value;
            }
            await streamPromise;
            let pending;
            while ((pending = __classPrivateFieldGet(this, _SessionToolRunner_results, "f").tryShift()) !== void 0) {
              yield pending;
            }
          } finally {
            __classPrivateFieldGet(this, _SessionToolRunner_controller, "f").abort();
            __classPrivateFieldGet(this, _SessionToolRunner_idleClock, "f").disarm();
            await streamPromise;
            try {
              await __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_drain).call(this);
            } catch (e) {
              __classPrivateFieldGet(this, _SessionToolRunner_logger, "f").warn("drain failed", { error: String(e) });
            }
            __classPrivateFieldGet(this, _SessionToolRunner_results, "f").close();
            for (const t of this.tools) {
              try {
                await t.close?.();
              } catch (e) {
                __classPrivateFieldGet(this, _SessionToolRunner_logger, "f").warn("tool.close failed", { tool: toolName(t), error: String(e) });
              }
            }
            __classPrivateFieldGet(this, _SessionToolRunner_detachExternal, "f").call(this);
          }
        }
      }
      _SessionToolRunner_requestOptions = function _SessionToolRunner_requestOptions2() {
        return {
          ...__classPrivateFieldGet(this, _SessionToolRunner_requestOpts, "f"),
          headers: buildHeaders([helperHeader("session-tool-runner"), __classPrivateFieldGet(this, _SessionToolRunner_requestOpts, "f")?.headers]),
          signal: __classPrivateFieldGet(this, _SessionToolRunner_controller, "f").signal
        };
      }, _SessionToolRunner_streamLoop = // ===== event stream =====
      async function _SessionToolRunner_streamLoop2() {
        const ctrl = __classPrivateFieldGet(this, _SessionToolRunner_controller, "f");
        let backoff3 = STREAM_BACKOFF_START_MS;
        while (!ctrl.signal.aborted) {
          try {
            const stream2 = await this.client.beta.sessions.events.stream(this.sessionId, {}, __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_requestOptions).call(this));
            await __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_reconcile).call(this);
            for await (const ev of stream2) {
              backoff3 = STREAM_BACKOFF_START_MS;
              if (await __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_handleStreamEvent).call(this, ev))
                return;
            }
          } catch (e) {
            ctrl.signal.throwIfAborted();
            if (isFatal4xx(e)) {
              __classPrivateFieldGet(this, _SessionToolRunner_logger, "f").error("permanent stream failure, shutting down", { error: String(e) });
              ctrl.abort();
              throw e;
            }
            __classPrivateFieldGet(this, _SessionToolRunner_logger, "f").warn("stream disconnected, reconnecting", {
              error: String(e),
              backoff_ms: backoff3
            });
          }
          ctrl.signal.throwIfAborted();
          await sleep(backoff3, ctrl.signal);
          backoff3 = Math.min(backoff3 * 2, STREAM_BACKOFF_CAP_MS);
        }
      }, _SessionToolRunner_reconcile = /**
       * Read full history before dispatching so a `tool_use` whose result appears
       * later in the same history is not re-executed. Runs after the live stream is
       * already attached (see {@link SessionToolRunner.#streamLoop}).
       */
      async function _SessionToolRunner_reconcile2() {
        const ctrl = __classPrivateFieldGet(this, _SessionToolRunner_controller, "f");
        const pending = [];
        let lastWasEndTurn = false;
        try {
          for await (const ev of this.client.beta.sessions.events.list(this.sessionId, { limit: 1e3 }, __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_requestOptions).call(this))) {
            __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_ingestHistory).call(this, ev, pending);
            lastWasEndTurn = isEndTurnIdle(ev);
          }
        } catch (e) {
          ctrl.signal.throwIfAborted();
          __classPrivateFieldGet(this, _SessionToolRunner_logger, "f").warn("reconcile list failed", { error: String(e) });
          for (const ev of pending)
            __classPrivateFieldGet(this, _SessionToolRunner_seen, "f").delete(ev.id);
          return;
        }
        const unanswered = pending.filter((ev) => !__classPrivateFieldGet(this, _SessionToolRunner_answered, "f").has(ev.id));
        __classPrivateFieldGet(this, _SessionToolRunner_idleClock, "f").disarm();
        for (const ev of unanswered)
          await __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_routeToolEvent).call(this, ev);
        for (const held of [...__classPrivateFieldGet(this, _SessionToolRunner_awaitingConfirmation, "f").values()]) {
          const verdict = __classPrivateFieldGet(this, _SessionToolRunner_confirmationVerdicts, "f").get(held.id);
          if (verdict !== void 0)
            await __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_applyVerdict).call(this, held, verdict);
        }
        const outstanding = unanswered.filter((ev) => !__classPrivateFieldGet(this, _SessionToolRunner_answered, "f").has(ev.id) && !__classPrivateFieldGet(this, _SessionToolRunner_awaitingConfirmation, "f").has(ev.id));
        if (lastWasEndTurn && outstanding.length === 0)
          __classPrivateFieldGet(this, _SessionToolRunner_idleClock, "f").arm();
        else
          __classPrivateFieldGet(this, _SessionToolRunner_idleClock, "f").disarm();
      }, _SessionToolRunner_ingestHistory = function _SessionToolRunner_ingestHistory2(ev, pending) {
        if (ev.type === "agent.tool_use" || ev.type === "agent.custom_tool_use") {
          __classPrivateFieldGet(this, _SessionToolRunner_seen, "f").add(ev.id);
          if (!__classPrivateFieldGet(this, _SessionToolRunner_answered, "f").has(ev.id))
            pending.push(ev);
        } else if (ev.type === "user.tool_result") {
          __classPrivateFieldGet(this, _SessionToolRunner_answered, "f").add(ev.tool_use_id);
        } else if (ev.type === "user.custom_tool_result") {
          __classPrivateFieldGet(this, _SessionToolRunner_answered, "f").add(ev.custom_tool_use_id);
        } else if (ev.type === "user.tool_confirmation") {
          if (!__classPrivateFieldGet(this, _SessionToolRunner_answered, "f").has(ev.tool_use_id))
            __classPrivateFieldGet(this, _SessionToolRunner_confirmationVerdicts, "f").set(ev.tool_use_id, ev.result);
        }
      }, _SessionToolRunner_handleStreamEvent = /** Returns true when the runner should exit. */
      async function _SessionToolRunner_handleStreamEvent2(ev) {
        __classPrivateFieldGet(this, _SessionToolRunner_idleClock, "f").noteEvent(ev);
        switch (ev.type) {
          case "agent.tool_use":
          case "agent.custom_tool_use":
            if (!__classPrivateFieldGet(this, _SessionToolRunner_seen, "f").has(ev.id)) {
              __classPrivateFieldGet(this, _SessionToolRunner_seen, "f").add(ev.id);
              await __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_routeToolEvent).call(this, ev);
            }
            return false;
          case "user.tool_confirmation":
            await __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_noteConfirmation).call(this, ev);
            return false;
          case "user.tool_result":
            __classPrivateFieldGet(this, _SessionToolRunner_answered, "f").add(ev.tool_use_id);
            return false;
          case "user.custom_tool_result":
            __classPrivateFieldGet(this, _SessionToolRunner_answered, "f").add(ev.custom_tool_use_id);
            return false;
          case "session.status_terminated":
          case "session.deleted":
            __classPrivateFieldGet(this, _SessionToolRunner_logger, "f").info("session terminated", {
              component: "session-tool-runner",
              session_id: this.sessionId
            });
            __classPrivateFieldGet(this, _SessionToolRunner_controller, "f").abort();
            return true;
          default:
            return false;
        }
      }, _SessionToolRunner_routeToolEvent = // ===== confirmation gating (always_ask tools) =====
      /**
       * Dispatch `ev`, honoring its evaluated permission. A call the server gated
       * (`evaluated_permission == "ask"`) is held until its `user.tool_confirmation`
       * arrives. Fails closed: only an explicit `allow` verdict releases a gated
       * call; a server-side `deny` overrides any recorded verdict; an unrecognized
       * permission is held like `ask` and an unrecognized verdict is denied.
       */
      async function _SessionToolRunner_routeToolEvent2(ev) {
        const permission = ev.evaluated_permission;
        const verdict = permission === "deny" ? "deny" : __classPrivateFieldGet(this, _SessionToolRunner_confirmationVerdicts, "f").get(ev.id);
        if (verdict === void 0) {
          if (permission === void 0 || permission === "allow") {
            await __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_execute).call(this, ev, void 0);
          } else if (!__classPrivateFieldGet(this, _SessionToolRunner_awaitingConfirmation, "f").has(ev.id)) {
            __classPrivateFieldGet(this, _SessionToolRunner_logger, "f").info("tool call awaiting confirmation; holding", {
              component: "session-tool-runner",
              session_id: this.sessionId,
              tool: ev.name,
              tool_use_id: ev.id
            });
            __classPrivateFieldGet(this, _SessionToolRunner_awaitingConfirmation, "f").set(ev.id, ev);
            __classPrivateFieldGet(this, _SessionToolRunner_idleClock, "f").block(ev.id);
          }
          return;
        }
        await __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_applyVerdict).call(this, ev, verdict);
      }, _SessionToolRunner_noteConfirmation = /** Record an allow/deny verdict and release the held call it gates, if any. */
      async function _SessionToolRunner_noteConfirmation2(ev) {
        __classPrivateFieldGet(this, _SessionToolRunner_confirmationVerdicts, "f").set(ev.tool_use_id, ev.result);
        const held = __classPrivateFieldGet(this, _SessionToolRunner_awaitingConfirmation, "f").get(ev.tool_use_id);
        if (held === void 0)
          return;
        await __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_applyVerdict).call(this, held, ev.result);
      }, _SessionToolRunner_applyVerdict = /**
       * Dispatch or resolve a gated call according to its verdict.
       *
       * The idle-clock blocker accounting lives here: a denial retires the held
       * call's blocker, while an allow keeps one on the call — taking it now if the
       * verdict was already known when the call was routed, so it was never held —
       * until `#execute` has finished with it. The countdown must not run over
       * gated work that is still in flight.
       */
      async function _SessionToolRunner_applyVerdict2(ev, verdict) {
        const wasHeld = __classPrivateFieldGet(this, _SessionToolRunner_awaitingConfirmation, "f").delete(ev.id);
        if (verdict === "allow") {
          __classPrivateFieldGet(this, _SessionToolRunner_logger, "f").info("tool call confirmed", {
            component: "session-tool-runner",
            session_id: this.sessionId,
            tool: ev.name,
            tool_use_id: ev.id
          });
          if (!wasHeld)
            __classPrivateFieldGet(this, _SessionToolRunner_idleClock, "f").block(ev.id);
          try {
            await __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_execute).call(this, ev, "allow");
          } finally {
            __classPrivateFieldGet(this, _SessionToolRunner_idleClock, "f").unblock(ev.id);
          }
          return;
        }
        if (wasHeld)
          __classPrivateFieldGet(this, _SessionToolRunner_idleClock, "f").unblock(ev.id);
        __classPrivateFieldGet(this, _SessionToolRunner_answered, "f").add(ev.id);
        __classPrivateFieldGet(this, _SessionToolRunner_logger, "f").info("tool call denied; not executing", {
          component: "session-tool-runner",
          session_id: this.sessionId,
          tool: ev.name,
          tool_use_id: ev.id
        });
        __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_surfaceCall).call(this, {
          event: ev,
          toolUseId: ev.id,
          name: ev.name,
          isError: false,
          posted: false,
          confirmation: "deny"
        });
      }, _SessionToolRunner_surfaceCall = function _SessionToolRunner_surfaceCall2(call) {
        __classPrivateFieldGet(this, _SessionToolRunner_results, "f").push(call);
      }, _SessionToolRunner_execute = // ===== tool execution =====
      async function _SessionToolRunner_execute2(ev, confirmation) {
        var _a2, _b;
        if (__classPrivateFieldGet(this, _SessionToolRunner_answered, "f").has(ev.id))
          return;
        __classPrivateFieldGet(this, _SessionToolRunner_logger, "f").info("executing tool", {
          component: "session-tool-runner",
          session_id: this.sessionId,
          tool: ev.name,
          tool_use_id: ev.id
        });
        __classPrivateFieldSet(this, _SessionToolRunner_inFlightCount, (_a2 = __classPrivateFieldGet(this, _SessionToolRunner_inFlightCount, "f"), _a2++, _a2), "f");
        try {
          const tool = __classPrivateFieldGet(this, _SessionToolRunner_toolByName, "f").get(ev.name);
          if (!tool) {
            __classPrivateFieldGet(this, _SessionToolRunner_logger, "f").info("tool not owned by this runner; leaving the tool_use_id pending for its owner", {
              component: "session-tool-runner",
              session_id: this.sessionId,
              tool: ev.name,
              tool_use_id: ev.id
            });
            __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_surfaceCall).call(this, {
              event: ev,
              toolUseId: ev.id,
              name: ev.name,
              isError: false,
              posted: false,
              confirmation
            });
            return;
          }
          let content;
          let isError;
          const toolCtrl = new AbortController();
          const detachTool = linkAbort(__classPrivateFieldGet(this, _SessionToolRunner_controller, "f").signal, toolCtrl);
          const timer = setTimeout(() => toolCtrl.abort(), TOOL_TIMEOUT_MS);
          try {
            const outcome = await runRunnableTool(tool, ev.input, {
              toolUse: ev,
              toolUseBlock: ev,
              signal: toolCtrl.signal
            });
            content = outcome.content;
            isError = outcome.isError;
          } finally {
            clearTimeout(timer);
            detachTool();
          }
          const result = buildResultEvent(ev, isError, toSessionContent(content));
          const posted = await __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_sendResult).call(this, result, ev.id);
          __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_surfaceCall).call(this, {
            event: ev,
            result,
            toolUseId: ev.id,
            name: ev.name,
            isError,
            posted,
            confirmation
          });
        } finally {
          __classPrivateFieldSet(this, _SessionToolRunner_inFlightCount, (_b = __classPrivateFieldGet(this, _SessionToolRunner_inFlightCount, "f"), _b--, _b), "f");
          if (__classPrivateFieldGet(this, _SessionToolRunner_inFlightCount, "f") === 0)
            __classPrivateFieldGet(this, _SessionToolRunner_onIdle, "f")?.call(this);
        }
      }, _SessionToolRunner_sendResult = async function _SessionToolRunner_sendResult2(result, toolUseId) {
        const ctrl = __classPrivateFieldGet(this, _SessionToolRunner_controller, "f");
        const start = Date.now();
        let lastErr;
        let attempt = 0;
        while (true) {
          attempt++;
          ctrl.signal.throwIfAborted();
          try {
            await this.client.beta.sessions.events.send(this.sessionId, { events: [result] }, __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_requestOptions).call(this));
            __classPrivateFieldGet(this, _SessionToolRunner_answered, "f").add(toolUseId);
            return true;
          } catch (e) {
            lastErr = e;
            if (isFatal4xx(e))
              break;
            const remainingMs = __classPrivateFieldGet(this, _SessionToolRunner_sendRetryWindowMs, "f") - (Date.now() - start);
            if (remainingMs <= 0)
              break;
            const waitMs = Math.min(applyJitter(backoff(attempt - 1, SEND_BACKOFF_START_MS, SEND_BACKOFF_CAP_MS)), remainingMs);
            __classPrivateFieldGet(this, _SessionToolRunner_logger, "f").warn("tool result send failed; retrying", {
              tool_use_id: toolUseId,
              attempt,
              backoff_ms: waitMs,
              error: String(e)
            });
            await sleep(waitMs, ctrl.signal);
          }
        }
        __classPrivateFieldGet(this, _SessionToolRunner_logger, "f").error("failed to send tool result", {
          tool_use_id: toolUseId,
          attempts: attempt,
          error: String(lastErr)
        });
        return false;
      }, _SessionToolRunner_drain = /** Wait (bounded) for in-flight tool executions to finish during teardown. */
      async function _SessionToolRunner_drain2() {
        if (__classPrivateFieldGet(this, _SessionToolRunner_inFlightCount, "f") === 0)
          return;
        await Promise.race([new Promise((r) => __classPrivateFieldSet(this, _SessionToolRunner_onIdle, r, "f")), sleep(DRAIN_TIMEOUT_MS)]);
        __classPrivateFieldSet(this, _SessionToolRunner_onIdle, null, "f");
        if (__classPrivateFieldGet(this, _SessionToolRunner_inFlightCount, "f") > 0) {
          __classPrivateFieldGet(this, _SessionToolRunner_logger, "f").warn("drain timeout exceeded");
        }
      };
      return SessionToolRunner2;
    })();
  }
});

// node_modules/@anthropic-ai/sdk/tools/agent-toolset/sync-interval.mjs
function checkMemorySyncInterval(ms, option) {
  if (!(ms >= MIN_MEMORY_SYNC_INTERVAL_MS)) {
    throw new AnthropicError(`${option} must be at least ${MIN_MEMORY_SYNC_INTERVAL_MS}ms (got ${ms}); to run without memory sync, pass \`memorySyncIntervalMs: null\` to the worker instead`);
  }
}
var DEFAULT_MEMORY_SYNC_INTERVAL_MS, MIN_MEMORY_SYNC_INTERVAL_MS;
var init_sync_interval = __esm({
  "node_modules/@anthropic-ai/sdk/tools/agent-toolset/sync-interval.mjs"() {
    init_error();
    DEFAULT_MEMORY_SYNC_INTERVAL_MS = 15e3;
    MIN_MEMORY_SYNC_INTERVAL_MS = 5e3;
  }
});

// node_modules/@anthropic-ai/sdk/helpers/beta/json-schema.mjs
function betaTool(options) {
  if (options.inputSchema.type !== "object") {
    throw new Error(`JSON schema for tool "${options.name}" must be an object, but got ${options.inputSchema.type}`);
  }
  return {
    type: "custom",
    name: options.name,
    input_schema: options.inputSchema,
    description: options.description,
    run: options.run,
    parse: (content) => content,
    ...options.close ? { close: options.close } : {}
  };
}
var init_json_schema = __esm({
  "node_modules/@anthropic-ai/sdk/helpers/beta/json-schema.mjs"() {
  }
});

// node_modules/@anthropic-ai/sdk/internal/utils/promise.mjs
function promiseWithResolvers() {
  let resolve2;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve2 = res;
    reject = rej;
  });
  return { promise, resolve: resolve2, reject };
}
var init_promise = __esm({
  "node_modules/@anthropic-ai/sdk/internal/utils/promise.mjs"() {
  }
});

// node_modules/@anthropic-ai/sdk/tools/agent-toolset/fs-util.mjs
function isWithin(root, p) {
  const rel = path2.relative(root, p);
  return rel === "" || !rel.startsWith(".." + path2.sep) && rel !== ".." && !path2.isAbsolute(rel);
}
async function containingRoot(roots, target) {
  for (const root of roots) {
    if (isWithin(await canonicalize(path2.resolve(root)), target))
      return root;
  }
  return void 0;
}
function errnoCode(err) {
  const code = err?.code;
  return typeof code === "string" ? code : void 0;
}
async function canonicalize(abs) {
  const tail = [];
  let prefix = abs;
  let hops = 0;
  for (; ; ) {
    let real;
    try {
      real = await fs3.realpath(prefix);
    } catch (realpathErr) {
      let isLink;
      try {
        isLink = (await fs3.lstat(prefix)).isSymbolicLink();
      } catch (lstatErr) {
        const code = errnoCode(lstatErr);
        if (code !== "ENOENT" && code !== "ENOTDIR")
          throw lstatErr;
        const parent = path2.dirname(prefix);
        if (parent === prefix)
          throw lstatErr;
        tail.push(path2.basename(prefix));
        prefix = parent;
        continue;
      }
      if (!isLink)
        throw realpathErr;
      if (++hops > MAX_SYMLINK_HOPS) {
        throw Object.assign(new Error("too many levels of symbolic links"), { code: "ELOOP" });
      }
      prefix = path2.resolve(path2.dirname(prefix), await fs3.readlink(prefix));
      continue;
    }
    return tail.length ? path2.join(real, ...tail.reverse()) : real;
  }
}
async function confineToRoot(root, p, opts) {
  const allowedRoots = opts?.allowedRoots ?? [];
  const realRoot = await canonicalize(path2.resolve(root));
  let real;
  try {
    real = await canonicalize(path2.resolve(realRoot, p));
  } catch (err) {
    throw new ToolError(fsErrorMessage(err, `path ${JSON.stringify(p)}`));
  }
  if (isWithin(realRoot, real) || await containingRoot(allowedRoots, real) !== void 0) {
    return real;
  }
  const permitted = allowedRoots.length ? "the session's working directory and its other permitted directories" : "the session's working directory";
  throw new ToolError(`path ${JSON.stringify(p)} is outside ${permitted}`);
}
async function atomicWriteFile(targetPath, content) {
  const dir = path2.dirname(targetPath);
  const tempPath = path2.join(dir, `.tmp-${process.pid}-${crypto2.randomUUID()}`);
  const existingMode = await fs3.stat(targetPath).then((st2) => st2.mode & 511, () => void 0);
  let handle;
  try {
    handle = await fs3.open(tempPath, "wx", FILE_CREATE_MODE);
    if (existingMode !== void 0)
      await handle.chmod(existingMode);
    await handle.writeFile(content, "utf-8");
    await handle.sync();
    await handle.close();
    handle = void 0;
    await fs3.rename(tempPath, targetPath);
  } catch (err) {
    if (handle)
      await handle.close().catch(() => {
      });
    await fs3.unlink(tempPath).catch(() => {
    });
    throw err;
  }
}
function fsErrorMessage(err, file) {
  const code = errnoCode(err);
  switch (code) {
    case "ENOENT":
      return `${file}: no such file or directory`;
    case "EACCES":
    case "EPERM":
      return `${file}: permission denied`;
    case "ENOTDIR":
      return `${file}: not a directory`;
    case "EISDIR":
      return `${file}: is a directory`;
    case "ELOOP":
      return `${file}: too many levels of symbolic links`;
    case "ENAMETOOLONG":
      return `${file}: file name too long`;
    case "ENOSPC":
      return `${file}: no space left on device`;
    case "EMFILE":
    case "ENFILE":
      return `${file}: too many open files`;
    default:
      return `${file}: ${code !== void 0 ? `i/o error (${code})` : "i/o error"}`;
  }
}
var fs3, DIR_CREATE_MODE, FILE_CREATE_MODE, MAX_SYMLINK_HOPS;
var init_fs_util = __esm({
  "node_modules/@anthropic-ai/sdk/tools/agent-toolset/fs-util.mjs"() {
    init_node();
    init_ToolError();
    fs3 = fs2.promises;
    DIR_CREATE_MODE = 448;
    FILE_CREATE_MODE = 384;
    MAX_SYMLINK_HOPS = 40;
  }
});

// node_modules/@anthropic-ai/sdk/tools/agent-toolset/skills.mjs
async function setupSkills(ctx) {
  const { client: client2, sessionId } = ctx;
  if (!client2)
    return async () => {
    };
  const log = loggerFor(client2);
  let session = ctx.session;
  if (!session) {
    if (sessionId === void 0)
      return async () => {
      };
    log.warn("AgentToolContext.sessionId is deprecated and costs an extra session fetch; fetch the session once and set `session` instead", { component: "agent-tool-context" });
    session = await client2.beta.sessions.retrieve(sessionId);
  }
  const skillsRoot = path2.resolve(ctx.workdir, "skills");
  const created = [];
  for (const skill of session.agent.skills) {
    try {
      const version = await client2.beta.skills.versions.retrieve(skill.version, { skill_id: skill.skill_id });
      let dirname2 = path2.basename(version.name.trim());
      if (dirname2 === "" || dirname2 === "." || dirname2 === "..")
        dirname2 = skill.skill_id;
      const dest = path2.resolve(skillsRoot, dirname2);
      if (dest !== skillsRoot && !dest.startsWith(skillsRoot + path2.sep)) {
        log.warn("skill name escapes the skills dir; skipping", {
          component: "agent-tool-context",
          name: version.name
        });
        continue;
      }
      const resp = await client2.beta.skills.versions.download(version.id, { skill_id: skill.skill_id });
      await fs4.rm(dest, { recursive: true, force: true });
      await fs4.mkdir(dest, { recursive: true, mode: DIR_CREATE_MODE });
      created.push(dest);
      await extractSkillArchive(resp, dest);
      log.info("downloaded skill", {
        component: "agent-tool-context",
        skill_id: skill.skill_id,
        version: version.id,
        dest
      });
    } catch (e) {
      log.warn("failed to download skill", {
        component: "agent-tool-context",
        skill_id: skill.skill_id,
        error: String(e)
      });
    }
  }
  return async () => {
    for (const dest of created) {
      await fs4.rm(dest, { recursive: true, force: true }).catch((e) => {
        log.warn("failed to clean up skill", { component: "agent-tool-context", dest, error: String(e) });
      });
    }
  };
}
function assertSafeMemberNames(names) {
  for (const raw of names) {
    const entry = raw.trim();
    if (!entry)
      continue;
    if (path2.isAbsolute(entry) || entry.split(/[\\/]/).includes("..")) {
      throw new AnthropicError(`refusing to extract unsafe archive member: ${entry}`);
    }
  }
}
function listingLines(listing) {
  const lines = listing.split("\n");
  if (lines[lines.length - 1] === "")
    lines.pop();
  return lines;
}
function canExcludeVerbatim(cmd, name) {
  return /^[\x20-\x7E]+$/.test(name) && !/[\\^#]/.test(name) && !(cmd === "unzip" && name.startsWith("-"));
}
function classifyArchiveListing(cmd, names, typed) {
  const nameLines = listingLines(names);
  const typedLines = listingLines(typed);
  if (nameLines.length !== typedLines.length)
    throw new AnthropicError(INCONSISTENT_LISTING);
  const plain = [];
  const special = [];
  nameLines.forEach((name, i) => {
    if (PLAIN_TYPE_CHARS[cmd].has(typedLines[i].charAt(0))) {
      plain.push(name);
      return;
    }
    if (!canExcludeVerbatim(cmd, name)) {
      throw new AnthropicError(`refusing to extract archive: cannot safely exclude member ${JSON.stringify(name)}`);
    }
    special.push(name);
  });
  return { plain, special };
}
async function assertOnlyPlainEntries(dir) {
  for (const entry of await fs4.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory())
      await assertOnlyPlainEntries(path2.join(dir, entry.name));
    else if (!entry.isFile())
      throw new AnthropicError(INCONSISTENT_LISTING);
  }
}
async function runArchiveTool(cmd, args) {
  try {
    const { stdout } = await execFileAsync(cmd, args);
    return stdout;
  } catch (e) {
    if (errnoCode(e) === "ENOENT") {
      throw new AnthropicError(`skill extraction requires the \`${cmd}\` command, but it was not found on PATH`);
    }
    throw e;
  }
}
function archiveTopDir(names) {
  let top;
  let nested = false;
  for (const raw of names) {
    const parts = raw.trim().split("/").filter((p) => p !== "" && p !== ".");
    if (parts.length === 0)
      continue;
    const first = parts[0];
    if (top === void 0)
      top = first;
    else if (first !== top)
      return "";
    if (parts.length > 1)
      nested = true;
  }
  return top !== void 0 && nested ? top : "";
}
async function extractSkillArchive(resp, dest) {
  const tmp = path2.join(dest, `.skill-archive-${process.pid}-${Date.now()}`);
  if (!resp.body) {
    throw new AnthropicError("skill download response had no body");
  }
  await stream.promises.pipeline(stream.Readable.fromWeb(resp.body), fs2.createWriteStream(tmp));
  const stage = path2.join(path2.dirname(dest), `.skill-stage-${process.pid}-${Date.now()}`);
  const excludeFile = path2.join(path2.dirname(dest), `.skill-exclude-${process.pid}-${Date.now()}`);
  try {
    const head = await readHead(tmp, 4);
    const isZip = head.length >= 4 && head[0] === 80 && head[1] === 75 && head[2] === 3 && head[3] === 4;
    const archiveCmd = isZip ? "unzip" : "tar";
    const names = await runArchiveTool(archiveCmd, isZip ? ["-Z1", tmp] : ["-tf", tmp]);
    const typed = await runArchiveTool(archiveCmd, isZip ? ["-Z", "--h", "--t", tmp] : ["-tvf", tmp]);
    const { plain, special } = classifyArchiveListing(archiveCmd, names, typed);
    assertSafeMemberNames([...plain, ...special]);
    const top = archiveTopDir(plain);
    await fs4.mkdir(stage, { recursive: true, mode: DIR_CREATE_MODE });
    if (plain.length > 0) {
      await runArchiveTool(archiveCmd, await extractArgs(archiveCmd, tmp, stage, special, excludeFile));
    }
    await assertOnlyPlainEntries(stage);
    const srcRoot = top ? path2.join(stage, top) : stage;
    const entries = await fs4.readdir(srcRoot).catch((e) => {
      throw errnoCode(e) === "ENOENT" ? new AnthropicError(INCONSISTENT_LISTING) : e;
    });
    for (const entry of entries) {
      await fs4.rename(path2.join(srcRoot, entry), path2.join(dest, entry));
    }
  } finally {
    await fs4.rm(tmp, { force: true });
    await fs4.rm(excludeFile, { force: true });
    await fs4.rm(stage, { recursive: true, force: true });
  }
}
async function extractArgs(cmd, archive, stage, special, excludeFile) {
  const patterns = special.map((name) => name.replace(/[*?[\\]/g, "\\$&"));
  if (cmd === "unzip") {
    return ["-oq", archive, "-d", stage, ...patterns.length > 0 ? ["-x", ...patterns] : []];
  }
  if (patterns.length === 0)
    return ["-xf", archive, "-C", stage];
  await fs4.writeFile(excludeFile, patterns.join("\n") + "\n", { flag: "wx", mode: 384 });
  return ["-xf", archive, "-C", stage, "-X", excludeFile];
}
async function readHead(file, n) {
  const handle = await fs4.open(file, "r");
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await handle.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
var fs4, execFileAsync, INCONSISTENT_LISTING, PLAIN_TYPE_CHARS;
var init_skills = __esm({
  "node_modules/@anthropic-ai/sdk/tools/agent-toolset/skills.mjs"() {
    init_node();
    init_error();
    init_log();
    init_fs_util();
    fs4 = fs2.promises;
    execFileAsync = util.promisify(child_process.execFile);
    INCONSISTENT_LISTING = "skill archive listing is inconsistent; refusing to extract";
    PLAIN_TYPE_CHARS = { unzip: /* @__PURE__ */ new Set(["-", "d", "?"]), tar: /* @__PURE__ */ new Set(["-", "d", "C"]) };
  }
});

// node_modules/@anthropic-ai/sdk/internal/file-store.mjs
function isPathLegal(p) {
  return p.startsWith("/") && !p.split("/").includes("..");
}
function platformSupported() {
  return O_NOFOLLOW !== 0;
}
async function makeDirAndAncestors(dir) {
  const missing = [];
  let current = dir;
  for (; ; ) {
    try {
      await fsp.stat(current);
      break;
    } catch (e) {
      const code = e.code;
      if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "ELOOP")
        throw e;
    }
    missing.push(current);
    const parent = path2.dirname(current);
    if (parent === current)
      break;
    current = parent;
  }
  for (const directory of missing.reverse()) {
    try {
      await fsp.mkdir(directory, { mode: OWNER_ONLY_DIR_MODE });
    } catch (e) {
      if (e.code !== "EEXIST")
        throw e;
    }
  }
}
async function makeDirsBelowRoot(root, dir) {
  const below = path2.relative(root, dir);
  if (below === "")
    return;
  let current = root;
  for (const part of below.split(path2.sep)) {
    current = path2.join(current, part);
    try {
      await fsp.mkdir(current, { mode: OWNER_ONLY_DIR_MODE });
    } catch (e) {
      if (e.code !== "EEXIST")
        throw e;
    }
  }
}
async function replaceViaTemp(dest, data, isExecutable) {
  const mode = isExecutable ? OWNER_ONLY_EXEC_MODE : OWNER_ONLY_FILE_MODE;
  const tmp = path2.join(path2.dirname(dest), `.fs-${crypto2.randomBytes(8).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await fsp.open(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | O_NOFOLLOW, mode);
    await handle.writeFile(data);
    await handle.close();
    handle = void 0;
    await fsp.rename(tmp, dest);
  } catch (err) {
    if (handle)
      await handle.close().catch(() => {
      });
    await fsp.unlink(tmp).catch(() => {
    });
    throw err;
  }
}
async function openRegularFile(relPath, dest) {
  let handle;
  try {
    handle = await fsp.open(dest, C.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (e) {
    const code = e.code;
    if (code === "ELOOP" || code === "EMLINK") {
      throw new FileStoreError(FileStoreError.IS_A_SYMLINK, relPath);
    }
    throw e;
  }
  try {
    const st2 = await handle.stat();
    if (!st2.isFile())
      throw new FileStoreError(FileStoreError.NOT_A_FILE, relPath);
  } catch (e) {
    await handle.close().catch(() => {
    });
    throw e;
  }
  return handle;
}
async function hashFile(full) {
  const digest = crypto2.createHash("sha256");
  const handle = await openRegularFile(path2.basename(full), full);
  const buf = new Uint8Array(1024 * 1024);
  try {
    for (; ; ) {
      const { bytesRead } = await handle.read(buf, 0, buf.length);
      if (bytesRead === 0)
        break;
      digest.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return digest.digest("hex");
}
async function filenamesInDir(root, under, base) {
  if (!await requireDir(under, base))
    return [];
  const out = [];
  await walk(base, (full, entry) => {
    if (entry.isFile())
      out.push([path2.relative(root, full).split(path2.sep).join("/"), full]);
  });
  out.sort();
  return out;
}
async function symlinksInDir(root, under, base) {
  const relOf = (full) => path2.relative(root, full).split(path2.sep).join("/");
  let st2;
  try {
    st2 = await fsp.lstat(base, { bigint: true });
  } catch (e) {
    const code = e.code;
    if (code === "ENOENT" || code === "ENOTDIR")
      return /* @__PURE__ */ new Set();
    throw e;
  }
  if (st2.isSymbolicLink())
    return /* @__PURE__ */ new Set([relOf(base)]);
  if (!st2.isDirectory())
    throw new FileStoreError(FileStoreError.NOT_A_DIRECTORY, under);
  const out = /* @__PURE__ */ new Set();
  await walk(base, (full, entry) => {
    if (entry.isSymbolicLink())
      out.add(relOf(full));
  });
  return out;
}
async function requireDir(under, base) {
  let st2;
  try {
    st2 = await fsp.lstat(base, { bigint: true });
  } catch (e) {
    const code = e.code;
    if (code === "ENOENT" || code === "ENOTDIR")
      return false;
    throw e;
  }
  if (!st2.isDirectory())
    throw new FileStoreError(FileStoreError.NOT_A_DIRECTORY, under);
  return true;
}
async function walk(base, visit) {
  const stack = [base];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (e.code === "ENOENT")
        continue;
      throw e;
    }
    for (const entry of entries) {
      const full = path2.join(dir, entry.name);
      visit(full, entry);
      if (entry.isDirectory() && !entry.isSymbolicLink())
        stack.push(full);
    }
  }
}
function unchangedSinceHashed(cached, st2) {
  return st2.mtimeNs === cached.mtimeNs && st2.ctimeNs === cached.ctimeNs && st2.size === cached.size;
}
function oldEnoughToCache(st2, walkStartNs) {
  const newestNs = st2.mtimeNs > st2.ctimeNs ? st2.mtimeNs : st2.ctimeNs;
  return newestNs < walkStartNs - _internals.timestampTrustMarginNs;
}
var fsp, C, OWNER_ONLY_DIR_MODE, OWNER_ONLY_FILE_MODE, OWNER_ONLY_EXEC_MODE, O_NOFOLLOW, O_NONBLOCK, FileStoreError, FileStore, TIMESTAMP_TRUST_MARGIN_NS, _internals, LocalFileStore, asyncDispose;
var init_file_store = __esm({
  "node_modules/@anthropic-ai/sdk/internal/file-store.mjs"() {
    init_node();
    init_bytes();
    fsp = fs2.promises;
    C = fs2.constants;
    OWNER_ONLY_DIR_MODE = 448;
    OWNER_ONLY_FILE_MODE = 384;
    OWNER_ONLY_EXEC_MODE = 448;
    O_NOFOLLOW = C.O_NOFOLLOW ?? 0;
    O_NONBLOCK = C.O_NONBLOCK ?? 0;
    FileStoreError = /* @__PURE__ */ (() => {
      class FileStoreError2 extends Error {
        constructor(reason, relPath) {
          super(`path ${JSON.stringify(relPath)} ${reason}`);
          this.name = "FileStoreError";
          this.reason = reason;
          this.relPath = relPath;
        }
      }
      FileStoreError2.ESCAPES_ROOT = "escapes the store root";
      FileStoreError2.IS_A_SYMLINK = "is a symlink";
      FileStoreError2.NOT_A_FILE = "is not a regular file";
      FileStoreError2.NOT_A_DIRECTORY = "is not a directory";
      FileStoreError2.NOT_UTF8 = "is not valid utf-8";
      FileStoreError2.MOVE_DESTINATION_EXISTS = "already exists";
      return FileStoreError2;
    })();
    FileStore = /* @__PURE__ */ (() => {
      class FileStore2 {
        /** @internal — use {@link FileStore.open} / {@link openFileStore}. */
        constructor(root, removedOnDispose, utf8Only = false) {
          this.hashes = /* @__PURE__ */ new Map();
          this.rootPath = root;
          this.removedOnDispose = removedOnDispose;
          this.decoder = utf8Only ? new TextDecoder("utf-8", { fatal: true }) : void 0;
        }
        /** Resolve `root`; creates nothing — only {@link createRoot} makes the folder. */
        static async open(root, opts) {
          if (!platformSupported()) {
            throw new Error("FileStore requires O_NOFOLLOW support on this platform");
          }
          let removedOnDispose = false;
          try {
            await fsp.lstat(root);
          } catch (e) {
            if (e.code !== "ENOENT")
              throw e;
            removedOnDispose = true;
          }
          return new FileStore2(path2.resolve(root), removedOnDispose, opts?.utf8 ?? false);
        }
        /** Create the root directory and any missing ancestors; already existing is fine. */
        async createRoot() {
          await makeDirAndAncestors(this.rootPath);
        }
        /** The resolved root, and what {@link dispose} will do to it. */
        root() {
          return { path: this.rootPath, removedOnDispose: this.removedOnDispose };
        }
        /**
         * Remove the root iff `open` created it; pre-existing roots are kept.
         *
         * Wired to `Symbol.asyncDispose` at runtime when the host provides it, so
         * `await using` works on engines with explicit resource management.
         */
        async dispose() {
          if (!this.removedOnDispose)
            return;
          await fsp.rm(this.rootPath, { recursive: true, force: true });
        }
        /**
         * Write `data` (`string` UTF-8 or bytes) atomically to the file at `relPath`.
         *
         * Missing directories below the root are created; a missing root is not —
         * the write fails with `ENOENT`.
         */
        async put(relPath, data, opts) {
          const tail = relPath.replace(/\\/g, "/");
          if (tail.endsWith("/") || tail.endsWith("/.") || tail === "" || tail === ".") {
            throw new FileStoreError(FileStoreError.NOT_A_FILE, relPath);
          }
          const dest = this.resolveUnderRoot(relPath);
          const payload = typeof data === "string" ? encodeUTF8(data) : data;
          this.requireUtf8(relPath, payload);
          await makeDirsBelowRoot(this.rootPath, path2.dirname(dest));
          await replaceViaTemp(dest, payload, opts?.executable ?? false);
        }
        /** The file's bytes; `null` when absent. */
        async get(relPath) {
          const dest = this.resolveUnderRoot(relPath);
          let handle;
          try {
            handle = await openRegularFile(relPath, dest);
          } catch (e) {
            if (e.code === "ENOENT")
              return null;
            throw e;
          }
          let data;
          try {
            const buf = await handle.readFile();
            data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
          } finally {
            await handle.close();
          }
          this.requireUtf8(relPath, data);
          return data;
        }
        /** The relative path of every file under the directory `under`. */
        async ls(under = "/") {
          const base = this.resolveUnderRoot(under);
          return new Set((await filenamesInDir(this.rootPath, under, base)).map(([rel]) => rel));
        }
        /**
         * Every symlink under `under` — listings skip them and reads refuse them,
         * so a caller that must know they exist asks here.
         */
        async findSymlinks(under = "/") {
          const base = this.resolveUnderRoot(under);
          return symlinksInDir(this.rootPath, under, base);
        }
        /**
         * `{relPath: sha256Hex}` of every file under the directory `under`.
         *
         * Unchanged files — same size, mtime, and ctime since the last call —
         * reuse their recorded hash instead of being re-read.
         */
        async hashtree(under = "/") {
          const base = this.resolveUnderRoot(under);
          const walkStartNs = _internals.nowNs();
          const out = /* @__PURE__ */ Object.create(null);
          for (const [rel, full] of await filenamesInDir(this.rootPath, under, base)) {
            const sha = await this.hashViaCache(rel, full, walkStartNs);
            if (sha !== null)
              out[rel] = sha;
          }
          return out;
        }
        /** One file's sha256; `null` when absent. Shares {@link hashtree}'s cache. */
        async hashFile(relPath) {
          const dest = this.resolveUnderRoot(relPath);
          let st2;
          try {
            st2 = await fsp.lstat(dest, { bigint: true });
          } catch (e) {
            if (e.code === "ENOENT")
              return null;
            throw e;
          }
          if (st2.isSymbolicLink())
            throw new FileStoreError(FileStoreError.IS_A_SYMLINK, relPath);
          if (!st2.isFile())
            throw new FileStoreError(FileStoreError.NOT_A_FILE, relPath);
          const rel = path2.relative(this.rootPath, dest).split(path2.sep).join("/");
          return this.hashViaCache(rel, dest, _internals.nowNs());
        }
        /**
         * Rename `src` to `dst`; an existing `dst` is refused. The banned store
         * root as either end does nothing.
         */
        async move(src, dst) {
          const s = this.resolveUnderRoot(src);
          const d = this.resolveUnderRoot(dst);
          if (s === this.rootPath || d === this.rootPath)
            return;
          const dstExists = await fsp.stat(d).then(() => true, () => false);
          if (dstExists)
            throw new FileStoreError(FileStoreError.MOVE_DESTINATION_EXISTS, dst);
          await makeDirsBelowRoot(this.rootPath, path2.dirname(d));
          await fsp.rename(s, d);
        }
        /** Delete a file or subtree; absent — and the banned store root — do nothing. */
        async remove(relPath) {
          const dest = this.resolveUnderRoot(relPath);
          if (dest === this.rootPath)
            return;
          let st2;
          try {
            st2 = await fsp.lstat(dest, { bigint: true });
          } catch (e) {
            if (e.code === "ENOENT")
              return;
            throw e;
          }
          if (st2.isDirectory()) {
            await fsp.rm(dest, { recursive: true, force: true });
          } else {
            try {
              await fsp.unlink(dest);
            } catch (e) {
              if (e.code !== "ENOENT")
                throw e;
            }
          }
        }
        resolveUnderRoot(relPath) {
          const norm = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
          const parts = norm.split("/").filter((p) => p !== "" && p !== ".");
          if (path2.posix.isAbsolute(norm) || parts.includes("..")) {
            throw new FileStoreError(FileStoreError.ESCAPES_ROOT, relPath);
          }
          return parts.length === 0 ? this.rootPath : path2.join(this.rootPath, ...parts);
        }
        requireUtf8(relPath, data) {
          if (!this.decoder)
            return;
          try {
            this.decoder.decode(data);
          } catch {
            throw new FileStoreError(FileStoreError.NOT_UTF8, relPath);
          }
        }
        async hashViaCache(rel, full, walkStartNs) {
          let st2;
          try {
            st2 = await fsp.lstat(full, { bigint: true });
          } catch (e) {
            if (e.code === "ENOENT")
              return null;
            throw e;
          }
          if (!st2.isFile())
            return null;
          const cached = this.hashes.get(rel);
          let sha;
          if (cached !== void 0 && unchangedSinceHashed(cached, st2)) {
            sha = cached.sha;
          } else {
            try {
              sha = await _internals.hashFile(full);
            } catch (e) {
              const code = e.code;
              if (code === "ENOENT" || e instanceof FileStoreError)
                return null;
              if (code === "ELOOP" || code === "EMLINK")
                return null;
              throw e;
            }
          }
          if (oldEnoughToCache(st2, walkStartNs)) {
            this.hashes.set(rel, { mtimeNs: st2.mtimeNs, ctimeNs: st2.ctimeNs, size: st2.size, sha });
          }
          return sha;
        }
      }
      FileStore2.isPathLegal = isPathLegal;
      return FileStore2;
    })();
    TIMESTAMP_TRUST_MARGIN_NS = 2000000000n;
    _internals = {
      hashFile,
      timestampTrustMarginNs: TIMESTAMP_TRUST_MARGIN_NS,
      nowNs: () => BigInt(Date.now()) * 1000000n
    };
    LocalFileStore = FileStore;
    asyncDispose = Symbol.asyncDispose;
    if (asyncDispose) {
      Object.defineProperty(FileStore.prototype, asyncDispose, {
        value: FileStore.prototype.dispose,
        configurable: true,
        writable: true
      });
    }
  }
});

// node_modules/@anthropic-ai/sdk/tools/agent-toolset/memories.mjs
function markerSha(memoryStoreId) {
  return crypto2.createHash("sha256").update(`version ${MARKER_VERSION}
${memoryStoreId}`, "utf-8").digest("hex");
}
function isErrno(e) {
  return typeof e === "object" && e !== null && typeof e.code === "string";
}
async function settledOrAborted(p, signal) {
  if (!signal) {
    await p;
    return;
  }
  let onAbort;
  const aborted = new Promise((resolve2) => {
    onAbort = resolve2;
    if (signal.aborted)
      resolve2();
  });
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([p, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
var _SessionMemoryStores_instances, _SessionMemoryStores_client, _SessionMemoryStores_workdir, _SessionMemoryStores_syncIntervalMs, _SessionMemoryStores_syncDeletions, _SessionMemoryStores_log, _SessionMemoryStores_lastSyncAt, _SessionMemoryStores_finished, _SessionMemoryStores_stores, _SessionMemoryStores_storeRoot, _SessionMemoryStores_scanMarker, _SessionMemoryStores_syncStore, _SessionMemoryStores_flushStore, _SessionMemoryStores_recover, _SessionMemoryStores_stampAndPull, _SessionMemoryStores_syncPath, _SessionMemoryStores_removeLocal, _SessionMemoryStores_write, _SessionMemoryStores_pullAll, _SessionMemoryStores_uploadAll, _SessionMemoryStores_listMemories, _SessionMemoryStores_upload, _SessionMemoryStores_corroboratedDelete, _SessionMemoryStores_deleteRemote, MEMORY_FLUSH_TIMEOUT_MS, MARKER_PATH, MARKER_VERSION, DELETE_CORROBORATION_MS, LIST_PAGE_SIZE, FULL_LIST_PAGE_SIZE, FETCH_CONCURRENCY, UPLOAD_CONCURRENCY, DELETE_CAP_FLOOR, DELETE_CAP_CEILING, SessionMemoryError, DeletePass, SessionMemoryStores;
var init_memories = __esm({
  "node_modules/@anthropic-ai/sdk/tools/agent-toolset/memories.mjs"() {
    init_tslib();
    init_node();
    init_error();
    init_log();
    init_bytes();
    init_backoff();
    init_file_store();
    init_sync_interval();
    init_sync_interval();
    MEMORY_FLUSH_TIMEOUT_MS = 3e4;
    MARKER_PATH = ".anthropic-memory-store";
    MARKER_VERSION = 1;
    DELETE_CORROBORATION_MS = 3e4;
    LIST_PAGE_SIZE = 100;
    FULL_LIST_PAGE_SIZE = 20;
    FETCH_CONCURRENCY = 16;
    UPLOAD_CONCURRENCY = 32;
    DELETE_CAP_FLOOR = 8;
    DELETE_CAP_CEILING = 50;
    SessionMemoryError = class extends AnthropicError {
      constructor(message, cause) {
        super(message);
        this.name = "SessionMemoryError";
        if (cause !== void 0)
          this.cause = cause;
      }
    };
    DeletePass = class {
      constructor(mode, cap, waiveWindow) {
        this.mode = mode;
        this.cap = cap;
        this.waiveWindow = waiveWindow;
        this.attempted = 0;
        this.capped = 0;
        this.suppressed = 0;
      }
      takeSlot() {
        if (this.attempted >= this.cap) {
          this.capped++;
          return false;
        }
        this.attempted++;
        return true;
      }
    };
    SessionMemoryStores = /* @__PURE__ */ (() => {
      class SessionMemoryStores2 {
        constructor(client2, opts) {
          _SessionMemoryStores_instances.add(this);
          _SessionMemoryStores_client.set(this, void 0);
          _SessionMemoryStores_workdir.set(this, void 0);
          _SessionMemoryStores_syncIntervalMs.set(this, void 0);
          _SessionMemoryStores_syncDeletions.set(this, void 0);
          _SessionMemoryStores_log.set(this, void 0);
          _SessionMemoryStores_lastSyncAt.set(this, void 0);
          _SessionMemoryStores_finished.set(this, false);
          _SessionMemoryStores_stores.set(this, []);
          __classPrivateFieldSet(this, _SessionMemoryStores_client, client2, "f");
          __classPrivateFieldSet(this, _SessionMemoryStores_workdir, opts.workdir, "f");
          __classPrivateFieldSet(this, _SessionMemoryStores_syncIntervalMs, opts.syncIntervalMs ?? DEFAULT_MEMORY_SYNC_INTERVAL_MS, "f");
          checkMemorySyncInterval(__classPrivateFieldGet(this, _SessionMemoryStores_syncIntervalMs, "f"), "syncIntervalMs");
          __classPrivateFieldSet(this, _SessionMemoryStores_syncDeletions, opts.syncDeletions ?? "enabled", "f");
          __classPrivateFieldSet(this, _SessionMemoryStores_log, loggerFor(client2), "f");
          __classPrivateFieldSet(this, _SessionMemoryStores_lastSyncAt, Date.now(), "f");
        }
        /**
         * Every attached store's root directory.
         *
         * The worker lists these as the file tools' allowed roots so a store
         * mounted outside the workdir stays reachable.
         */
        get roots() {
          return __classPrivateFieldGet(this, _SessionMemoryStores_stores, "f").map((s) => s.files.root().path);
        }
        /**
         * Root directories of stores attached read-only.
         *
         * The file tools consult this to refuse writes into read-only stores.
         */
        get readOnlyRoots() {
          return __classPrivateFieldGet(this, _SessionMemoryStores_stores, "f").filter((s) => s.readOnly).map((s) => s.files.root().path);
        }
        /**
         * Download every attached store's memories to disk.
         *
         * `session` arrives already fetched — one snapshot shared with the skills
         * download, so the two cannot disagree about the resources.
         */
        async download(session) {
          for (const resource of session.resources) {
            if (resource.type !== "memory_store")
              continue;
            const root = __classPrivateFieldGet(this, _SessionMemoryStores_instances, "m", _SessionMemoryStores_storeRoot).call(this, resource);
            let store2;
            try {
              store2 = {
                memoryStoreId: resource.memory_store_id,
                // utf8: a binary file is refused at put/get, not mid-sync.
                files: await LocalFileStore.open(root, { utf8: true }),
                readOnly: resource.access === "read_only",
                baseline: /* @__PURE__ */ new Map(),
                refusedShas: /* @__PURE__ */ new Map(),
                pendingDeletes: /* @__PURE__ */ new Map()
              };
              if (!store2.files.root().removedOnDispose) {
                throw new SessionMemoryError(`something already exists at the memory store's path: ${root} (memory_store_id=${resource.memory_store_id}); it must not exist when the session starts`);
              }
              try {
                await store2.files.createRoot();
              } catch (e) {
                if (!isErrno(e))
                  throw e;
                throw new SessionMemoryError(`cannot create the memory store's folder: ${root} (memory_store_id=${resource.memory_store_id}): ${e}; the worker host must make this mount path writable`, e);
              }
              await __classPrivateFieldGet(this, _SessionMemoryStores_instances, "m", _SessionMemoryStores_stampAndPull).call(this, store2);
              __classPrivateFieldGet(this, _SessionMemoryStores_log, "f").info("downloaded memories", {
                count: store2.baseline.size,
                memory_store_id: store2.memoryStoreId,
                dest: store2.files.root().path
              });
              __classPrivateFieldGet(this, _SessionMemoryStores_stores, "f").push(store2);
            } catch (e) {
              if (store2)
                await store2.files.dispose().catch(() => {
                });
              if (e instanceof SessionMemoryError)
                throw e;
              throw new SessionMemoryError(`failed to download memory store memory_store_id=${resource.memory_store_id}: ${e}`, e);
            }
          }
          __classPrivateFieldSet(this, _SessionMemoryStores_lastSyncAt, Date.now(), "f");
        }
        /**
         * The session's last sync — skips the delete wait, so calling it twice
         * would undo the protection; it throws instead.
         */
        async finish() {
          if (__classPrivateFieldGet(this, _SessionMemoryStores_finished, "f")) {
            throw new AnthropicError("finish() was already called: it is the session's last sync and runs once");
          }
          __classPrivateFieldSet(this, _SessionMemoryStores_finished, true, "f");
          await this.syncAll(true);
        }
        /** @internal — reconcile every store once; the tests' deterministic driver */
        async syncAll(final) {
          await Promise.all(__classPrivateFieldGet(this, _SessionMemoryStores_stores, "f").map((store2) => __classPrivateFieldGet(this, _SessionMemoryStores_instances, "m", _SessionMemoryStores_syncStore).call(this, store2, final)));
          __classPrivateFieldSet(this, _SessionMemoryStores_lastSyncAt, Date.now(), "f");
        }
        /** Sync when `syncIntervalMs` has elapsed since the last one. Never throws. */
        async syncIfDue() {
          if (Date.now() - __classPrivateFieldGet(this, _SessionMemoryStores_lastSyncAt, "f") < __classPrivateFieldGet(this, _SessionMemoryStores_syncIntervalMs, "f"))
            return;
          await this.syncAll(false);
        }
        /**
         * Upload new and changed files; send no deletes and pull nothing.
         *
         * The push-only rescue pass for a session ending on an error or
         * cancel — best-effort, bounded by the caller: once `signal` aborts no
         * further upload starts, each store cut off part-way logs how many
         * changed files it had not finished uploading, and this resolves without
         * waiting for requests already in flight. Each store uploads up to
         * {@link UPLOAD_CONCURRENCY} files at a time. Skips read-only stores,
         * refused files, files the server already holds, and folders that fail
         * the marker check. Never throws.
         */
        async flushWrites(signal) {
          await Promise.all(__classPrivateFieldGet(this, _SessionMemoryStores_stores, "f").map((store2) => __classPrivateFieldGet(this, _SessionMemoryStores_instances, "m", _SessionMemoryStores_flushStore).call(this, store2, signal)));
        }
        /**
         * Remove every store directory that {@link SessionMemoryStores.download}
         * created. Pre-existing directories are left alone — that is
         * {@link FileStore.dispose}'s own rule. A folder that fails the marker
         * check is kept too — sync left it as found, so must dispose.
         */
        async dispose() {
          for (const store2 of __classPrivateFieldGet(this, _SessionMemoryStores_stores, "f")) {
            const root = store2.files.root();
            try {
              const scan = await __classPrivateFieldGet(this, _SessionMemoryStores_instances, "m", _SessionMemoryStores_scanMarker).call(this, store2);
              if (!scan.markerOk && Object.keys(scan.files).length > 0) {
                __classPrivateFieldGet(this, _SessionMemoryStores_log, "f").warn(`${scan.distrustReason}; leaving the memory store folder on disk`, {
                  root: root.path,
                  memory_store_id: store2.memoryStoreId
                });
                continue;
              }
              await store2.files.dispose();
            } catch (e) {
              if (!(e instanceof FileStoreError) && !isErrno(e))
                throw e;
              __classPrivateFieldGet(this, _SessionMemoryStores_log, "f").warn("failed to remove the memory store folder", {
                root: store2.files.root().path,
                memory_store_id: store2.memoryStoreId,
                error: String(e)
              });
              continue;
            }
            if (root.removedOnDispose) {
              __classPrivateFieldGet(this, _SessionMemoryStores_log, "f").info("removed memory store dir", {
                dest: root.path,
                memory_store_id: store2.memoryStoreId
              });
            }
          }
        }
      }
      _SessionMemoryStores_client = /* @__PURE__ */ new WeakMap(), _SessionMemoryStores_workdir = /* @__PURE__ */ new WeakMap(), _SessionMemoryStores_syncIntervalMs = /* @__PURE__ */ new WeakMap(), _SessionMemoryStores_syncDeletions = /* @__PURE__ */ new WeakMap(), _SessionMemoryStores_log = /* @__PURE__ */ new WeakMap(), _SessionMemoryStores_lastSyncAt = /* @__PURE__ */ new WeakMap(), _SessionMemoryStores_finished = /* @__PURE__ */ new WeakMap(), _SessionMemoryStores_stores = /* @__PURE__ */ new WeakMap(), _SessionMemoryStores_instances = /* @__PURE__ */ new WeakSet(), _SessionMemoryStores_storeRoot = function _SessionMemoryStores_storeRoot2(resource) {
        if (resource.mount_path) {
          if (!isPathLegal(resource.mount_path)) {
            throw new SessionMemoryError(`memory store mount_path is not a clean absolute path: ${JSON.stringify(resource.mount_path)} (memory_store_id=${resource.memory_store_id})`);
          }
          return resource.mount_path;
        }
        return path2.join(__classPrivateFieldGet(this, _SessionMemoryStores_workdir, "f"), "memory", resource.name || resource.memory_store_id);
      }, _SessionMemoryStores_scanMarker = async function _SessionMemoryStores_scanMarker2(store2) {
        const local = await store2.files.hashtree();
        const marker = local[MARKER_PATH];
        delete local[MARKER_PATH];
        if (marker === markerSha(store2.memoryStoreId)) {
          return { files: local, markerOk: true, distrustReason: null };
        }
        return {
          files: local,
          markerOk: false,
          distrustReason: marker !== void 0 ? "the marker file does not match this store" : "the marker file is gone"
        };
      }, _SessionMemoryStores_syncStore = async function _SessionMemoryStores_syncStore2(store2, final) {
        try {
          const scan = await __classPrivateFieldGet(this, _SessionMemoryStores_instances, "m", _SessionMemoryStores_scanMarker).call(this, store2);
          const local = scan.files;
          if (!scan.markerOk) {
            if (Object.keys(local).length > 0) {
              __classPrivateFieldGet(this, _SessionMemoryStores_log, "f").warn(`${scan.distrustReason}; leaving the memory store folder as found and not syncing`, {
                root: store2.files.root().path,
                memory_store_id: store2.memoryStoreId
              });
              return;
            }
            await __classPrivateFieldGet(this, _SessionMemoryStores_instances, "m", _SessionMemoryStores_recover).call(this, store2, "the folder or its marker is gone");
            return;
          }
          if (Object.keys(local).length === 0 && store2.baseline.size > 1) {
            await __classPrivateFieldGet(this, _SessionMemoryStores_instances, "m", _SessionMemoryStores_recover).call(this, store2, "every memory file is gone at once");
            return;
          }
          const remote = /* @__PURE__ */ new Map();
          for await (const [rel, item] of __classPrivateFieldGet(this, _SessionMemoryStores_instances, "m", _SessionMemoryStores_listMemories).call(this, store2.memoryStoreId)) {
            remote.set(rel, item);
          }
          const deletes = new DeletePass(__classPrivateFieldGet(this, _SessionMemoryStores_syncDeletions, "f"), Math.max(DELETE_CAP_FLOOR, Math.min(DELETE_CAP_CEILING, Math.floor(store2.baseline.size / 4))), final);
          const pulls = [];
          const baseline = /* @__PURE__ */ new Map();
          const paths = [.../* @__PURE__ */ new Set([...remote.keys(), ...Object.keys(local), ...store2.baseline.keys()])].sort();
          for (const rel of paths) {
            const remoteItem = remote.get(rel);
            const localSha = local[rel];
            const baseSha = store2.baseline.get(rel);
            let sha;
            if (localSha === void 0 && baseSha !== void 0 && remoteItem !== void 0 && remoteItem.content_sha256 === baseSha && !store2.readOnly) {
              sha = await __classPrivateFieldGet(this, _SessionMemoryStores_instances, "m", _SessionMemoryStores_corroboratedDelete).call(this, store2, rel, remoteItem, baseSha, deletes);
            } else {
              sha = await __classPrivateFieldGet(this, _SessionMemoryStores_instances, "m", _SessionMemoryStores_syncPath).call(this, store2, rel, remoteItem, localSha, pulls);
            }
            if (sha !== void 0)
              baseline.set(rel, sha);
          }
          store2.baseline = baseline;
          await __classPrivateFieldGet(this, _SessionMemoryStores_instances, "m", _SessionMemoryStores_pullAll).call(this, store2, pulls);
          if (deletes.suppressed > 0) {
            __classPrivateFieldGet(this, _SessionMemoryStores_log, "f").debug("remote deletes are disabled; locally deleted memories stay on the server", {
              count: deletes.suppressed,
              memory_store_id: store2.memoryStoreId
            });
          }
          if (deletes.capped > 0) {
            __classPrivateFieldGet(this, _SessionMemoryStores_log, "f").warn(`delete cap reached: ${deletes.mode === "log_only" ? "would send" : "sent"} ${deletes.attempted} deletes, held ${deletes.capped} for later syncs`, { memory_store_id: store2.memoryStoreId });
          }
        } catch (e) {
          __classPrivateFieldGet(this, _SessionMemoryStores_log, "f").warn("memory sync failed", { memory_store_id: store2.memoryStoreId, error: String(e) });
        }
      }, _SessionMemoryStores_flushStore = async function _SessionMemoryStores_flushStore2(store2, signal) {
        const dirty = /* @__PURE__ */ new Map();
        const unsent = /* @__PURE__ */ new Set();
        const push = async () => {
          if (store2.readOnly)
            return;
          const scan = await __classPrivateFieldGet(this, _SessionMemoryStores_instances, "m", _SessionMemoryStores_scanMarker).call(this, store2);
          if (!scan.markerOk) {
            __classPrivateFieldGet(this, _SessionMemoryStores_log, "f").warn(`${scan.distrustReason}; not uploading anything from the memory store folder`, {
              root: store2.files.root().path,
              memory_store_id: store2.memoryStoreId
            });
            return;
          }
          for (const [rel, sha] of Object.entries(scan.files)) {
            if (sha !== store2.baseline.get(rel) && store2.refusedShas.get(rel) !== sha) {
              dirty.set(rel, sha);
              unsent.add(rel);
            }
          }
          if (dirty.size === 0 || signal?.aborted)
            return;
          const remote = /* @__PURE__ */ new Map();
          for await (const [rel, item] of __classPrivateFieldGet(this, _SessionMemoryStores_instances, "m", _SessionMemoryStores_listMemories).call(this, store2.memoryStoreId)) {
            if (signal?.aborted)
              return;
            remote.set(rel, item);
          }
          const uploads = [];
          for (const rel of [...dirty.keys()].sort()) {
            const localSha = dirty.get(rel);
            const baseSha = store2.baseline.get(rel);
            const existing = remote.get(rel);
            if (existing !== void 0 && existing.content_sha256 === localSha) {
              store2.baseline.set(rel, existing.content_sha256);
              unsent.delete(rel);
              continue;
            }
            if (existing !== void 0 && existing.content_sha256 !== baseSha) {
              __classPrivateFieldGet(this, _SessionMemoryStores_log, "f").warn("memory changed both locally and remotely; the flush leaves the remote version", {
                path: rel,
                memory_store_id: store2.memoryStoreId
              });
              unsent.delete(rel);
              continue;
            }
            uploads.push([rel, localSha, existing]);
          }
          await __classPrivateFieldGet(this, _SessionMemoryStores_instances, "m", _SessionMemoryStores_uploadAll).call(this, store2, uploads, unsent, signal);
        };
        try {
          await settledOrAborted(push(), signal);
          if (signal?.aborted && unsent.size > 0) {
            __classPrivateFieldGet(this, _SessionMemoryStores_log, "f").warn(`memory flush cut off part-way; ${unsent.size} of ${dirty.size} changed files had not finished uploading`, { memory_store_id: store2.memoryStoreId });
          }
        } catch (e) {
          __classPrivateFieldGet(this, _SessionMemoryStores_log, "f").warn("memory flush failed", { memory_store_id: store2.memoryStoreId, error: String(e) });
        }
      }, _SessionMemoryStores_recover = /** Rebuild a destroyed folder from the server; sends no deletes, no uploads. */
      async function _SessionMemoryStores_recover2(store2, reason) {
        __classPrivateFieldGet(this, _SessionMemoryStores_log, "f").warn(`${reason}; re-downloading the memory store folder instead of syncing`, {
          root: store2.files.root().path,
          memory_store_id: store2.memoryStoreId
        });
        await store2.files.createRoot();
        await __classPrivateFieldGet(this, _SessionMemoryStores_instances, "m", _SessionMemoryStores_stampAndPull).call(this, store2);
      }, _SessionMemoryStores_stampAndPull = /**
       * Write the marker, then pull every remote memory. Baseline is cleared
       * first so a failed write never leaves an entry whose file is not on disk.
       * Every memory is needed here, so the listing carries the content — pages
       * cost far fewer round-trips than a request per memory.
       */
      async function _SessionMemoryStores_stampAndPull2(store2) {
        store2.baseline = /* @__PURE__ */ new Map();
        store2.pendingDeletes.clear();
        await store2.files.put(MARKER_PATH, `version ${MARKER_VERSION}
${store2.memoryStoreId}`);
        for await (const [rel, item] of __classPrivateFieldGet(this, _SessionMemoryStores_instances, "m", _SessionMemoryStores_listMemories).call(this, store2.memoryStoreId, "full")) {
          if (await __classPrivateFieldGet(this, _SessionMemoryStores_instances, "m", _SessionMemoryStores_write).call(this, store2, rel, item.content ?? "")) {
            store2.baseline.set(rel, item.content_sha256);
          }
        }
      }, _SessionMemoryStores_syncPath = /**
       * Reconcile one path. Returns the sha to record in the baseline, or
       * `undefined` to drop the path from it.
       *
       * `pulls` is an output: when the remote version should be written to disk,
       * this appends `[rel, remote]` to it instead of writing — `rel` is the
       * file to write, `remote` the listed memory whose content `#pullAll` will
       * fetch and write there.
       */
      async function _SessionMemoryStores_syncPath2(store2, rel, remote, localSha, pulls) {
        const baseSha = store2.baseline.get(rel);
        if (localSha !== void 0) {
          store2.pendingDeletes.delete(rel);
        }
        if (!remote) {
          if (localSha === void 0) {
            store2.pendingDeletes.delete(rel);
            return void 0;
          }
          if (baseSha !== void 0) {
            if (localSha === baseSha) {
              const fresh = await __classPrivateFieldGet(this, _SessionMemoryStores_instances, "m", _SessionMemoryStores_removeLocal).call(this, store2, rel, baseSha);
              if (fresh === void 0)
                return void 0;
              if (fresh === baseSha)
                return baseSha;
              localSha = fresh;
            }
            if (store2.readOnly) {
              __classPrivateFieldGet(this, _SessionMemoryStores_log, "f").warn("memory deleted remotely but edited locally; keeping the file, which a read-only store cannot push", { path: rel, memory_store_id: store2.memoryStoreId });
            } else if (store2.refusedShas.get(rel) !== localSha) {
              __classPrivateFieldGet(this, _SessionMemoryStores_log, "f").info("memory deleted remotely but edited locally; re-creating it from the file", {
                path: rel,
                memory_store_id: store2.memoryStoreId
              });
            }
          }
          if (store2.readOnly)
            return void 0;
          if (store2.refusedShas.get(rel) === localSha)
            return void 0;
          return await __classPrivateFieldGet(this, _SessionMemoryStores_instances, "m", _SessionMemoryStores_upload).call(this, store2, rel, localSha, void 0);
        }
        const remoteSha = remote.content_sha256;
        const remoteChanged = remoteSha !== baseSha;
        const locallyEdited = localSha !== void 0 && localSha !== baseSha && localSha !== remoteSha;
        const localChanged = !store2.readOnly && locallyEdited;
        if (localSha === void 0 && baseSha !== void 0) {
          if (remoteChanged) {
            __classPrivateFieldGet(this, _SessionMemoryStores_log, "f").warn("memory deleted locally but changed remotely; restoring the remote version", {
              path: rel,
              memory_store_id: store2.memoryStoreId
            });
            store2.pendingDeletes.delete(rel);
            pulls.push([rel, remote]);
          }
          return baseSha;
        }
        if (remoteChanged) {
          if (localSha === remoteSha)
            return remoteSha;
          if (locallyEdited) {
            __classPrivateFieldGet(this, _SessionMemoryStores_log, "f").warn("memory changed both locally and remotely; keeping the remote version", {
              path: rel,
              memory_store_id: store2.memoryStoreId
            });
          }
          pulls.push([rel, remote]);
          return baseSha;
        }
        if (localChanged) {
          if (store2.refusedShas.get(rel) === localSha)
            return remoteSha;
          return await __classPrivateFieldGet(this, _SessionMemoryStores_instances, "m", _SessionMemoryStores_upload).call(this, store2, rel, localSha, remote) ?? remoteSha;
        }
        return remoteSha;
      }, _SessionMemoryStores_removeLocal = /**
       * Remove the file for a memory the server no longer has, if it still holds
       * `expectSha`. Returns `undefined` when the file is gone from disk,
       * `expectSha` when it must stay in the baseline (I/O error), or the file's
       * fresh sha when it was edited since the scan.
       */
      async function _SessionMemoryStores_removeLocal2(store2, rel, expectSha) {
        let freshSha;
        try {
          freshSha = await store2.files.hashFile(rel);
        } catch (e) {
          if (!(e instanceof FileStoreError) && !isErrno(e))
            throw e;
          return expectSha;
        }
        if (freshSha === null)
          return void 0;
        if (freshSha !== expectSha)
          return freshSha;
        try {
          await store2.files.remove(rel);
        } catch (e) {
          if (!(e instanceof FileStoreError) && !isErrno(e))
            throw e;
          __classPrivateFieldGet(this, _SessionMemoryStores_log, "f").warn("failed to remove memory deleted remotely", {
            path: rel,
            memory_store_id: store2.memoryStoreId,
            error: String(e)
          });
          return expectSha;
        }
        return void 0;
      }, _SessionMemoryStores_write = /**
       * Write a memory's content to disk; `false` (and a warning) on failure.
       *
       * A `..` component in the wire path reaches here as {@link FileStoreError} —
       * that is the escape guard.
       */
      async function _SessionMemoryStores_write2(store2, rel, content) {
        try {
          await store2.files.put(rel, content);
        } catch (e) {
          if (!(e instanceof FileStoreError) && !isErrno(e))
            throw e;
          __classPrivateFieldGet(this, _SessionMemoryStores_log, "f").warn("failed to write memory", {
            path: rel,
            memory_store_id: store2.memoryStoreId,
            error: String(e)
          });
          return false;
        }
        return true;
      }, _SessionMemoryStores_pullAll = /**
       * Fetch and write the given memories, {@link FETCH_CONCURRENCY} at a time.
       *
       * The sync's content pass: the listing carried no content, so each memory
       * is fetched individually and written as it arrives. On success the path's
       * baseline advances; on a failed fetch or write the old entry stays and the
       * next sync retries. A 404 means the memory was deleted after the listing —
       * the next sync reconciles it.
       */
      async function _SessionMemoryStores_pullAll2(store2, pulls) {
        if (pulls.length === 0)
          return;
        const pullOne = async (rel, listed) => {
          let item;
          try {
            item = await __classPrivateFieldGet(this, _SessionMemoryStores_client, "f").beta.memoryStores.memories.retrieve(listed.id, {
              memory_store_id: store2.memoryStoreId,
              view: "full"
            });
          } catch (e) {
            if (isStatus(e, 404))
              return;
            __classPrivateFieldGet(this, _SessionMemoryStores_log, "f").warn("failed to fetch memory content", {
              path: rel,
              memory_store_id: store2.memoryStoreId,
              error: String(e)
            });
            return;
          }
          if (await __classPrivateFieldGet(this, _SessionMemoryStores_instances, "m", _SessionMemoryStores_write).call(this, store2, rel, item.content ?? "")) {
            store2.baseline.set(rel, item.content_sha256);
          }
        };
        const queue2 = pulls[Symbol.iterator]();
        const worker = async () => {
          for (const [rel, listed] of queue2)
            await pullOne(rel, listed);
        };
        await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, pulls.length) }, worker));
      }, _SessionMemoryStores_uploadAll = /**
       * Upload the given files, {@link UPLOAD_CONCURRENCY} at a time, taking each
       * path off `unsent` as its upload returns. No upload starts once `signal`
       * aborts; the ones already in flight run to completion.
       */
      async function _SessionMemoryStores_uploadAll2(store2, uploads, unsent, signal) {
        const queue2 = uploads[Symbol.iterator]();
        const worker = async () => {
          for (const [rel, localSha, existing] of queue2) {
            if (signal?.aborted)
              return;
            const sha = await __classPrivateFieldGet(this, _SessionMemoryStores_instances, "m", _SessionMemoryStores_upload).call(this, store2, rel, localSha, existing);
            unsent.delete(rel);
            if (sha !== void 0)
              store2.baseline.set(rel, sha);
          }
        };
        await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, uploads.length) }, worker));
      }, _SessionMemoryStores_listMemories = /**
       * The store's memories keyed by relative path (the wire path's leading `/`
       * stripped — `#upload` re-prefixes it) — `basic` view (shas, no content) at
       * {@link LIST_PAGE_SIZE} per page unless the caller needs `full` pages.
       * `memory_prefix` rollups and the reserved marker path are skipped.
       */
      async function* _SessionMemoryStores_listMemories2(memoryStoreId, view2 = "basic") {
        const limit2 = view2 === "basic" ? LIST_PAGE_SIZE : FULL_LIST_PAGE_SIZE;
        for await (const item of __classPrivateFieldGet(this, _SessionMemoryStores_client, "f").beta.memoryStores.memories.list(memoryStoreId, { view: view2, limit: limit2 })) {
          if (item.type !== "memory")
            continue;
          const rel = item.path.replace(/^\/+/, "");
          if (rel === MARKER_PATH) {
            __classPrivateFieldGet(this, _SessionMemoryStores_log, "f").warn("the server listed the reserved marker path; skipping", {
              path: item.path,
              memory_store_id: memoryStoreId
            });
            continue;
          }
          yield [rel, item];
        }
      }, _SessionMemoryStores_upload = /**
       * Push one local file; `undefined` keeps the old baseline so the next pass retries.
       *
       * A refusal the server would repeat (400/413, the utf-8 gate) enters
       * `refusedShas`: warned once, retried only after the file changes.
       */
      async function _SessionMemoryStores_upload2(store2, rel, localSha, existing) {
        try {
          const data = await store2.files.get(rel);
          if (data === null)
            return void 0;
          const content = decodeUTF8(data);
          const item = existing ? await __classPrivateFieldGet(this, _SessionMemoryStores_client, "f").beta.memoryStores.memories.update(existing.id, {
            memory_store_id: store2.memoryStoreId,
            content,
            precondition: { type: "content_sha256", content_sha256: existing.content_sha256 }
          }) : await __classPrivateFieldGet(this, _SessionMemoryStores_client, "f").beta.memoryStores.memories.create(store2.memoryStoreId, {
            path: "/" + rel,
            content
          });
          store2.refusedShas.delete(rel);
          return item.content_sha256;
        } catch (e) {
          if (existing && isStatus(e, 404)) {
            return await __classPrivateFieldGet(this, _SessionMemoryStores_instances, "m", _SessionMemoryStores_upload2).call(this, store2, rel, localSha, void 0);
          }
          const permanent = e instanceof FileStoreError || isStatus(e, 400) || isStatus(e, 413);
          if (existing && isStatus(e, 409)) {
            __classPrivateFieldGet(this, _SessionMemoryStores_log, "f").warn("memory changed both locally and remotely; the upload was refused and the local edit loses", {
              path: rel,
              memory_store_id: store2.memoryStoreId
            });
          } else if (permanent && localSha !== void 0) {
            store2.refusedShas.set(rel, localSha);
            __classPrivateFieldGet(this, _SessionMemoryStores_log, "f").warn("the server rejected this memory file, so it stays un-synced until its content changes", { path: rel, memory_store_id: store2.memoryStoreId, rejection: String(e) });
          } else {
            __classPrivateFieldGet(this, _SessionMemoryStores_log, "f").warn("failed to upload memory", {
              path: rel,
              memory_store_id: store2.memoryStoreId,
              error: String(e)
            });
          }
          return void 0;
        }
      }, _SessionMemoryStores_corroboratedDelete = /** Send the server delete only after the wait, the cap, and a fresh re-check all clear. */
      async function _SessionMemoryStores_corroboratedDelete2(store2, rel, remote, baseSha, deletes) {
        if (deletes.mode === "disabled") {
          deletes.suppressed++;
          return baseSha;
        }
        let firstAbsent = store2.pendingDeletes.get(rel);
        if (firstAbsent === void 0) {
          firstAbsent = Date.now();
          store2.pendingDeletes.set(rel, firstAbsent);
        }
        if (!deletes.waiveWindow && Date.now() - firstAbsent < DELETE_CORROBORATION_MS) {
          return baseSha;
        }
        let markerOk;
        let stillAbsent;
        try {
          markerOk = await store2.files.hashFile(MARKER_PATH) === markerSha(store2.memoryStoreId);
          stillAbsent = await store2.files.hashFile(rel) === null;
        } catch (e) {
          if (!(e instanceof FileStoreError) && !isErrno(e))
            throw e;
          markerOk = stillAbsent = false;
        }
        if (!markerOk)
          return baseSha;
        if (!stillAbsent) {
          store2.pendingDeletes.delete(rel);
          return baseSha;
        }
        if (!deletes.takeSlot())
          return baseSha;
        if (deletes.mode === "log_only") {
          __classPrivateFieldGet(this, _SessionMemoryStores_log, "f").info("log-only: sync would delete this memory on the server", {
            path: rel,
            memory_store_id: store2.memoryStoreId
          });
          return baseSha;
        }
        const sha = await __classPrivateFieldGet(this, _SessionMemoryStores_instances, "m", _SessionMemoryStores_deleteRemote).call(this, store2, rel, remote, baseSha);
        if (sha === void 0) {
          store2.pendingDeletes.delete(rel);
        }
        return sha;
      }, _SessionMemoryStores_deleteRemote = async function _SessionMemoryStores_deleteRemote2(store2, rel, remote, baseSha) {
        try {
          await __classPrivateFieldGet(this, _SessionMemoryStores_client, "f").beta.memoryStores.memories.delete(remote.id, {
            memory_store_id: store2.memoryStoreId,
            expected_content_sha256: baseSha
          });
        } catch (e) {
          if (isStatus(e, 404))
            return void 0;
          if (isStatus(e, 409) || isStatus(e, 412)) {
            __classPrivateFieldGet(this, _SessionMemoryStores_log, "f").warn("memory deleted locally but changed remotely; keeping the remote version", {
              path: rel,
              memory_store_id: store2.memoryStoreId
            });
          } else {
            __classPrivateFieldGet(this, _SessionMemoryStores_log, "f").warn("failed to delete memory", {
              path: rel,
              memory_store_id: store2.memoryStoreId,
              error: String(e)
            });
          }
          return baseSha;
        }
        __classPrivateFieldGet(this, _SessionMemoryStores_log, "f").info("propagated local deletion", { path: rel, memory_store_id: store2.memoryStoreId });
        return void 0;
      };
      return SessionMemoryStores2;
    })();
  }
});

// node_modules/@anthropic-ai/sdk/tools/agent-toolset/node.mjs
var node_exports2 = {};
__export(node_exports2, {
  BashSession: () => BashSession,
  BashTimeoutError: () => BashTimeoutError,
  DEFAULT_MEMORY_SYNC_INTERVAL_MS: () => DEFAULT_MEMORY_SYNC_INTERVAL_MS,
  MARKER_PATH: () => MARKER_PATH,
  MEMORY_FLUSH_TIMEOUT_MS: () => MEMORY_FLUSH_TIMEOUT_MS,
  MIN_MEMORY_SYNC_INTERVAL_MS: () => MIN_MEMORY_SYNC_INTERVAL_MS,
  SessionMemoryError: () => SessionMemoryError,
  SessionMemoryStores: () => SessionMemoryStores,
  betaAgentToolset20260401: () => betaAgentToolset20260401,
  betaBashTool: () => betaBashTool,
  betaEditTool: () => betaEditTool,
  betaGlobTool: () => betaGlobTool,
  betaGrepTool: () => betaGrepTool,
  betaReadTool: () => betaReadTool,
  betaWriteTool: () => betaWriteTool,
  extractSkillArchive: () => extractSkillArchive,
  resolvePath: () => resolvePath,
  setupSkills: () => setupSkills
});
import * as fs5 from "node:fs/promises";
import * as fssync from "node:fs";
import * as path4 from "node:path";
import * as cp from "node:child_process";
import * as crypto3 from "node:crypto";
import * as readline from "node:readline";
function resolveMaxBytes(configured) {
  return configured === void 0 ? DEFAULT_MAX_FILE_BYTES : configured;
}
function rejectUnrestrictedPaths(value) {
  if (value === void 0)
    return;
  throw new AnthropicError("The `unrestrictedPaths` option you passed to the agent toolset (AgentToolContext) is no longer supported. The toolset's file tools (read, write, edit, glob, grep) are now always confined to the working directory plus the directories listed in `allowedRoots`. Remove `unrestrictedPaths` from your context; to let the file tools reach any other directory, add it to `allowedRoots`.");
}
function betaAgentToolset20260401(ctx) {
  return [
    betaBashTool(ctx),
    betaReadTool(ctx),
    betaWriteTool(ctx),
    betaEditTool(ctx),
    betaGlobTool(ctx),
    betaGrepTool(ctx)
  ];
}
async function resolvePath(ctx, p) {
  rejectUnrestrictedPaths(ctx.unrestrictedPaths);
  return confineToRoot(ctx.workdir, p, { allowedRoots: ctx.allowedRoots ?? [] });
}
function readOnlyRootFor(ctx, target) {
  return containingRoot(ctx.readOnlyRoots ?? [], target);
}
function scrubbedShellEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("ANTHROPIC_"))
      continue;
    env[key] = value;
  }
  return env;
}
function betaBashTool(ctx) {
  rejectUnrestrictedPaths(ctx.unrestrictedPaths);
  let session;
  let tail = Promise.resolve();
  return betaTool({
    name: "bash",
    description: "Run a bash command in a persistent shell. State (cwd, env vars) persists across calls.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run" },
        restart: { type: "boolean", description: "Restart the persistent shell before running" },
        timeout_ms: { type: "integer", description: "Per-call timeout in milliseconds" }
      }
    },
    run: async ({ command: command2, restart, timeout_ms }, context) => {
      const prev = tail;
      const gate = promiseWithResolvers();
      tail = gate.promise;
      try {
        await prev;
      } catch {
      }
      try {
        if (restart) {
          session?.close();
          session = void 0;
        }
        if (!command2) {
          if (restart)
            return "bash session restarted";
          throw new ToolError("bash: command is required");
        }
        session ?? (session = new BashSession(ctx.workdir, ctx.env));
        try {
          const { output, exitCode } = await session.exec(command2, {
            timeoutMs: timeout_ms ?? BASH_DEFAULT_TIMEOUT_MS,
            signal: context?.signal
          });
          if (exitCode !== 0)
            throw new ToolError(output || `exit ${exitCode}`);
          return output;
        } catch (e) {
          if (e instanceof ToolError)
            throw e;
          session.close();
          session = void 0;
          throw new ToolError(`bash: ${e instanceof Error ? e.message : String(e)}`);
        }
      } finally {
        gate.resolve();
      }
    },
    close: () => {
      session?.close();
      session = void 0;
    }
  });
}
function betaReadTool(ctx) {
  rejectUnrestrictedPaths(ctx.unrestrictedPaths);
  return betaTool({
    name: "read",
    description: "Read a UTF-8 text file relative to the workdir.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        view_range: {
          type: "array",
          items: { type: "integer" },
          description: "[start_line, end_line] 1-indexed inclusive"
        }
      },
      required: ["file_path"]
    },
    run: async ({ file_path, view_range }) => {
      if (!file_path)
        throw new ToolError("read: file_path is required");
      const abs = await resolvePath(ctx, file_path);
      if (view_range?.length && view_range.length !== 2) {
        throw new ToolError("read: view_range must be [start_line, end_line]");
      }
      let data;
      try {
        const st2 = await fs5.stat(abs);
        if (!st2.isFile()) {
          throw new ToolError(`read: ${file_path} is not a regular file`);
        }
        const limit2 = resolveMaxBytes(ctx.maxFileBytes);
        if (limit2 !== null && st2.size > limit2) {
          if (!view_range?.length) {
            throw new ToolError(`read: ${file_path} is ${st2.size} bytes, exceeds ${limit2}-byte limit. Use the view_range parameter to read specific line ranges, e.g. view_range: [1, 500].`);
          }
          const [startLine2, endLine2] = view_range;
          return await readRangeStreaming(abs, file_path, startLine2, endLine2, limit2);
        }
        data = await fs5.readFile(abs, "utf8");
      } catch (e) {
        if (e instanceof ToolError)
          throw e;
        throw new ToolError(`read: ${fsErrorMessage(e, file_path)}`);
      }
      if (!view_range?.length)
        return data;
      const [startLine, endLine] = view_range;
      const lines = data.split("\n");
      const start = Math.max(0, startLine - 1);
      const end = endLine > 0 ? endLine : lines.length;
      return lines.slice(start, end).join("\n");
    }
  });
}
async function readRangeStreaming(abs, filePath, startLine, endLine, limit2) {
  const lines = new LineRangeCollector(filePath, startLine, endLine, limit2);
  if (lines.rangeIsEmpty())
    return "";
  const stream2 = fssync.createReadStream(abs, { highWaterMark: READ_STREAM_CHUNK_BYTES });
  try {
    for await (const chunk of stream2) {
      lines.collectFrom(chunk);
      if (lines.rangeIsCollected())
        break;
    }
  } finally {
    stream2.destroy();
  }
  return lines.text();
}
function betaWriteTool(ctx) {
  rejectUnrestrictedPaths(ctx.unrestrictedPaths);
  return betaTool({
    name: "write",
    description: "Write a UTF-8 text file relative to the workdir, creating parent directories as needed.",
    inputSchema: {
      type: "object",
      properties: { file_path: { type: "string" }, content: { type: "string" } },
      required: ["file_path", "content"]
    },
    run: async ({ file_path, content }) => {
      if (!file_path)
        throw new ToolError("write: file_path is required");
      const abs = await resolvePath(ctx, file_path);
      const ro = await readOnlyRootFor(ctx, abs);
      if (ro !== void 0) {
        throw new ToolError(`write: ${file_path} is inside read-only directory ${ro}`);
      }
      try {
        await fs5.mkdir(path4.dirname(abs), { recursive: true, mode: DIR_CREATE_MODE });
        await atomicWriteFile(abs, content ?? "");
      } catch (e) {
        throw new ToolError(`write: ${fsErrorMessage(e, file_path)}`);
      }
      return `wrote ${Buffer.byteLength(content ?? "")} bytes to ${file_path}`;
    }
  });
}
function betaEditTool(ctx) {
  rejectUnrestrictedPaths(ctx.unrestrictedPaths);
  return betaTool({
    name: "edit",
    description: "Replace old_string with new_string in a file. old_string must be unique unless replace_all.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" }
      },
      required: ["file_path", "old_string", "new_string"]
    },
    run: async ({ file_path, old_string, new_string, replace_all }) => {
      if (!file_path)
        throw new ToolError("edit: file_path is required");
      if (!old_string)
        throw new ToolError("edit: old_string is required");
      const abs = await resolvePath(ctx, file_path);
      const ro = await readOnlyRootFor(ctx, abs);
      if (ro !== void 0) {
        throw new ToolError(`edit: ${file_path} is inside read-only directory ${ro}`);
      }
      let data;
      try {
        const st2 = await fs5.stat(abs);
        if (!st2.isFile()) {
          throw new ToolError(`edit: ${file_path} is not a regular file`);
        }
        const limit2 = resolveMaxBytes(ctx.maxFileBytes);
        if (limit2 !== null && st2.size > limit2) {
          throw new ToolError(`edit: ${file_path} is ${st2.size} bytes, exceeds ${limit2}-byte limit. The edit tool loads the whole file and cannot modify a file this large.`);
        }
        data = await fs5.readFile(abs, "utf8");
      } catch (e) {
        if (e instanceof ToolError)
          throw e;
        throw new ToolError(`edit: ${fsErrorMessage(e, file_path)}`);
      }
      const count2 = data.split(old_string).length - 1;
      if (count2 === 0)
        throw new ToolError(`edit: old_string not found in ${file_path}`);
      let updated;
      if (replace_all) {
        updated = data.split(old_string).join(new_string);
      } else {
        if (count2 > 1)
          throw new ToolError(`edit: old_string appears ${count2} times in ${file_path} (must be unique)`);
        updated = data.replace(old_string, () => new_string);
      }
      try {
        await atomicWriteFile(abs, updated);
      } catch (e) {
        throw new ToolError(`edit: write: ${fsErrorMessage(e, file_path)}`);
      }
      return `edited ${file_path} (${replace_all ? count2 : 1} replacement(s))`;
    }
  });
}
function patternCanAscend(pattern) {
  return pattern.split(/[\\/{},]/).includes("..");
}
function betaGlobTool(ctx) {
  rejectUnrestrictedPaths(ctx.unrestrictedPaths);
  return betaTool({
    name: "glob",
    description: "Match files under the workdir against a glob pattern. Results are mtime-sorted, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "Directory to search in. Defaults to the workdir." }
      },
      required: ["pattern"]
    },
    run: async ({ pattern, path: searchPath }) => {
      if (!pattern)
        throw new ToolError("glob: pattern is required");
      if (path4.isAbsolute(pattern)) {
        throw new ToolError("glob: absolute pattern not permitted; pass a relative pattern (and optionally path)");
      }
      if (patternCanAscend(pattern)) {
        throw new ToolError('glob: ".." is not permitted in the pattern');
      }
      const root = searchPath ? await resolvePath(ctx, searchPath) : path4.resolve(ctx.workdir);
      const realRoot = searchPath ? root : await canonicalize(root);
      const matches = [];
      let remaining = WALK_MAX_ENTRIES;
      try {
        for await (const entry of fsGlob(pattern, {
          cwd: root,
          withFileTypes: true,
          exclude: (d) => d.name === ".git" || d.name === "node_modules"
        })) {
          if (remaining-- <= 0)
            break;
          if (!entry.isFile())
            continue;
          const full = path4.join(entry.parentPath, entry.name);
          let real;
          try {
            real = await fs5.realpath(full);
          } catch {
            continue;
          }
          if (!isWithin(realRoot, real))
            continue;
          let mtime = 0;
          try {
            mtime = (await fs5.stat(full)).mtimeMs;
          } catch {
          }
          matches.push({ path: full, mtime });
        }
      } catch (e) {
        throw new ToolError(`glob: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (matches.length === 0)
        return "no matches";
      matches.sort((a, b) => b.mtime - a.mtime);
      return matches.slice(0, GLOB_RESULT_LIMIT).map((m) => m.path).join("\n");
    }
  });
}
function betaGrepTool(ctx) {
  rejectUnrestrictedPaths(ctx.unrestrictedPaths);
  return betaTool({
    name: "grep",
    description: "Search file contents for a regex. Uses ripgrep if available, otherwise a built-in walker.",
    inputSchema: {
      type: "object",
      properties: { pattern: { type: "string" }, path: { type: "string" } },
      required: ["pattern"]
    },
    run: async ({ pattern, path: p }, context) => {
      if (!pattern)
        throw new ToolError("grep: pattern is required");
      let searchPath = path4.resolve(ctx.workdir);
      if (p)
        searchPath = await resolvePath(ctx, p);
      const rg = await findRg();
      return rg ? runRipgrep(rg, pattern, searchPath, context?.signal) : runWalkGrep(pattern, searchPath, context?.signal);
    }
  });
}
function runRipgrep(rg, pattern, searchPath, signal) {
  return new Promise((resolve2, reject) => {
    const proc = cp.spawn(rg, ["-n", "--no-heading", "-e", pattern, "--", searchPath], {
      ...signal ? { signal } : {}
    });
    let out = "";
    let errOut = "";
    let truncated = false;
    proc.stdout.on("data", (d) => {
      if (truncated)
        return;
      out += d;
      if (out.length > GREP_OUTPUT_LIMIT) {
        truncated = true;
        out = out.slice(0, GREP_OUTPUT_LIMIT);
        proc.kill("SIGKILL");
      }
    });
    proc.stderr.on("data", (d) => errOut += d);
    proc.on("close", (code) => {
      if (signal?.aborted)
        return reject(new ToolError("grep: aborted"));
      if (truncated)
        return resolve2(out + `
[output truncated at ${GREP_OUTPUT_LIMIT} bytes]`);
      if (code === 0)
        return resolve2(out);
      if (code === 1)
        return resolve2("no matches");
      reject(new ToolError(`grep: rg failed: ${errOut || `exit ${code}`}`));
    });
    proc.on("error", (e) => {
      if (signal?.aborted)
        return reject(new ToolError("grep: aborted"));
      reject(new ToolError(`grep: rg failed: ${e.message}`));
    });
  });
}
async function runWalkGrep(pattern, root, signal) {
  let re;
  try {
    re = new RegExp(pattern);
  } catch (e) {
    throw new ToolError(`grep: invalid regex: ${e instanceof Error ? e.message : String(e)}`);
  }
  const hits = [];
  let budget = GREP_OUTPUT_LIMIT;
  const push = (line) => {
    budget -= line.length + 1;
    if (budget < 0) {
      hits.push(`[output truncated at ${GREP_OUTPUT_LIMIT} bytes]`);
      return false;
    }
    hits.push(line);
    return true;
  };
  const stat2 = await fs5.stat(root).catch(() => null);
  if (stat2?.isFile()) {
    await grepFile(root, re, push);
  } else {
    await walk2(root, "", (rel) => grepFile(path4.join(root, rel), re, push), signal);
  }
  if (signal?.aborted)
    throw new ToolError("grep: aborted");
  if (hits.length === 0)
    return "no matches";
  return hits.join("\n");
}
async function grepFile(file, re, push) {
  const stream2 = fssync.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream2, crlfDelay: Infinity });
  let i = 0;
  try {
    for await (const line of rl) {
      i++;
      if (line.length > GREP_MAX_LINE_LENGTH)
        continue;
      if (re.test(line) && !push(`${file}:${i}:${line}`))
        return false;
    }
  } catch {
  } finally {
    stream2.destroy();
  }
  return true;
}
async function walk2(root, rel, fn, signal) {
  let remaining = WALK_MAX_ENTRIES;
  async function inner(rel2, depth) {
    if (depth > WALK_MAX_DEPTH)
      return true;
    if (signal?.aborted)
      return false;
    let entries;
    try {
      entries = await fs5.readdir(path4.join(root, rel2), { withFileTypes: true });
    } catch {
      return true;
    }
    for (const e of entries) {
      if (e.name === ".git" || e.name === "node_modules")
        continue;
      if (remaining-- <= 0)
        return false;
      if (signal?.aborted)
        return false;
      const childRel = rel2 ? path4.join(rel2, e.name) : e.name;
      if (e.isDirectory()) {
        if (!await inner(childRel, depth + 1))
          return false;
      } else if (e.isFile()) {
        if (await fn(childRel) === false)
          return false;
      }
    }
    return true;
  }
  await inner(rel, 0);
}
async function findRg() {
  const dirs = (process.env["PATH"] ?? "").split(path4.delimiter);
  for (const d of dirs) {
    const candidate = path4.join(d, "rg");
    try {
      await fs5.access(candidate, fssync.constants.X_OK);
      return candidate;
    } catch {
    }
  }
  return null;
}
var _BashSession_instances, _BashSession_proc, _BashSession_buf, _BashSession_truncated, _BashSession_closed, _BashSession_waiting, _BashSession_append, _LineRangeCollector_instances, _LineRangeCollector_filePath, _LineRangeCollector_startLine, _LineRangeCollector_endLine, _LineRangeCollector_start, _LineRangeCollector_end, _LineRangeCollector_limit, _LineRangeCollector_line, _LineRangeCollector_collected, _LineRangeCollector_collectedBytes, _LineRangeCollector_collect, _LineRangeCollector_overLimitError, BASH_OUTPUT_LIMIT, BASH_DEFAULT_TIMEOUT_MS, DEFAULT_MAX_FILE_BYTES, READ_STREAM_CHUNK_BYTES, NEWLINE, GREP_OUTPUT_LIMIT, GREP_MAX_LINE_LENGTH, GLOB_RESULT_LIMIT, BashTimeoutError, ANSI_RE, fsGlob, BashSession, LineRangeCollector, WALK_MAX_DEPTH, WALK_MAX_ENTRIES;
var init_node2 = __esm({
  "node_modules/@anthropic-ai/sdk/tools/agent-toolset/node.mjs"() {
    init_tslib();
    init_error();
    init_ToolError();
    init_json_schema();
    init_promise();
    init_fs_util();
    init_skills();
    init_memories();
    BASH_OUTPUT_LIMIT = 100 * 1024;
    BASH_DEFAULT_TIMEOUT_MS = 12e4;
    DEFAULT_MAX_FILE_BYTES = 256 * 1024;
    READ_STREAM_CHUNK_BYTES = 64 * 1024;
    NEWLINE = Buffer.from("\n");
    GREP_OUTPUT_LIMIT = 100 * 1024;
    GREP_MAX_LINE_LENGTH = 2e3;
    GLOB_RESULT_LIMIT = 200;
    BashTimeoutError = class extends AnthropicError {
      constructor(timeoutMs) {
        super(`bash command timed out after ${timeoutMs}ms`);
        this.name = "BashTimeoutError";
        this.timeoutMs = timeoutMs;
      }
    };
    ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
    fsGlob = fs5.glob;
    BashSession = /* @__PURE__ */ (() => {
      class BashSession2 {
        constructor(dir, env = scrubbedShellEnv()) {
          _BashSession_instances.add(this);
          _BashSession_proc.set(this, void 0);
          _BashSession_buf.set(this, "");
          _BashSession_truncated.set(this, false);
          _BashSession_closed.set(this, false);
          _BashSession_waiting.set(this, null);
          __classPrivateFieldSet(this, _BashSession_proc, cp.spawn("/bin/bash", ["--noprofile", "--norc"], {
            cwd: dir,
            // `env` is the full base environment (the scrubbed process env by
            // default, or the verbatim replacement from `AgentToolContext.env`).
            // PS1/PS2/TERM are shell-control settings BashSession always applies so
            // the pipe-based sentinel exec parsing works — not part of the
            // user-facing environment.
            env: { ...env, PS1: "", PS2: "", TERM: "dumb" },
            stdio: ["pipe", "pipe", "pipe"],
            detached: true
          }), "f");
          __classPrivateFieldGet(this, _BashSession_proc, "f").stdout.setEncoding("utf8");
          __classPrivateFieldGet(this, _BashSession_proc, "f").stderr.setEncoding("utf8");
          __classPrivateFieldGet(this, _BashSession_proc, "f").stdout.on("data", (d) => __classPrivateFieldGet(this, _BashSession_instances, "m", _BashSession_append).call(this, d));
          __classPrivateFieldGet(this, _BashSession_proc, "f").stderr.on("data", (d) => __classPrivateFieldGet(this, _BashSession_instances, "m", _BashSession_append).call(this, d));
          __classPrivateFieldGet(this, _BashSession_proc, "f").once("close", () => {
            __classPrivateFieldSet(this, _BashSession_closed, true, "f");
            const w = __classPrivateFieldGet(this, _BashSession_waiting, "f");
            __classPrivateFieldSet(this, _BashSession_waiting, null, "f");
            w?.resolve();
          });
        }
        /** Whether the underlying shell process has exited. */
        get closed() {
          return __classPrivateFieldGet(this, _BashSession_closed, "f");
        }
        async exec(command2, opts = {}) {
          if (__classPrivateFieldGet(this, _BashSession_closed, "f")) {
            throw new AnthropicError("bash session terminated");
          }
          const timeoutMs = opts.timeoutMs ?? BASH_DEFAULT_TIMEOUT_MS;
          const signal = opts.signal;
          signal?.throwIfAborted();
          __classPrivateFieldSet(this, _BashSession_buf, "", "f");
          __classPrivateFieldSet(this, _BashSession_truncated, false, "f");
          const sentinel2 = `__ANT_CMD_${crypto3.randomUUID()}_DONE__`;
          const sentinelSplit = `${sentinel2.slice(0, 8)}''${sentinel2.slice(8)}`;
          const wrapped = `{ ${command2}
} </dev/null 2>&1; printf '\\n${sentinelSplit}%d\\n' $?
`;
          __classPrivateFieldGet(this, _BashSession_proc, "f").stdin.write(wrapped);
          if (__classPrivateFieldGet(this, _BashSession_buf, "f").indexOf(sentinel2) < 0) {
            const { promise: sentinelSeen, resolve: resolve2 } = promiseWithResolvers();
            __classPrivateFieldSet(this, _BashSession_waiting, { sentinel: sentinel2, resolve: resolve2 }, "f");
            let timer;
            let onAbort;
            try {
              await Promise.race([
                sentinelSeen,
                new Promise((_, reject) => {
                  timer = setTimeout(() => reject(new BashTimeoutError(timeoutMs)), timeoutMs);
                }),
                new Promise((_, reject) => {
                  if (!signal)
                    return;
                  onAbort = () => reject(signal.reason);
                  signal.addEventListener("abort", onAbort, { once: true });
                })
              ]);
            } finally {
              if (timer)
                clearTimeout(timer);
              if (onAbort && signal)
                signal.removeEventListener("abort", onAbort);
              __classPrivateFieldSet(this, _BashSession_waiting, null, "f");
            }
          }
          const idx = __classPrivateFieldGet(this, _BashSession_buf, "f").indexOf(sentinel2);
          if (idx < 0) {
            throw new AnthropicError("bash session terminated");
          }
          const tail = __classPrivateFieldGet(this, _BashSession_buf, "f").slice(idx + sentinel2.length);
          const m = tail.match(/^(-?\d+)/);
          const exitCode = m ? parseInt(m[1], 10) : -1;
          let out = __classPrivateFieldGet(this, _BashSession_buf, "f").slice(0, idx).replace(ANSI_RE, "").replace(/\n+$/, "");
          if (__classPrivateFieldGet(this, _BashSession_truncated, "f")) {
            out = `[output truncated]
${out}`;
          }
          return { output: out, exitCode };
        }
        close() {
          if (__classPrivateFieldGet(this, _BashSession_closed, "f"))
            return;
          __classPrivateFieldSet(this, _BashSession_closed, true, "f");
          const w = __classPrivateFieldGet(this, _BashSession_waiting, "f");
          __classPrivateFieldSet(this, _BashSession_waiting, null, "f");
          w?.resolve();
          __classPrivateFieldGet(this, _BashSession_proc, "f").stdout.destroy();
          __classPrivateFieldGet(this, _BashSession_proc, "f").stderr.destroy();
          __classPrivateFieldGet(this, _BashSession_proc, "f").stdin.destroy();
          try {
            process.kill(-__classPrivateFieldGet(this, _BashSession_proc, "f").pid, "SIGKILL");
          } catch {
            __classPrivateFieldGet(this, _BashSession_proc, "f").kill("SIGKILL");
          }
          __classPrivateFieldGet(this, _BashSession_proc, "f").unref();
        }
      }
      _BashSession_proc = /* @__PURE__ */ new WeakMap(), _BashSession_buf = /* @__PURE__ */ new WeakMap(), _BashSession_truncated = /* @__PURE__ */ new WeakMap(), _BashSession_closed = /* @__PURE__ */ new WeakMap(), _BashSession_waiting = /* @__PURE__ */ new WeakMap(), _BashSession_instances = /* @__PURE__ */ new WeakSet(), _BashSession_append = function _BashSession_append2(d) {
        __classPrivateFieldSet(this, _BashSession_buf, __classPrivateFieldGet(this, _BashSession_buf, "f") + d, "f");
        if (__classPrivateFieldGet(this, _BashSession_buf, "f").length > BASH_OUTPUT_LIMIT) {
          __classPrivateFieldSet(this, _BashSession_buf, __classPrivateFieldGet(this, _BashSession_buf, "f").slice(__classPrivateFieldGet(this, _BashSession_buf, "f").length - BASH_OUTPUT_LIMIT), "f");
          __classPrivateFieldSet(this, _BashSession_truncated, true, "f");
        }
        if (__classPrivateFieldGet(this, _BashSession_waiting, "f") && __classPrivateFieldGet(this, _BashSession_buf, "f").indexOf(__classPrivateFieldGet(this, _BashSession_waiting, "f").sentinel) >= 0) {
          const w = __classPrivateFieldGet(this, _BashSession_waiting, "f");
          __classPrivateFieldSet(this, _BashSession_waiting, null, "f");
          w.resolve();
        }
      };
      return BashSession2;
    })();
    LineRangeCollector = /* @__PURE__ */ (() => {
      class LineRangeCollector2 {
        constructor(filePath, startLine, endLine, limit2) {
          _LineRangeCollector_instances.add(this);
          _LineRangeCollector_filePath.set(this, void 0);
          _LineRangeCollector_startLine.set(this, void 0);
          _LineRangeCollector_endLine.set(this, void 0);
          _LineRangeCollector_start.set(this, void 0);
          _LineRangeCollector_end.set(this, void 0);
          _LineRangeCollector_limit.set(this, void 0);
          _LineRangeCollector_line.set(this, 0);
          _LineRangeCollector_collected.set(this, []);
          _LineRangeCollector_collectedBytes.set(this, 0);
          __classPrivateFieldSet(this, _LineRangeCollector_filePath, filePath, "f");
          __classPrivateFieldSet(this, _LineRangeCollector_startLine, startLine, "f");
          __classPrivateFieldSet(this, _LineRangeCollector_endLine, endLine, "f");
          __classPrivateFieldSet(this, _LineRangeCollector_start, Math.max(0, startLine - 1), "f");
          __classPrivateFieldSet(this, _LineRangeCollector_end, endLine > 0 ? endLine : Infinity, "f");
          __classPrivateFieldSet(this, _LineRangeCollector_limit, limit2, "f");
        }
        rangeIsEmpty() {
          return __classPrivateFieldGet(this, _LineRangeCollector_end, "f") <= __classPrivateFieldGet(this, _LineRangeCollector_start, "f");
        }
        rangeIsCollected() {
          return __classPrivateFieldGet(this, _LineRangeCollector_line, "f") >= __classPrivateFieldGet(this, _LineRangeCollector_end, "f");
        }
        collectFrom(chunk) {
          var _a2;
          let lineStart = 0;
          while (lineStart < chunk.length && !this.rangeIsCollected()) {
            const newline = chunk.indexOf(10, lineStart);
            const lineEnd = newline < 0 ? chunk.length : newline;
            if (__classPrivateFieldGet(this, _LineRangeCollector_line, "f") >= __classPrivateFieldGet(this, _LineRangeCollector_start, "f")) {
              __classPrivateFieldGet(this, _LineRangeCollector_instances, "m", _LineRangeCollector_collect).call(this, chunk.subarray(lineStart, lineEnd), newline >= 0);
            }
            if (newline < 0)
              break;
            __classPrivateFieldSet(this, _LineRangeCollector_line, (_a2 = __classPrivateFieldGet(this, _LineRangeCollector_line, "f"), _a2++, _a2), "f");
            lineStart = newline + 1;
          }
        }
        text() {
          return Buffer.concat(__classPrivateFieldGet(this, _LineRangeCollector_collected, "f"), __classPrivateFieldGet(this, _LineRangeCollector_collectedBytes, "f")).toString("utf8");
        }
      }
      _LineRangeCollector_filePath = /* @__PURE__ */ new WeakMap(), _LineRangeCollector_startLine = /* @__PURE__ */ new WeakMap(), _LineRangeCollector_endLine = /* @__PURE__ */ new WeakMap(), _LineRangeCollector_start = /* @__PURE__ */ new WeakMap(), _LineRangeCollector_end = /* @__PURE__ */ new WeakMap(), _LineRangeCollector_limit = /* @__PURE__ */ new WeakMap(), _LineRangeCollector_line = /* @__PURE__ */ new WeakMap(), _LineRangeCollector_collected = /* @__PURE__ */ new WeakMap(), _LineRangeCollector_collectedBytes = /* @__PURE__ */ new WeakMap(), _LineRangeCollector_instances = /* @__PURE__ */ new WeakSet(), _LineRangeCollector_collect = function _LineRangeCollector_collect2(lineBytes, newlineTerminated) {
        __classPrivateFieldGet(this, _LineRangeCollector_collected, "f").push(lineBytes);
        __classPrivateFieldSet(this, _LineRangeCollector_collectedBytes, __classPrivateFieldGet(this, _LineRangeCollector_collectedBytes, "f") + lineBytes.length, "f");
        if (newlineTerminated && __classPrivateFieldGet(this, _LineRangeCollector_line, "f") + 1 < __classPrivateFieldGet(this, _LineRangeCollector_end, "f")) {
          __classPrivateFieldGet(this, _LineRangeCollector_collected, "f").push(NEWLINE);
          __classPrivateFieldSet(this, _LineRangeCollector_collectedBytes, __classPrivateFieldGet(this, _LineRangeCollector_collectedBytes, "f") + NEWLINE.length, "f");
        }
        if (__classPrivateFieldGet(this, _LineRangeCollector_collectedBytes, "f") > __classPrivateFieldGet(this, _LineRangeCollector_limit, "f"))
          throw __classPrivateFieldGet(this, _LineRangeCollector_instances, "m", _LineRangeCollector_overLimitError).call(this);
      }, _LineRangeCollector_overLimitError = function _LineRangeCollector_overLimitError2() {
        if (__classPrivateFieldGet(this, _LineRangeCollector_end, "f") - __classPrivateFieldGet(this, _LineRangeCollector_start, "f") === 1) {
          return new ToolError(`read: line ${__classPrivateFieldGet(this, _LineRangeCollector_start, "f") + 1} of ${__classPrivateFieldGet(this, _LineRangeCollector_filePath, "f")} alone exceeds ${__classPrivateFieldGet(this, _LineRangeCollector_limit, "f")}-byte limit. The read tool cannot return part of a line, so view_range cannot narrow this further.`);
        }
        return new ToolError(`read: view_range [${__classPrivateFieldGet(this, _LineRangeCollector_startLine, "f")}, ${__classPrivateFieldGet(this, _LineRangeCollector_endLine, "f")}] of ${__classPrivateFieldGet(this, _LineRangeCollector_filePath, "f")} exceeds ${__classPrivateFieldGet(this, _LineRangeCollector_limit, "f")}-byte limit. Narrow the view_range to read a smaller portion.`);
      };
      return LineRangeCollector2;
    })();
    WALK_MAX_DEPTH = 40;
    WALK_MAX_ENTRIES = 5e4;
  }
});

// node_modules/@anthropic-ai/sdk/lib/environments/worker.mjs
function hasMemoryStore(session) {
  return session.resources.some((r) => r.type === "memory_store");
}
function sessionsTokenFromSecret(secret) {
  if (!secret)
    return null;
  let parsed;
  try {
    const normalized = secret.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    parsed = JSON.parse(decodeUTF8(fromBase64(padded)));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const token = parsed.sessions_token;
  return typeof token === "string" && token !== "" ? token : null;
}
async function withTimeout(p, ms) {
  let timer;
  try {
    return await Promise.race([
      p.then(() => false, () => false),
      new Promise((resolve2) => {
        timer = setTimeout(() => resolve2(true), ms);
      })
    ]);
  } finally {
    if (timer !== void 0)
      clearTimeout(timer);
  }
}
async function forceStop(client2, work, log, requestOptions) {
  try {
    await client2.beta.environments.work.stop(
      work.id,
      { environment_id: work.environment_id, force: true },
      // Caller's headers pass through; the helper-tag header is on the scoped
      // sub-client's default_headers via copyClientForHelper, so no per-call
      // re-stamping needed.
      { ...requestOptions, headers: buildHeaders([requestOptions?.headers]) }
    );
  } catch (e) {
    if (!isStatus(e, 409)) {
      log.error("force-stop on exit failed", { work_id: work.id, error: String(e) });
    }
  }
}
function serverLeaseState(e) {
  let node = e instanceof APIError ? e.error : void 0;
  for (const key of ["error", "details", "current_state"]) {
    if (!isObj(node))
      return {};
    node = node[key];
  }
  return isObj(node) ? node : {};
}
async function heartbeatLoop(client2, work, lease, logger, requestOptions, onLeaseTtl) {
  let intervalMs = HEARTBEAT_DEFAULT_MS;
  let ttlMs = HEARTBEAT_TTL_DEFAULT_MS;
  let lastSuccessMs = Date.now();
  let last = NO_HEARTBEAT_SENTINEL;
  const beat = async () => {
    const beatCtrl = new AbortController();
    const detach = linkAbort(lease.signal, beatCtrl);
    const cutoff = setTimeout(() => beatCtrl.abort(), intervalMs);
    try {
      const resp = await client2.beta.environments.work.heartbeat(work.id, { environment_id: work.environment_id, expected_last_heartbeat: last }, { ...requestOptions, headers: buildHeaders([requestOptions?.headers]), signal: beatCtrl.signal });
      lastSuccessMs = Date.now();
      last = resp.last_heartbeat;
      if (resp.ttl_seconds > 0) {
        ttlMs = resp.ttl_seconds * 1e3;
        intervalMs = Math.max(1e3, Math.min(ttlMs / 2, HEARTBEAT_DEFAULT_MS));
        onLeaseTtl?.(ttlMs);
      }
      if (resp.state === "stopping" || resp.state === "stopped") {
        logger.info("heartbeat signals shutdown", { work_id: work.id, state: resp.state });
        lease.finish("control_plane_stop");
      }
      if (!resp.lease_extended) {
        logger.warn("lease not extended, shutting down", { work_id: work.id });
        lease.finish("control_plane_stop");
      }
    } catch (e) {
      lease.signal.throwIfAborted();
      if (isStatus(e, 412)) {
        const server2 = serverLeaseState(e);
        logger.error("lease lost: heartbeat precondition failed", {
          work_id: work.id,
          server_state: server2["state"],
          server_ttl_seconds: server2["ttl_seconds"],
          server_last_heartbeat: server2["last_heartbeat"]
        });
        lease.finish("lease_lost");
        return;
      }
      if (isFatal4xx(e)) {
        logger.error("permanent heartbeat failure", { work_id: work.id, error: String(e) });
        lease.finish("heartbeat_rejected");
        throw e;
      }
      if (Date.now() - lastSuccessMs > ttlMs) {
        logger.error("lease assumed lost: no successful heartbeat in ttl", {
          work_id: work.id,
          ttl_ms: ttlMs,
          error: String(e)
        });
        lease.finish("assumed_lost");
        return;
      }
      logger.warn("transient heartbeat failure", { work_id: work.id, error: String(e) });
    } finally {
      clearTimeout(cutoff);
      detach();
    }
  };
  await beat();
  while (!lease.signal.aborted) {
    await sleep(intervalMs, lease.signal);
    lease.signal.throwIfAborted();
    await beat();
  }
}
var _EnvironmentWorker_instances, _EnvironmentWorker_signal, _EnvironmentWorker_handleItem, _Lease_ctrl, _Lease_endReason, HEARTBEAT_DEFAULT_MS, HEARTBEAT_TTL_DEFAULT_MS, NO_HEARTBEAT_SENTINEL, EnvironmentWorker, Lease;
var init_worker = __esm({
  "node_modules/@anthropic-ai/sdk/lib/environments/worker.mjs"() {
    init_tslib();
    init_error();
    init_log();
    init_base64();
    init_bytes();
    init_env();
    init_sleep();
    init_backoff();
    init_abort();
    init_values();
    init_headers();
    init_SessionToolRunner();
    init_poller();
    init_helper_client();
    init_sync_interval();
    HEARTBEAT_DEFAULT_MS = 3e4;
    HEARTBEAT_TTL_DEFAULT_MS = 9e4;
    NO_HEARTBEAT_SENTINEL = "NO_HEARTBEAT";
    EnvironmentWorker = /* @__PURE__ */ (() => {
      class EnvironmentWorker2 {
        constructor(opts) {
          _EnvironmentWorker_instances.add(this);
          _EnvironmentWorker_signal.set(this, void 0);
          if (opts.unrestrictedPaths !== void 0) {
            throw new AnthropicError("The `unrestrictedPaths` option you passed to EnvironmentWorker (or client.beta.environments.work.worker()) is no longer supported. The worker's file tools (read, write, edit, glob, grep) are now always confined to `workdir` plus the session's memory folders. Remove `unrestrictedPaths` from your options; to let the file tools reach any other directory, add it to `AgentToolContext.allowedRoots` from a `tools` factory.");
          }
          this.client = opts.client;
          this.environmentId = opts.environmentId;
          this.environmentKey = opts.environmentKey;
          this.tools = opts.tools;
          this.workdir = opts.workdir ?? process.cwd();
          this.maxFileBytes = opts.maxFileBytes;
          this.maxIdleMs = opts.maxIdleMs;
          if (opts.memorySyncIntervalMs != null) {
            checkMemorySyncInterval(opts.memorySyncIntervalMs, "memorySyncIntervalMs");
          }
          this.memorySyncIntervalMs = opts.memorySyncIntervalMs;
          this.memorySyncDeletions = opts.memorySyncDeletions ?? "enabled";
          this.workerId = opts.workerId;
          this.requestOptions = opts.requestOptions;
          __classPrivateFieldSet(this, _EnvironmentWorker_signal, opts.signal, "f");
        }
        /**
         * Poll the environment and service each claimed session until the supplied
         * signal (or the one passed to the constructor) aborts. Throws if
         * `environmentId` / `environmentKey` were not provided to the constructor.
         */
        async run(signal) {
          const { environmentId, environmentKey } = this;
          if (environmentId === void 0 || environmentKey === void 0) {
            throw new AnthropicError("EnvironmentWorker.run: environmentId and environmentKey are required to poll for work");
          }
          const externalSignal = signal ?? __classPrivateFieldGet(this, _EnvironmentWorker_signal, "f");
          const poller = new WorkPoller({
            client: this.client,
            environmentId,
            environmentKey,
            ...this.workerId !== void 0 ? { workerId: this.workerId } : {},
            ...externalSignal ? { signal: externalSignal } : {},
            ...this.requestOptions !== void 0 ? { requestOptions: this.requestOptions } : {},
            // The per-item handler stops or releases every work item on exit; let it
            // be the single owner of `work.stop` rather than double-posting from the
            // poller.
            autoStop: false
          });
          for await (const work of poller) {
            try {
              await __classPrivateFieldGet(this, _EnvironmentWorker_instances, "m", _EnvironmentWorker_handleItem).call(this, work, environmentKey, poller.signal);
            } catch (e) {
              if (poller.signal?.aborted)
                throw e;
              loggerFor(this.client).error("work item failed", { work_id: work.id, error: String(e) });
            }
          }
        }
        /**
         * Service a single, already-claimed work item without the poll loop: build the
         * per-session {@link AgentToolContext} (workdir from this worker's options),
         * download the session agent's skills (`setupSkills`), run a
         * {@link SessionToolRunner} for the session while heartbeating the work-item
         * lease, and force-stop the work item on exit (whether the runner finishes
         * normally, throws, or the control plane signals shutdown). The one
         * exception is a lost lease: the item then belongs to the queue or another
         * worker and is left alone.
         *
         * Use this when something else does the claiming — e.g. a `worker poll
         * --on-work` script that hands an already-claimed item to a fresh process. The
         * work id / environment id / session id each fall back to `ANTHROPIC_WORK_ID` /
         * `ANTHROPIC_ENVIRONMENT_ID` / `ANTHROPIC_SESSION_ID` (the env vars that
         * command sets) when not passed; the environment key resolves from this
         * option, then the worker's own `environmentKey`, then
         * `ANTHROPIC_ENVIRONMENT_KEY`, and is needed only when the work item's
         * `secret` yields no sessions token — a host that receives only the
         * per-item secret runs without ever holding the key. With no arguments
         * inside that command it just works. Throws a clear error naming the first
         * required value still missing after resolution, and — rather than ever
         * running unauthenticated — when neither a sessions token nor an
         * environment key resolved. Throws `SessionMemoryError` when the
         * session has memory stores attached but they cannot be mounted — the work
         * item carried no sessions token (unless `memorySyncIntervalMs` turned
         * memory off), or a store failed to download.
         *
         * `workSecret` is the work item's per-item `secret` payload from the poll
         * response, falling back to `ANTHROPIC_WORK_SECRET`; unlike the others it is
         * optional — when present, the sessions token extracted from it is preferred
         * as the Bearer credential for this item's heartbeat / force-stop / session
         * calls; when absent (or undecodable) those calls use the environment key.
         */
        async handleItem(opts) {
          const workId = opts?.workId ?? readEnv("ANTHROPIC_WORK_ID");
          const environmentId = opts?.environmentId ?? readEnv("ANTHROPIC_ENVIRONMENT_ID");
          const sessionId = opts?.sessionId ?? readEnv("ANTHROPIC_SESSION_ID");
          const environmentKey = (opts?.environmentKey ?? this.environmentKey ?? readEnv("ANTHROPIC_ENVIRONMENT_KEY")) || void 0;
          const workSecret = opts?.workSecret || readEnv("ANTHROPIC_WORK_SECRET") || null;
          if (!workId) {
            throw new AnthropicError("handleItem: workId is required \u2014 pass it or set ANTHROPIC_WORK_ID");
          }
          if (!environmentId) {
            throw new AnthropicError("handleItem: environmentId is required \u2014 pass it or set ANTHROPIC_ENVIRONMENT_ID");
          }
          if (!sessionId) {
            throw new AnthropicError("handleItem: sessionId is required \u2014 pass it or set ANTHROPIC_SESSION_ID");
          }
          if (!environmentKey && !workSecret) {
            throw new AnthropicError("handleItem: environmentKey is required when there is no work secret \u2014 pass it, construct the worker with it, or set ANTHROPIC_ENVIRONMENT_KEY");
          }
          const work = {
            id: workId,
            environment_id: environmentId,
            secret: workSecret,
            data: { type: "session", id: sessionId }
          };
          await __classPrivateFieldGet(this, _EnvironmentWorker_instances, "m", _EnvironmentWorker_handleItem).call(this, work, environmentKey, opts?.signal ?? __classPrivateFieldGet(this, _EnvironmentWorker_signal, "f"));
        }
      }
      _EnvironmentWorker_signal = /* @__PURE__ */ new WeakMap(), _EnvironmentWorker_instances = /* @__PURE__ */ new WeakSet(), _EnvironmentWorker_handleItem = /**
       * The per-item body shared by {@link EnvironmentWorker.run}'s poll loop and
       * {@link EnvironmentWorker.handleItem}: run a {@link SessionToolRunner} for the
       * work item's session while heartbeating its lease, force-stopping on exit
       * unless the lease was lost. Non-session work items are ignored.
       *
       * When the poll response carried a per-item `secret` (a short-lived payload
       * scoped to this work item), the sessions token extracted from it is
       * preferred over `environmentKey` as the Bearer credential for those
       * per-item calls; a missing/undecodable secret falls back to
       * `environmentKey` unchanged.
       */
      async function _EnvironmentWorker_handleItem2(work, environmentKey, externalSignal) {
        const log = loggerFor(this.client);
        const sessionsToken = sessionsTokenFromSecret(work.secret);
        const itemCredential = sessionsToken ?? environmentKey;
        if (itemCredential === void 0) {
          throw new AnthropicError("handleItem: the work item carried a secret payload but no sessions token could be extracted, and there is no environment key to fall back to; the poller must issue a secret whose payload carries `sessions_token`, or provide the environment key (pass it, construct the worker with it, or set ANTHROPIC_ENVIRONMENT_KEY)");
        }
        if (work.secret && sessionsToken === null) {
          log.warn("work item carried a secret payload but no sessions token could be extracted; falling back to the environment key", { work_id: work.id });
        }
        const sessionClient = copyClientForHelper(this.client, {
          authToken: itemCredential,
          helper: "environments-worker"
        });
        const sessionId = work.data.id;
        const ctrl = new AbortController();
        const detachExternal = linkAbort(externalSignal, ctrl);
        const lease = new Lease(ctrl);
        const agentToolset = await Promise.resolve().then(() => (init_node2(), node_exports2));
        let leaseTtlMs;
        let runner;
        const heartbeatPromise = heartbeatLoop(sessionClient, work, lease, log, this.requestOptions, (ttlMs) => {
          leaseTtlMs = ttlMs;
          runner?._setSendRetryWindow(ttlMs);
        }).catch((e) => {
          if (!ctrl.signal.aborted)
            log.error("heartbeat loop failed", { work_id: work.id, error: String(e) });
          ctrl.abort();
        });
        let cleanupSkills = async () => {
        };
        let stores;
        let cleanEnd = false;
        try {
          if (work.data.type !== "session") {
            log.debug("skipping non-session work item", { work_id: work.id, type: work.data.type });
            return;
          }
          const session = await sessionClient.beta.sessions.retrieve(sessionId);
          if (sessionsToken === null && this.memorySyncIntervalMs !== null && hasMemoryStore(session)) {
            throw new agentToolset.SessionMemoryError(`cannot mount the session's memories: the work item carried no sessions token (work_id=${work.id}, session_id=${sessionId}); the memory endpoints reject the environment key, so the poller must issue a per-item \`secret\` carrying \`sessions_token\`, or set \`memorySyncIntervalMs: null\` to run without memory`);
          }
          const ctx = {
            workdir: this.workdir,
            // The scoped sub-client, not the parent: the skill download
            // `setupSkills` performs for this session rides the same per-item
            // credential as every other per-item call.
            client: sessionClient,
            session,
            ...this.maxFileBytes !== void 0 ? { maxFileBytes: this.maxFileBytes } : {}
          };
          try {
            cleanupSkills = await agentToolset.setupSkills(ctx);
          } catch (e) {
            log.warn("skill setup failed", { session_id: sessionId, work_id: work.id, error: String(e) });
          }
          if (sessionsToken !== null && this.memorySyncIntervalMs !== null) {
            stores = new agentToolset.SessionMemoryStores(sessionClient, {
              workdir: this.workdir,
              ...this.memorySyncIntervalMs !== void 0 ? { syncIntervalMs: this.memorySyncIntervalMs } : {},
              syncDeletions: this.memorySyncDeletions
            });
            await stores.download(session);
            ctx.allowedRoots = stores.roots;
            ctx.readOnlyRoots = stores.readOnlyRoots;
          } else {
            log.debug("memory stores disabled for this item", { work_id: work.id });
          }
          const tools = typeof this.tools === "function" ? this.tools(ctx) : this.tools ?? agentToolset.betaAgentToolset20260401(ctx);
          runner = new SessionToolRunner(sessionId, {
            client: sessionClient,
            tools,
            ...this.maxIdleMs !== void 0 ? { maxIdleMs: this.maxIdleMs } : {},
            ...this.requestOptions !== void 0 ? { requestOptions: this.requestOptions } : {},
            signal: ctrl.signal
          });
          if (leaseTtlMs !== void 0)
            runner._setSendRetryWindow(leaseTtlMs);
          for await (const _ of runner) {
            if (stores)
              await stores.syncIfDue();
          }
          cleanEnd = !ctrl.signal.aborted;
        } finally {
          try {
            await cleanupSkills().catch((e) => {
              log.warn("skill cleanup failed", { session_id: sessionId, work_id: work.id, error: String(e) });
            });
          } finally {
            if (stores) {
              const boundMs = agentToolset.MEMORY_FLUSH_TIMEOUT_MS;
              if (cleanEnd) {
                const finishCutOff = await withTimeout(stores.finish(), boundMs);
                if (finishCutOff) {
                  log.warn(`final memory sync cut off after ${boundMs}ms; the flush that follows still uploads changed files`, { session_id: sessionId, work_id: work.id });
                }
              }
              const flushBound = new AbortController();
              const flushCutOff = await withTimeout(stores.flushWrites(flushBound.signal), boundMs);
              if (flushCutOff) {
                flushBound.abort();
                log.warn(`memory flush cut off after ${boundMs}ms; changed files it had not uploaded yet are not saved`, { session_id: sessionId, work_id: work.id });
              }
              await stores.dispose().catch((e) => {
                log.warn("memory store cleanup failed", {
                  session_id: sessionId,
                  work_id: work.id,
                  error: String(e)
                });
              });
            }
          }
          lease.finish("runner_done");
          detachExternal();
          await heartbeatPromise;
          if (lease.lost) {
            log.info("lease lost; released without stopping it", { session_id: sessionId, work_id: work.id });
          } else {
            await forceStop(sessionClient, work, log, this.requestOptions);
          }
        }
      };
      return EnvironmentWorker2;
    })();
    Lease = /* @__PURE__ */ (() => {
      class Lease2 {
        constructor(ctrl) {
          _Lease_ctrl.set(this, void 0);
          _Lease_endReason.set(this, void 0);
          __classPrivateFieldSet(this, _Lease_ctrl, ctrl, "f");
        }
        get signal() {
          return __classPrivateFieldGet(this, _Lease_ctrl, "f").signal;
        }
        finish(reason) {
          __classPrivateFieldSet(this, _Lease_endReason, __classPrivateFieldGet(this, _Lease_endReason, "f") ?? reason, "f");
          __classPrivateFieldGet(this, _Lease_ctrl, "f").abort();
        }
        /** True once the item belongs to the queue or another worker. */
        get lost() {
          return __classPrivateFieldGet(this, _Lease_endReason, "f") === "lease_lost" || __classPrivateFieldGet(this, _Lease_endReason, "f") === "assumed_lost";
        }
      }
      _Lease_ctrl = /* @__PURE__ */ new WeakMap(), _Lease_endReason = /* @__PURE__ */ new WeakMap();
      return Lease2;
    })();
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/environments/work.mjs
var Work;
var init_work = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/environments/work.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_path();
    init_poller();
    init_worker();
    Work = /* @__PURE__ */ (() => {
      class Work2 extends APIResource {
        /**
         * Note: these endpoints are called automatically by the pre-built environment
         * worker provided in the SDKs and CLI, for orchestrating sessions with self-hosted
         * sandbox environments. They are included here as a reference; you do not need to
         * invoke them directly.
         *
         * Retrieve detailed information about a specific work item.
         *
         * @example
         * ```ts
         * const betaSelfHostedWork =
         *   await client.beta.environments.work.retrieve('work_id', {
         *     environment_id: 'env_011CZkZ9X2dpNyB7HsEFoRfW',
         *   });
         * ```
         */
        retrieve(workID, params, options) {
          const { environment_id, betas, workspace_id } = params;
          return this._client.get(path3`/v1/environments/${environment_id}/work/${workID}?beta=true`, {
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * Note: these endpoints are called automatically by the pre-built environment
         * worker provided in the SDKs and CLI, for orchestrating sessions with self-hosted
         * sandbox environments. They are included here as a reference; you do not need to
         * invoke them directly.
         *
         * Update work item metadata with merge semantics.
         *
         * @example
         * ```ts
         * const betaSelfHostedWork =
         *   await client.beta.environments.work.update('work_id', {
         *     environment_id: 'env_011CZkZ9X2dpNyB7HsEFoRfW',
         *     metadata: { foo: 'string' },
         *   });
         * ```
         */
        update(workID, params, options) {
          const { environment_id, betas, workspace_id, ...body } = params;
          return this._client.post(path3`/v1/environments/${environment_id}/work/${workID}?beta=true`, {
            body,
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * Note: these endpoints are called automatically by the pre-built environment
         * worker provided in the SDKs and CLI, for orchestrating sessions with self-hosted
         * sandbox environments. They are included here as a reference; you do not need to
         * invoke them directly.
         *
         * List work items in an environment.
         *
         * @example
         * ```ts
         * // Automatically fetches more pages as needed.
         * for await (const betaSelfHostedWork of client.beta.environments.work.list(
         *   'env_011CZkZ9X2dpNyB7HsEFoRfW',
         * )) {
         *   // ...
         * }
         * ```
         */
        list(environmentID, params = {}, options) {
          const { betas, ...query } = params ?? {};
          return this._client.getAPIList(path3`/v1/environments/${environmentID}/work?beta=true`, PageCursor, {
            query,
            ...options,
            headers: buildHeaders([
              { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
              options?.headers
            ])
          });
        }
        /**
         * Note: these endpoints are called automatically by the pre-built environment
         * worker provided in the SDKs and CLI, for orchestrating sessions with self-hosted
         * sandbox environments. They are included here as a reference; you do not need to
         * invoke them directly.
         *
         * Acknowledge receipt of a work item, transitioning it from 'queued' to 'starting'
         * and removing it from the queue.
         *
         * @example
         * ```ts
         * const betaSelfHostedWork =
         *   await client.beta.environments.work.ack('work_id', {
         *     environment_id: 'env_011CZkZ9X2dpNyB7HsEFoRfW',
         *   });
         * ```
         */
        ack(workID, params, options) {
          const { environment_id, betas } = params;
          return this._client.post(path3`/v1/environments/${environment_id}/work/${workID}/ack?beta=true`, {
            ...options,
            headers: buildHeaders([
              { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
              options?.headers
            ])
          });
        }
        /**
         * Note: these endpoints are called automatically by the pre-built environment
         * worker provided in the SDKs and CLI, for orchestrating sessions with self-hosted
         * sandbox environments. They are included here as a reference; you do not need to
         * invoke them directly.
         *
         * Record a heartbeat for a work item to maintain the lease.
         *
         * @example
         * ```ts
         * const betaSelfHostedWorkHeartbeatResponse =
         *   await client.beta.environments.work.heartbeat('work_id', {
         *     environment_id: 'env_011CZkZ9X2dpNyB7HsEFoRfW',
         *   });
         * ```
         */
        heartbeat(workID, params, options) {
          const { environment_id, desired_ttl_seconds, expected_last_heartbeat, betas } = params;
          return this._client.post(path3`/v1/environments/${environment_id}/work/${workID}/heartbeat?beta=true`, {
            query: { desired_ttl_seconds, expected_last_heartbeat },
            ...options,
            headers: buildHeaders([
              { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
              options?.headers
            ])
          });
        }
        /**
         * Note: these endpoints are called automatically by the pre-built environment
         * worker provided in the SDKs and CLI, for orchestrating sessions with self-hosted
         * sandbox environments. They are included here as a reference; you do not need to
         * invoke them directly.
         *
         * Long poll for work items in the queue.
         *
         * @example
         * ```ts
         * const betaSelfHostedWork =
         *   await client.beta.environments.work.poll(
         *     'env_011CZkZ9X2dpNyB7HsEFoRfW',
         *   );
         * ```
         */
        poll(environmentID, params = {}, options) {
          const { betas, "Anthropic-Worker-ID": anthropicWorkerID, ...query } = params ?? {};
          return this._client.get(path3`/v1/environments/${environmentID}/work/poll?beta=true`, {
            query,
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
                ...anthropicWorkerID != null ? { "Anthropic-Worker-ID": anthropicWorkerID } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * Get statistics about the work queue for an environment.
         *
         * @example
         * ```ts
         * const betaSelfHostedWorkQueueStats =
         *   await client.beta.environments.work.stats(
         *     'env_011CZkZ9X2dpNyB7HsEFoRfW',
         *   );
         * ```
         */
        stats(environmentID, params = {}, options) {
          const { betas, workspace_id } = params ?? {};
          return this._client.get(path3`/v1/environments/${environmentID}/work/stats?beta=true`, {
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * Note: these endpoints are called automatically by the pre-built environment
         * worker provided in the SDKs and CLI, for orchestrating sessions with self-hosted
         * sandbox environments. They are included here as a reference; you do not need to
         * invoke them directly.
         *
         * Stop a work item, initiating graceful or forced shutdown.
         *
         * @example
         * ```ts
         * const betaSelfHostedWork =
         *   await client.beta.environments.work.stop('work_id', {
         *     environment_id: 'env_011CZkZ9X2dpNyB7HsEFoRfW',
         *   });
         * ```
         */
        stop(workID, params, options) {
          const { environment_id, betas, workspace_id, ...body } = params;
          return this._client.post(path3`/v1/environments/${environment_id}/work/${workID}/stop?beta=true`, {
            body,
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * Continuously claim work from a self-hosted environment, ack each item,
         * and yield it. Posts `stop` automatically when the consumer's loop body
         * returns or when iteration ends.
         *
         * @example
         * ```ts
         * for await (const work of client.beta.environments.work.poller({
         *   environmentId,
         *   environmentKey,
         * })) {
         *   if (work.data.type !== 'session') continue;
         *   // ...service the work...
         * }
         * ```
         */
        poller(opts) {
          return new WorkPoller({ ...opts, client: this._client });
        }
        worker(opts) {
          return new EnvironmentWorker({ ...opts, client: this._client });
        }
      }
      Work2.WorkPoller = WorkPoller;
      Work2.EnvironmentWorker = EnvironmentWorker;
      return Work2;
    })();
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/environments/environments.mjs
var Environments;
var init_environments = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/environments/environments.mjs"() {
    init_resource();
    init_work();
    init_work();
    init_pagination();
    init_headers();
    init_path();
    Environments = /* @__PURE__ */ (() => {
      class Environments2 extends APIResource {
        constructor() {
          super(...arguments);
          this.work = new Work(this._client);
        }
        /**
         * Create a new environment with the specified configuration.
         *
         * @example
         * ```ts
         * const betaEnvironment =
         *   await client.beta.environments.create({
         *     name: 'python-data-analysis',
         *   });
         * ```
         */
        create(params, options) {
          const { betas, workspace_id, ...body } = params;
          return this._client.post("/v1/environments?beta=true", {
            body,
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * Retrieve a specific environment by ID.
         *
         * @example
         * ```ts
         * const betaEnvironment =
         *   await client.beta.environments.retrieve(
         *     'env_011CZkZ9X2dpNyB7HsEFoRfW',
         *   );
         * ```
         */
        retrieve(environmentID, params = {}, options) {
          const { betas, workspace_id } = params ?? {};
          return this._client.get(path3`/v1/environments/${environmentID}?beta=true`, {
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * Update an existing environment's configuration.
         *
         * @example
         * ```ts
         * const betaEnvironment =
         *   await client.beta.environments.update(
         *     'env_011CZkZ9X2dpNyB7HsEFoRfW',
         *   );
         * ```
         */
        update(environmentID, params, options) {
          const { betas, workspace_id, ...body } = params;
          return this._client.post(path3`/v1/environments/${environmentID}?beta=true`, {
            body,
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * List environments with pagination support.
         *
         * @example
         * ```ts
         * // Automatically fetches more pages as needed.
         * for await (const betaEnvironment of client.beta.environments.list()) {
         *   // ...
         * }
         * ```
         */
        list(params = {}, options) {
          const { betas, workspace_id, ...query } = params ?? {};
          return this._client.getAPIList("/v1/environments?beta=true", PageCursor, {
            query,
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * Delete an environment by ID. Returns a confirmation of the deletion.
         *
         * @example
         * ```ts
         * const betaEnvironmentDeleteResponse =
         *   await client.beta.environments.delete(
         *     'env_011CZkZ9X2dpNyB7HsEFoRfW',
         *   );
         * ```
         */
        delete(environmentID, params = {}, options) {
          const { betas, workspace_id } = params ?? {};
          return this._client.delete(path3`/v1/environments/${environmentID}?beta=true`, {
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * Archive an environment by ID. Archived environments cannot be used to create new
         * sessions.
         *
         * @example
         * ```ts
         * const betaEnvironment =
         *   await client.beta.environments.archive(
         *     'env_011CZkZ9X2dpNyB7HsEFoRfW',
         *   );
         * ```
         */
        archive(environmentID, params = {}, options) {
          const { betas, workspace_id } = params ?? {};
          return this._client.post(path3`/v1/environments/${environmentID}/archive?beta=true`, {
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
      }
      Environments2.Work = Work;
      return Environments2;
    })();
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/memory-stores/memories.mjs
var Memories;
var init_memories2 = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/memory-stores/memories.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_path();
    Memories = class extends APIResource {
      /**
       * Create a memory
       *
       * @example
       * ```ts
       * const betaManagedAgentsMemory =
       *   await client.beta.memoryStores.memories.create(
       *     'memory_store_id',
       *     { content: 'content', path: 'xx' },
       *   );
       * ```
       */
      create(memoryStoreID, params, options) {
        const { view: view2, betas, workspace_id, ...body } = params;
        return this._client.post(path3`/v1/memory_stores/${memoryStoreID}/memories?beta=true`, {
          query: { view: view2 },
          body,
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "agent-memory-2026-07-22"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * Retrieve a memory
       *
       * @example
       * ```ts
       * const betaManagedAgentsMemory =
       *   await client.beta.memoryStores.memories.retrieve(
       *     'memory_id',
       *     { memory_store_id: 'memory_store_id' },
       *   );
       * ```
       */
      retrieve(memoryID, params, options) {
        const { memory_store_id, betas, workspace_id, ...query } = params;
        return this._client.get(path3`/v1/memory_stores/${memory_store_id}/memories/${memoryID}?beta=true`, {
          query,
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "agent-memory-2026-07-22"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * Update a memory
       *
       * @example
       * ```ts
       * const betaManagedAgentsMemory =
       *   await client.beta.memoryStores.memories.update(
       *     'memory_id',
       *     { memory_store_id: 'memory_store_id' },
       *   );
       * ```
       */
      update(memoryID, params, options) {
        const { memory_store_id, view: view2, betas, workspace_id, ...body } = params;
        return this._client.post(path3`/v1/memory_stores/${memory_store_id}/memories/${memoryID}?beta=true`, {
          query: { view: view2 },
          body,
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "agent-memory-2026-07-22"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * List memories
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaManagedAgentsMemoryListItem of client.beta.memoryStores.memories.list(
       *   'memory_store_id',
       * )) {
       *   // ...
       * }
       * ```
       */
      list(memoryStoreID, params = {}, options) {
        const { betas, workspace_id, ...query } = params ?? {};
        return this._client.getAPIList(path3`/v1/memory_stores/${memoryStoreID}/memories?beta=true`, PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "agent-memory-2026-07-22"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * Delete a memory
       *
       * @example
       * ```ts
       * const betaManagedAgentsDeletedMemory =
       *   await client.beta.memoryStores.memories.delete(
       *     'memory_id',
       *     { memory_store_id: 'memory_store_id' },
       *   );
       * ```
       */
      delete(memoryID, params, options) {
        const { memory_store_id, expected_content_sha256, betas, workspace_id } = params;
        return this._client.delete(path3`/v1/memory_stores/${memory_store_id}/memories/${memoryID}?beta=true`, {
          query: { expected_content_sha256 },
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "agent-memory-2026-07-22"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/memory-stores/memory-versions.mjs
var MemoryVersions;
var init_memory_versions = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/memory-stores/memory-versions.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_path();
    MemoryVersions = class extends APIResource {
      /**
       * Retrieve a memory version
       *
       * @example
       * ```ts
       * const betaManagedAgentsMemoryVersion =
       *   await client.beta.memoryStores.memoryVersions.retrieve(
       *     'memory_version_id',
       *     { memory_store_id: 'memory_store_id' },
       *   );
       * ```
       */
      retrieve(memoryVersionID, params, options) {
        const { memory_store_id, betas, workspace_id, ...query } = params;
        return this._client.get(path3`/v1/memory_stores/${memory_store_id}/memory_versions/${memoryVersionID}?beta=true`, {
          query,
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "agent-memory-2026-07-22"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * List memory versions
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaManagedAgentsMemoryVersion of client.beta.memoryStores.memoryVersions.list(
       *   'memory_store_id',
       * )) {
       *   // ...
       * }
       * ```
       */
      list(memoryStoreID, params = {}, options) {
        const { betas, workspace_id, ...query } = params ?? {};
        return this._client.getAPIList(path3`/v1/memory_stores/${memoryStoreID}/memory_versions?beta=true`, PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "agent-memory-2026-07-22"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * Redact a memory version
       *
       * @example
       * ```ts
       * const betaManagedAgentsMemoryVersion =
       *   await client.beta.memoryStores.memoryVersions.redact(
       *     'memory_version_id',
       *     { memory_store_id: 'memory_store_id' },
       *   );
       * ```
       */
      redact(memoryVersionID, params, options) {
        const { memory_store_id, betas, workspace_id } = params;
        return this._client.post(path3`/v1/memory_stores/${memory_store_id}/memory_versions/${memoryVersionID}/redact?beta=true`, {
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "agent-memory-2026-07-22"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/memory-stores/memory-stores.mjs
var MemoryStores;
var init_memory_stores = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/memory-stores/memory-stores.mjs"() {
    init_resource();
    init_memories2();
    init_memories2();
    init_memory_versions();
    init_memory_versions();
    init_pagination();
    init_headers();
    init_path();
    MemoryStores = /* @__PURE__ */ (() => {
      class MemoryStores2 extends APIResource {
        constructor() {
          super(...arguments);
          this.memories = new Memories(this._client);
          this.memoryVersions = new MemoryVersions(this._client);
        }
        /**
         * Create a memory store
         *
         * @example
         * ```ts
         * const betaManagedAgentsMemoryStore =
         *   await client.beta.memoryStores.create({ name: 'x' });
         * ```
         */
        create(params, options) {
          const { betas, workspace_id, ...body } = params;
          return this._client.post("/v1/memory_stores?beta=true", {
            body,
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "agent-memory-2026-07-22"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * Retrieve a memory store
         *
         * @example
         * ```ts
         * const betaManagedAgentsMemoryStore =
         *   await client.beta.memoryStores.retrieve(
         *     'memory_store_id',
         *   );
         * ```
         */
        retrieve(memoryStoreID, params = {}, options) {
          const { betas, workspace_id } = params ?? {};
          return this._client.get(path3`/v1/memory_stores/${memoryStoreID}?beta=true`, {
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "agent-memory-2026-07-22"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * Update a memory store
         *
         * @example
         * ```ts
         * const betaManagedAgentsMemoryStore =
         *   await client.beta.memoryStores.update('memory_store_id');
         * ```
         */
        update(memoryStoreID, params, options) {
          const { betas, workspace_id, ...body } = params;
          return this._client.post(path3`/v1/memory_stores/${memoryStoreID}?beta=true`, {
            body,
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "agent-memory-2026-07-22"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * List memory stores
         *
         * @example
         * ```ts
         * // Automatically fetches more pages as needed.
         * for await (const betaManagedAgentsMemoryStore of client.beta.memoryStores.list()) {
         *   // ...
         * }
         * ```
         */
        list(params = {}, options) {
          const { betas, workspace_id, ...query } = params ?? {};
          return this._client.getAPIList("/v1/memory_stores?beta=true", PageCursor, {
            query,
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "agent-memory-2026-07-22"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * Delete a memory store
         *
         * @example
         * ```ts
         * const betaManagedAgentsDeletedMemoryStore =
         *   await client.beta.memoryStores.delete('memory_store_id');
         * ```
         */
        delete(memoryStoreID, params = {}, options) {
          const { betas, workspace_id } = params ?? {};
          return this._client.delete(path3`/v1/memory_stores/${memoryStoreID}?beta=true`, {
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "agent-memory-2026-07-22"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * Archive a memory store
         *
         * @example
         * ```ts
         * const betaManagedAgentsMemoryStore =
         *   await client.beta.memoryStores.archive('memory_store_id');
         * ```
         */
        archive(memoryStoreID, params = {}, options) {
          const { betas, workspace_id } = params ?? {};
          return this._client.post(path3`/v1/memory_stores/${memoryStoreID}/archive?beta=true`, {
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "agent-memory-2026-07-22"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
      }
      MemoryStores2.Memories = Memories;
      MemoryStores2.MemoryVersions = MemoryVersions;
      return MemoryStores2;
    })();
  }
});

// node_modules/@anthropic-ai/sdk/error.mjs
var init_error2 = __esm({
  "node_modules/@anthropic-ai/sdk/error.mjs"() {
    init_error();
  }
});

// node_modules/@anthropic-ai/sdk/internal/decoders/jsonl.mjs
var JSONLDecoder;
var init_jsonl = __esm({
  "node_modules/@anthropic-ai/sdk/internal/decoders/jsonl.mjs"() {
    init_error();
    init_shims();
    init_line();
    JSONLDecoder = /* @__PURE__ */ (() => {
      class JSONLDecoder2 {
        constructor(iterator, controller) {
          this.iterator = iterator;
          this.controller = controller;
        }
        async *decoder() {
          const lineDecoder = new LineDecoder();
          for await (const chunk of this.iterator) {
            for (const line of lineDecoder.decode(chunk)) {
              yield JSON.parse(line);
            }
          }
          for (const line of lineDecoder.flush()) {
            yield JSON.parse(line);
          }
        }
        [Symbol.asyncIterator]() {
          return this.decoder();
        }
        static fromResponse(response, controller) {
          if (!response.body) {
            controller.abort();
            if (typeof globalThis.navigator !== "undefined" && globalThis.navigator.product === "ReactNative") {
              throw new AnthropicError(`The default react-native fetch implementation does not support streaming. Please use expo/fetch: https://docs.expo.dev/versions/latest/sdk/expo/#expofetch-api`);
            }
            throw new AnthropicError(`Attempted to iterate over a response with no body`);
          }
          return new JSONLDecoder2(ReadableStreamToAsyncIterable(response.body), controller);
        }
      }
      return JSONLDecoder2;
    })();
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/messages/batches.mjs
var Batches;
var init_batches = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/messages/batches.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_jsonl();
    init_error2();
    init_path();
    Batches = class extends APIResource {
      /**
       * Send a batch of Message creation requests.
       *
       * The Message Batches API can be used to process multiple Messages API requests at
       * once. Once a Message Batch is created, it begins processing immediately. Batches
       * can take up to 24 hours to complete.
       *
       * Learn more about the Message Batches API in our
       * [user guide](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
       *
       * @example
       * ```ts
       * const betaMessageBatch =
       *   await client.beta.messages.batches.create({
       *     requests: [
       *       {
       *         custom_id: 'my-custom-id-1',
       *         params: {
       *           max_tokens: 1024,
       *           messages: [
       *             { content: 'Hello, world', role: 'user' },
       *           ],
       *           model: 'claude-opus-5',
       *         },
       *       },
       *     ],
       *   });
       * ```
       */
      create(params, options) {
        const { betas, user_profile_id, workspace_id, ...body } = params;
        return this._client.post("/v1/messages/batches?beta=true", {
          body,
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString(),
              ...user_profile_id != null ? { "anthropic-user-profile-id": user_profile_id } : void 0,
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * This endpoint is idempotent and can be used to poll for Message Batch
       * completion. To access the results of a Message Batch, make a request to the
       * `results_url` field in the response.
       *
       * Learn more about the Message Batches API in our
       * [user guide](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
       *
       * @example
       * ```ts
       * const betaMessageBatch =
       *   await client.beta.messages.batches.retrieve(
       *     'message_batch_id',
       *   );
       * ```
       */
      retrieve(messageBatchID, params = {}, options) {
        const { betas, workspace_id } = params ?? {};
        return this._client.get(path3`/v1/messages/batches/${messageBatchID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * List all Message Batches within a Workspace. Most recently created batches are
       * returned first.
       *
       * Learn more about the Message Batches API in our
       * [user guide](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaMessageBatch of client.beta.messages.batches.list()) {
       *   // ...
       * }
       * ```
       */
      list(params = {}, options) {
        const { betas, workspace_id, ...query } = params ?? {};
        return this._client.getAPIList("/v1/messages/batches?beta=true", Page, {
          query,
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * Delete a Message Batch.
       *
       * Message Batches can only be deleted once they've finished processing. If you'd
       * like to delete an in-progress batch, you must first cancel it.
       *
       * Learn more about the Message Batches API in our
       * [user guide](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
       *
       * @example
       * ```ts
       * const betaDeletedMessageBatch =
       *   await client.beta.messages.batches.delete(
       *     'message_batch_id',
       *   );
       * ```
       */
      delete(messageBatchID, params = {}, options) {
        const { betas, workspace_id } = params ?? {};
        return this._client.delete(path3`/v1/messages/batches/${messageBatchID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * Batches may be canceled any time before processing ends. Once cancellation is
       * initiated, the batch enters a `canceling` state, at which time the system may
       * complete any in-progress, non-interruptible requests before finalizing
       * cancellation.
       *
       * The number of canceled requests is specified in `request_counts`. To determine
       * which requests were canceled, check the individual results within the batch.
       * Note that cancellation may not result in any canceled requests if they were
       * non-interruptible.
       *
       * Learn more about the Message Batches API in our
       * [user guide](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
       *
       * @example
       * ```ts
       * const betaMessageBatch =
       *   await client.beta.messages.batches.cancel(
       *     'message_batch_id',
       *   );
       * ```
       */
      cancel(messageBatchID, params = {}, options) {
        const { betas, workspace_id } = params ?? {};
        return this._client.post(path3`/v1/messages/batches/${messageBatchID}/cancel?beta=true`, {
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * Streams the results of a Message Batch as a `.jsonl` file.
       *
       * Each line in the file is a JSON object containing the result of a single request
       * in the Message Batch. Results are not guaranteed to be in the same order as
       * requests. Use the `custom_id` field to match results to requests.
       *
       * Learn more about the Message Batches API in our
       * [user guide](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
       *
       * @example
       * ```ts
       * const betaMessageBatchIndividualResponse =
       *   await client.beta.messages.batches.results(
       *     'message_batch_id',
       *   );
       * ```
       */
      async results(messageBatchID, params = {}, options) {
        const batch = await this.retrieve(messageBatchID, params, options);
        if (!batch.results_url) {
          throw new AnthropicError(`No batch \`results_url\`; Has it finished processing? ${batch.processing_status} - ${batch.id}`);
        }
        const { betas, workspace_id } = params ?? {};
        return this._client.get(batch.results_url, {
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString(),
              Accept: "application/binary",
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ]),
          stream: true,
          __binaryResponse: true
        })._thenUnwrap((_, props) => JSONLDecoder.fromResponse(props.response, props.controller));
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/constants.mjs
var MODEL_NONSTREAMING_TOKENS;
var init_constants = __esm({
  "node_modules/@anthropic-ai/sdk/internal/constants.mjs"() {
    MODEL_NONSTREAMING_TOKENS = {
      "claude-opus-4@20250514": 8192,
      "anthropic.claude-opus-4-1-20250805-v1:0": 8192,
      "claude-opus-4-1@20250805": 8192
    };
  }
});

// node_modules/@anthropic-ai/sdk/lib/beta-parser.mjs
function getOutputFormat(params) {
  return params?.output_format ?? params?.output_config?.format;
}
function maybeParseBetaMessage(message, params, opts) {
  const outputFormat = getOutputFormat(params);
  if (!params || !("parse" in (outputFormat ?? {}))) {
    return {
      ...message,
      content: message.content.map((block) => {
        if (block.type === "text") {
          const parsedBlock = Object.defineProperty({ ...block }, "parsed_output", {
            value: null,
            enumerable: false
          });
          return Object.defineProperty(parsedBlock, "parsed", {
            get() {
              opts.logger.warn("The `parsed` property on `text` blocks is deprecated, please use `parsed_output` instead.");
              return null;
            },
            enumerable: false
          });
        }
        return block;
      }),
      parsed_output: null
    };
  }
  return parseBetaMessage(message, params, opts);
}
function parseBetaMessage(message, params, opts) {
  let firstParsedOutput = null;
  const content = message.content.map((block) => {
    if (block.type === "text") {
      const parsedOutput = parseBetaOutputFormat(params, block.text);
      if (firstParsedOutput === null) {
        firstParsedOutput = parsedOutput;
      }
      const parsedBlock = Object.defineProperty({ ...block }, "parsed_output", {
        value: parsedOutput,
        enumerable: false
      });
      return Object.defineProperty(parsedBlock, "parsed", {
        get() {
          opts.logger.warn("The `parsed` property on `text` blocks is deprecated, please use `parsed_output` instead.");
          return parsedOutput;
        },
        enumerable: false
      });
    }
    return block;
  });
  return {
    ...message,
    content,
    parsed_output: firstParsedOutput
  };
}
function parseBetaOutputFormat(params, content) {
  const outputFormat = getOutputFormat(params);
  if (outputFormat?.type !== "json_schema") {
    return null;
  }
  try {
    if ("parse" in outputFormat) {
      return outputFormat.parse(content);
    }
    return JSON.parse(content);
  } catch (error) {
    throw new AnthropicError(`Failed to parse structured output: ${error}`);
  }
}
var init_beta_parser = __esm({
  "node_modules/@anthropic-ai/sdk/lib/beta-parser.mjs"() {
    init_error();
  }
});

// node_modules/@anthropic-ai/sdk/streaming.mjs
var init_streaming2 = __esm({
  "node_modules/@anthropic-ai/sdk/streaming.mjs"() {
    init_streaming();
  }
});

// node_modules/@anthropic-ai/sdk/_vendor/partial-json-parser/parser.mjs
var tokenize, strip, unstrip, generate, partialParse;
var init_parser = __esm({
  "node_modules/@anthropic-ai/sdk/_vendor/partial-json-parser/parser.mjs"() {
    tokenize = (input) => {
      let current = 0;
      let tokens = [];
      while (current < input.length) {
        let char = input[current];
        if (char === "\\") {
          current++;
          continue;
        }
        if (char === "{") {
          tokens.push({
            type: "brace",
            value: "{"
          });
          current++;
          continue;
        }
        if (char === "}") {
          tokens.push({
            type: "brace",
            value: "}"
          });
          current++;
          continue;
        }
        if (char === "[") {
          tokens.push({
            type: "paren",
            value: "["
          });
          current++;
          continue;
        }
        if (char === "]") {
          tokens.push({
            type: "paren",
            value: "]"
          });
          current++;
          continue;
        }
        if (char === ":") {
          tokens.push({
            type: "separator",
            value: ":"
          });
          current++;
          continue;
        }
        if (char === ",") {
          tokens.push({
            type: "delimiter",
            value: ","
          });
          current++;
          continue;
        }
        if (char === '"') {
          const start = current + 1;
          let end = start;
          let danglingQuote = false;
          while (true) {
            end = input.indexOf('"', end);
            if (end === -1) {
              danglingQuote = true;
              break;
            }
            let backslashes = 0;
            let i = end - 1;
            while (i >= start && input[i] === "\\") {
              backslashes++;
              i--;
            }
            if (backslashes % 2 === 0)
              break;
            end++;
          }
          if (danglingQuote) {
            current = input.length;
          } else {
            tokens.push({
              type: "string",
              value: input.slice(start, end)
            });
            current = end + 1;
          }
          continue;
        }
        let WHITESPACE = /\s/;
        if (char && WHITESPACE.test(char)) {
          current++;
          continue;
        }
        let NUMBERS = /[0-9]/;
        if (char && NUMBERS.test(char) || char === "-" || char === ".") {
          let value = "";
          if (char === "-") {
            value += char;
            char = input[++current];
          }
          while (char && (NUMBERS.test(char) || char === "." || // exponent marker, e.g. `1e10` or `1.5E-9`
          char === "e" || char === "E" || // exponent sign, only valid immediately after the exponent marker
          (char === "-" || char === "+") && (value[value.length - 1] === "e" || value[value.length - 1] === "E"))) {
            value += char;
            char = input[++current];
          }
          tokens.push({
            type: "number",
            value,
            unterminated: current === input.length
          });
          continue;
        }
        let LETTERS = /[a-z]/i;
        if (char && LETTERS.test(char)) {
          let value = "";
          while (char && LETTERS.test(char)) {
            if (current === input.length) {
              break;
            }
            value += char;
            char = input[++current];
          }
          if (value == "true" || value == "false" || value === "null") {
            tokens.push({
              type: "name",
              value
            });
          } else {
            current++;
            continue;
          }
          continue;
        }
        current++;
      }
      return tokens;
    };
    strip = (tokens) => {
      let open = [];
      for (const token of tokens) {
        if (token.type === "brace" || token.type === "paren") {
          if (token.value === "{" || token.value === "[") {
            open.push(token.value);
          } else {
            open.pop();
          }
        }
      }
      let innermostOpenBracket = open[open.length - 1];
      let length = tokens.length;
      let JSON_NUMBER = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?$/;
      while (length > 0) {
        let lastToken = tokens[length - 1];
        switch (lastToken.type) {
          case "separator":
            length--;
            continue;
          case "number":
            if (lastToken.unterminated || !JSON_NUMBER.test(lastToken.value)) {
              length--;
              continue;
            }
            break;
          case "string":
            let tokenBeforeTheLastToken = tokens[length - 2];
            if (innermostOpenBracket === "{" && (tokenBeforeTheLastToken?.type === "delimiter" || tokenBeforeTheLastToken?.type === "brace" && tokenBeforeTheLastToken.value === "{")) {
              length--;
              continue;
            }
            break;
          case "delimiter":
            length--;
            break;
        }
        break;
      }
      return tokens.slice(0, length);
    };
    unstrip = (tokens) => {
      let tail = [];
      tokens.map((token) => {
        if (token.type === "brace") {
          if (token.value === "{") {
            tail.push("}");
          } else {
            tail.splice(tail.lastIndexOf("}"), 1);
          }
        }
        if (token.type === "paren") {
          if (token.value === "[") {
            tail.push("]");
          } else {
            tail.splice(tail.lastIndexOf("]"), 1);
          }
        }
      });
      if (tail.length > 0) {
        tail.reverse().map((item) => {
          if (item === "}") {
            tokens.push({
              type: "brace",
              value: "}"
            });
          } else if (item === "]") {
            tokens.push({
              type: "paren",
              value: "]"
            });
          }
        });
      }
      return tokens;
    };
    generate = (tokens) => {
      let output = "";
      tokens.map((token) => {
        switch (token.type) {
          case "string":
            output += '"' + token.value + '"';
            break;
          default:
            output += token.value;
            break;
        }
      });
      return output;
    };
    partialParse = (input) => JSON.parse(generate(unstrip(strip(tokenize(input)))));
  }
});

// node_modules/@anthropic-ai/sdk/internal/message-stream-utils.mjs
function withLazyInput(prev, jsonBuf) {
  const next2 = {};
  for (const key of Object.keys(prev)) {
    if (key !== "input")
      next2[key] = prev[key];
  }
  Object.defineProperty(next2, JSON_BUF_PROPERTY, { value: jsonBuf, enumerable: false, writable: true });
  let input;
  let parsed = false;
  Object.defineProperty(next2, "input", {
    enumerable: true,
    configurable: true,
    get() {
      if (!parsed) {
        input = jsonBuf ? partialParse(jsonBuf) : {};
        parsed = true;
      }
      return input;
    }
  });
  return next2;
}
var JSON_BUF_PROPERTY;
var init_message_stream_utils = __esm({
  "node_modules/@anthropic-ai/sdk/internal/message-stream-utils.mjs"() {
    init_parser();
    JSON_BUF_PROPERTY = "__json_buf";
  }
});

// node_modules/@anthropic-ai/sdk/lib/BetaMessageStream.mjs
function tracksToolInput(content) {
  return content.type === "tool_use" || content.type === "server_tool_use" || content.type === "mcp_tool_use";
}
var _BetaMessageStream_instances, _BetaMessageStream_currentMessageSnapshot, _BetaMessageStream_params, _BetaMessageStream_connectedPromise, _BetaMessageStream_resolveConnectedPromise, _BetaMessageStream_rejectConnectedPromise, _BetaMessageStream_endPromise, _BetaMessageStream_resolveEndPromise, _BetaMessageStream_rejectEndPromise, _BetaMessageStream_listeners, _BetaMessageStream_ended, _BetaMessageStream_errored, _BetaMessageStream_aborted, _BetaMessageStream_catchingPromiseCreated, _BetaMessageStream_response, _BetaMessageStream_request_id, _BetaMessageStream_workspace_id, _BetaMessageStream_logger, _BetaMessageStream_getFinalMessage, _BetaMessageStream_getFinalText, _BetaMessageStream_handleError, _BetaMessageStream_beginRequest, _BetaMessageStream_addStreamEvent, _BetaMessageStream_endRequest, _BetaMessageStream_accumulateMessage, _BetaMessageStream_toolInputParseError, BetaMessageStream;
var init_BetaMessageStream = __esm({
  "node_modules/@anthropic-ai/sdk/lib/BetaMessageStream.mjs"() {
    init_tslib();
    init_stainless_helper_header();
    init_error2();
    init_errors();
    init_values();
    init_streaming2();
    init_beta_parser();
    init_message_stream_utils();
    BetaMessageStream = /* @__PURE__ */ (() => {
      class BetaMessageStream2 {
        constructor(params, opts) {
          _BetaMessageStream_instances.add(this);
          this.messages = [];
          this.receivedMessages = [];
          _BetaMessageStream_currentMessageSnapshot.set(this, void 0);
          _BetaMessageStream_params.set(this, null);
          this.controller = new AbortController();
          _BetaMessageStream_connectedPromise.set(this, void 0);
          _BetaMessageStream_resolveConnectedPromise.set(this, () => {
          });
          _BetaMessageStream_rejectConnectedPromise.set(this, () => {
          });
          _BetaMessageStream_endPromise.set(this, void 0);
          _BetaMessageStream_resolveEndPromise.set(this, () => {
          });
          _BetaMessageStream_rejectEndPromise.set(this, () => {
          });
          _BetaMessageStream_listeners.set(this, {});
          _BetaMessageStream_ended.set(this, false);
          _BetaMessageStream_errored.set(this, false);
          _BetaMessageStream_aborted.set(this, false);
          _BetaMessageStream_catchingPromiseCreated.set(this, false);
          _BetaMessageStream_response.set(this, void 0);
          _BetaMessageStream_request_id.set(this, void 0);
          _BetaMessageStream_workspace_id.set(this, void 0);
          _BetaMessageStream_logger.set(this, void 0);
          _BetaMessageStream_handleError.set(this, (error) => {
            __classPrivateFieldSet(this, _BetaMessageStream_errored, true, "f");
            if (isAbortError(error)) {
              error = new APIUserAbortError();
            }
            if (error instanceof APIUserAbortError) {
              __classPrivateFieldSet(this, _BetaMessageStream_aborted, true, "f");
              return this._emit("abort", error);
            }
            if (error instanceof AnthropicError) {
              return this._emit("error", error);
            }
            if (error instanceof Error) {
              const anthropicError = new AnthropicError(error.message);
              anthropicError.cause = error;
              return this._emit("error", anthropicError);
            }
            return this._emit("error", new AnthropicError(String(error)));
          });
          __classPrivateFieldSet(this, _BetaMessageStream_connectedPromise, new Promise((resolve2, reject) => {
            __classPrivateFieldSet(this, _BetaMessageStream_resolveConnectedPromise, resolve2, "f");
            __classPrivateFieldSet(this, _BetaMessageStream_rejectConnectedPromise, reject, "f");
          }), "f");
          __classPrivateFieldSet(this, _BetaMessageStream_endPromise, new Promise((resolve2, reject) => {
            __classPrivateFieldSet(this, _BetaMessageStream_resolveEndPromise, resolve2, "f");
            __classPrivateFieldSet(this, _BetaMessageStream_rejectEndPromise, reject, "f");
          }), "f");
          __classPrivateFieldGet(this, _BetaMessageStream_connectedPromise, "f").catch(() => {
          });
          __classPrivateFieldGet(this, _BetaMessageStream_endPromise, "f").catch(() => {
          });
          __classPrivateFieldSet(this, _BetaMessageStream_params, params, "f");
          __classPrivateFieldSet(this, _BetaMessageStream_logger, opts?.logger ?? console, "f");
        }
        get response() {
          return __classPrivateFieldGet(this, _BetaMessageStream_response, "f");
        }
        get request_id() {
          return __classPrivateFieldGet(this, _BetaMessageStream_request_id, "f");
        }
        get workspace_id() {
          return __classPrivateFieldGet(this, _BetaMessageStream_workspace_id, "f");
        }
        /**
         * Returns the `MessageStream` data, the raw `Response` instance and the ID of the request,
         * returned vie the `request-id` header which is useful for debugging requests and resporting
         * issues to Anthropic.
         *
         * This is the same as the `APIPromise.withResponse()` method.
         *
         * This method will raise an error if you created the stream using `MessageStream.fromReadableStream`
         * as no `Response` is available.
         */
        async withResponse() {
          __classPrivateFieldSet(this, _BetaMessageStream_catchingPromiseCreated, true, "f");
          const response = await __classPrivateFieldGet(this, _BetaMessageStream_connectedPromise, "f");
          if (!response) {
            throw new Error("Could not resolve a `Response` object");
          }
          return {
            data: this,
            response,
            request_id: response.headers.get("request-id"),
            workspace_id: response.headers.get("anthropic-workspace-id")
          };
        }
        /**
         * Intended for use on the frontend, consuming a stream produced with
         * `.toReadableStream()` on the backend.
         *
         * Note that messages sent to the model do not appear in `.on('message')`
         * in this context.
         */
        static fromReadableStream(stream2) {
          const runner = new BetaMessageStream2(null);
          runner._run(() => runner._fromReadableStream(stream2));
          return runner;
        }
        static createMessage(messages, params, options, { logger } = {}) {
          const runner = new BetaMessageStream2(params, { logger });
          for (const message of params.messages) {
            runner._addMessageParam(message);
          }
          __classPrivateFieldSet(runner, _BetaMessageStream_params, { ...params, stream: true }, "f");
          runner._run(() => runner._createMessage(messages, { ...params, stream: true }, { ...options, headers: { ...options?.headers, [STAINLESS_HELPER_METHOD_HEADER]: "stream" } }));
          return runner;
        }
        _run(executor) {
          executor().then(() => {
            this._emitFinal();
            this._emit("end");
          }, __classPrivateFieldGet(this, _BetaMessageStream_handleError, "f"));
        }
        _addMessageParam(message) {
          this.messages.push(message);
        }
        _addMessage(message, emit = true) {
          this.receivedMessages.push(message);
          if (emit) {
            this._emit("message", message);
          }
        }
        async _createMessage(messages, params, options) {
          const signal = options?.signal;
          let abortHandler;
          if (signal) {
            if (signal.aborted)
              this.controller.abort();
            abortHandler = this.controller.abort.bind(this.controller);
            signal.addEventListener("abort", abortHandler);
          }
          try {
            __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_beginRequest).call(this);
            const { response, data: stream2 } = await messages.create({ ...params, stream: true }, { ...options, signal: this.controller.signal }).withResponse();
            this._connected(response);
            for await (const event of stream2) {
              __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_addStreamEvent).call(this, event);
            }
            if (stream2.controller.signal?.aborted) {
              throw new APIUserAbortError();
            }
            __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_endRequest).call(this);
          } finally {
            if (signal && abortHandler) {
              signal.removeEventListener("abort", abortHandler);
            }
          }
        }
        _connected(response) {
          if (this.ended)
            return;
          __classPrivateFieldSet(this, _BetaMessageStream_response, response, "f");
          __classPrivateFieldSet(this, _BetaMessageStream_request_id, response?.headers.get("request-id"), "f");
          __classPrivateFieldSet(this, _BetaMessageStream_workspace_id, response?.headers.get("anthropic-workspace-id"), "f");
          __classPrivateFieldGet(this, _BetaMessageStream_resolveConnectedPromise, "f").call(this, response);
          this._emit("connect");
        }
        get ended() {
          return __classPrivateFieldGet(this, _BetaMessageStream_ended, "f");
        }
        get errored() {
          return __classPrivateFieldGet(this, _BetaMessageStream_errored, "f");
        }
        get aborted() {
          return __classPrivateFieldGet(this, _BetaMessageStream_aborted, "f");
        }
        abort() {
          this.controller.abort();
        }
        /**
         * Adds the listener function to the end of the listeners array for the event.
         * No checks are made to see if the listener has already been added. Multiple calls passing
         * the same combination of event and listener will result in the listener being added, and
         * called, multiple times.
         * @returns this MessageStream, so that calls can be chained
         */
        on(event, listener) {
          const listeners = __classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event] || (__classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event] = []);
          listeners.push({ listener });
          return this;
        }
        /**
         * Removes the specified listener from the listener array for the event.
         * off() will remove, at most, one instance of a listener from the listener array. If any single
         * listener has been added multiple times to the listener array for the specified event, then
         * off() must be called multiple times to remove each instance.
         * @returns this MessageStream, so that calls can be chained
         */
        off(event, listener) {
          const listeners = __classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event];
          if (!listeners)
            return this;
          const index = listeners.findIndex((l) => l.listener === listener);
          if (index >= 0)
            listeners.splice(index, 1);
          return this;
        }
        /**
         * Adds a one-time listener function for the event. The next time the event is triggered,
         * this listener is removed and then invoked.
         * @returns this MessageStream, so that calls can be chained
         */
        once(event, listener) {
          const listeners = __classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event] || (__classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event] = []);
          listeners.push({ listener, once: true });
          return this;
        }
        /**
         * This is similar to `.once()`, but returns a Promise that resolves the next time
         * the event is triggered, instead of calling a listener callback.
         * @returns a Promise that resolves the next time given event is triggered,
         * or rejects if an error is emitted.  (If you request the 'error' event,
         * returns a promise that resolves with the error).
         *
         * Example:
         *
         *   const message = await stream.emitted('message') // rejects if the stream errors
         */
        emitted(event) {
          return new Promise((resolve2, reject) => {
            __classPrivateFieldSet(this, _BetaMessageStream_catchingPromiseCreated, true, "f");
            if (event !== "error")
              this.once("error", reject);
            this.once(event, resolve2);
          });
        }
        async done() {
          __classPrivateFieldSet(this, _BetaMessageStream_catchingPromiseCreated, true, "f");
          await __classPrivateFieldGet(this, _BetaMessageStream_endPromise, "f");
        }
        get currentMessage() {
          return __classPrivateFieldGet(this, _BetaMessageStream_currentMessageSnapshot, "f");
        }
        /**
         * @returns a promise that resolves with the the final assistant Message response,
         * or rejects if an error occurred or the stream ended prematurely without producing a Message.
         * If structured outputs were used, this will be a ParsedMessage with a `parsed` field.
         */
        async finalMessage() {
          await this.done();
          return __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_getFinalMessage).call(this);
        }
        /**
         * @returns a promise that resolves with the the final assistant Message's text response, concatenated
         * together if there are more than one text blocks.
         * Rejects if an error occurred or the stream ended prematurely without producing a Message.
         */
        async finalText() {
          await this.done();
          return __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_getFinalText).call(this);
        }
        _emit(event, ...args) {
          if (__classPrivateFieldGet(this, _BetaMessageStream_ended, "f"))
            return;
          if (event === "end") {
            __classPrivateFieldSet(this, _BetaMessageStream_ended, true, "f");
            __classPrivateFieldGet(this, _BetaMessageStream_resolveEndPromise, "f").call(this);
          }
          const listeners = __classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event];
          if (listeners) {
            __classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event] = listeners.filter((l) => !l.once);
            listeners.forEach(({ listener }) => listener(...args));
          }
          if (event === "abort") {
            const error = args[0];
            if (!__classPrivateFieldGet(this, _BetaMessageStream_catchingPromiseCreated, "f") && !listeners?.length) {
              Promise.reject(error);
            }
            __classPrivateFieldGet(this, _BetaMessageStream_rejectConnectedPromise, "f").call(this, error);
            __classPrivateFieldGet(this, _BetaMessageStream_rejectEndPromise, "f").call(this, error);
            this._emit("end");
            return;
          }
          if (event === "error") {
            const error = args[0];
            if (!__classPrivateFieldGet(this, _BetaMessageStream_catchingPromiseCreated, "f") && !listeners?.length) {
              Promise.reject(error);
            }
            __classPrivateFieldGet(this, _BetaMessageStream_rejectConnectedPromise, "f").call(this, error);
            __classPrivateFieldGet(this, _BetaMessageStream_rejectEndPromise, "f").call(this, error);
            this._emit("end");
          }
        }
        _emitFinal() {
          const finalMessage = this.receivedMessages.at(-1);
          if (finalMessage) {
            this._emit("finalMessage", __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_getFinalMessage).call(this));
          }
        }
        async _fromReadableStream(readableStream, options) {
          const signal = options?.signal;
          let abortHandler;
          if (signal) {
            if (signal.aborted)
              this.controller.abort();
            abortHandler = this.controller.abort.bind(this.controller);
            signal.addEventListener("abort", abortHandler);
          }
          try {
            __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_beginRequest).call(this);
            this._connected(null);
            const stream2 = Stream.fromReadableStream(readableStream, this.controller);
            for await (const event of stream2) {
              __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_addStreamEvent).call(this, event);
            }
            if (stream2.controller.signal?.aborted) {
              throw new APIUserAbortError();
            }
            __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_endRequest).call(this);
          } finally {
            if (signal && abortHandler) {
              signal.removeEventListener("abort", abortHandler);
            }
          }
        }
        [(_BetaMessageStream_currentMessageSnapshot = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_params = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_connectedPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_resolveConnectedPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_rejectConnectedPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_endPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_resolveEndPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_rejectEndPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_listeners = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_ended = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_errored = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_aborted = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_catchingPromiseCreated = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_response = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_request_id = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_workspace_id = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_logger = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_handleError = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_instances = /* @__PURE__ */ new WeakSet(), _BetaMessageStream_getFinalMessage = function _BetaMessageStream_getFinalMessage2() {
          if (this.receivedMessages.length === 0) {
            throw new AnthropicError("stream ended without producing a Message with role=assistant");
          }
          return this.receivedMessages.at(-1);
        }, _BetaMessageStream_getFinalText = function _BetaMessageStream_getFinalText2() {
          if (this.receivedMessages.length === 0) {
            throw new AnthropicError("stream ended without producing a Message with role=assistant");
          }
          const textBlocks = this.receivedMessages.at(-1).content.filter((block) => block.type === "text").map((block) => block.text);
          if (textBlocks.length === 0) {
            throw new AnthropicError("stream ended without producing a content block with type=text");
          }
          return textBlocks.join(" ");
        }, _BetaMessageStream_beginRequest = function _BetaMessageStream_beginRequest2() {
          if (this.ended)
            return;
          __classPrivateFieldSet(this, _BetaMessageStream_currentMessageSnapshot, void 0, "f");
        }, _BetaMessageStream_addStreamEvent = function _BetaMessageStream_addStreamEvent2(event) {
          if (this.ended)
            return;
          const messageSnapshot = __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_accumulateMessage).call(this, event);
          this._emit("streamEvent", event, messageSnapshot);
          switch (event.type) {
            case "content_block_delta": {
              const content = messageSnapshot.content.at(-1);
              switch (event.delta.type) {
                case "text_delta": {
                  if (content.type === "text") {
                    this._emit("text", event.delta.text, content.text || "");
                  }
                  break;
                }
                case "citations_delta": {
                  if (content.type === "text") {
                    this._emit("citation", event.delta.citation, content.citations ?? []);
                  }
                  break;
                }
                case "input_json_delta": {
                  if (tracksToolInput(content) && __classPrivateFieldGet(this, _BetaMessageStream_listeners, "f").inputJson?.length) {
                    let jsonSnapshot;
                    try {
                      jsonSnapshot = content.input;
                    } catch (err) {
                      __classPrivateFieldGet(this, _BetaMessageStream_handleError, "f").call(this, __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_toolInputParseError).call(this, content, err));
                      break;
                    }
                    this._emit("inputJson", event.delta.partial_json, jsonSnapshot);
                  }
                  break;
                }
                case "thinking_delta": {
                  if (content.type === "thinking") {
                    this._emit("thinking", event.delta.thinking, content.thinking);
                  }
                  break;
                }
                case "signature_delta": {
                  if (content.type === "thinking") {
                    this._emit("signature", content.signature);
                  }
                  break;
                }
                case "compaction_delta": {
                  if (content.type === "compaction" && content.content) {
                    this._emit("compaction", content.content);
                  }
                  break;
                }
                default:
                  checkNever(event.delta);
              }
              break;
            }
            case "message_stop": {
              this._addMessageParam(messageSnapshot);
              this._addMessage(maybeParseBetaMessage(messageSnapshot, __classPrivateFieldGet(this, _BetaMessageStream_params, "f"), { logger: __classPrivateFieldGet(this, _BetaMessageStream_logger, "f") }), true);
              break;
            }
            case "content_block_stop": {
              this._emit("contentBlock", messageSnapshot.content.at(-1));
              break;
            }
            case "message_start": {
              __classPrivateFieldSet(this, _BetaMessageStream_currentMessageSnapshot, messageSnapshot, "f");
              break;
            }
            case "content_block_start":
            case "message_delta":
              break;
          }
        }, _BetaMessageStream_endRequest = function _BetaMessageStream_endRequest2() {
          if (this.ended) {
            throw new AnthropicError(`stream has ended, this shouldn't happen`);
          }
          const snapshot2 = __classPrivateFieldGet(this, _BetaMessageStream_currentMessageSnapshot, "f");
          if (!snapshot2) {
            throw new AnthropicError(`request ended without sending any chunks`);
          }
          __classPrivateFieldSet(this, _BetaMessageStream_currentMessageSnapshot, void 0, "f");
          return maybeParseBetaMessage(snapshot2, __classPrivateFieldGet(this, _BetaMessageStream_params, "f"), { logger: __classPrivateFieldGet(this, _BetaMessageStream_logger, "f") });
        }, _BetaMessageStream_accumulateMessage = function _BetaMessageStream_accumulateMessage2(event) {
          let snapshot2 = __classPrivateFieldGet(this, _BetaMessageStream_currentMessageSnapshot, "f");
          if (event.type === "message_start") {
            if (snapshot2) {
              throw new AnthropicError(`Unexpected event order, got ${event.type} before receiving "message_stop"`);
            }
            return event.message;
          }
          if (!snapshot2) {
            throw new AnthropicError(`Unexpected event order, got ${event.type} before "message_start"`);
          }
          switch (event.type) {
            case "message_stop":
              return snapshot2;
            case "message_delta":
              snapshot2.stop_reason = event.delta.stop_reason;
              snapshot2.stop_sequence = event.delta.stop_sequence;
              snapshot2.stop_details = event.delta.stop_details;
              snapshot2.usage.output_tokens = event.usage.output_tokens;
              if (event.delta.container != null) {
                snapshot2.container = event.delta.container;
              }
              if (event.context_management != null) {
                snapshot2.context_management = event.context_management;
              }
              if (event.input_transformations != null) {
                snapshot2.input_transformations = event.input_transformations;
              }
              if (event.usage.input_tokens != null) {
                snapshot2.usage.input_tokens = event.usage.input_tokens;
              }
              if (event.usage.cache_creation_input_tokens != null) {
                snapshot2.usage.cache_creation_input_tokens = event.usage.cache_creation_input_tokens;
              }
              if (event.usage.cache_read_input_tokens != null) {
                snapshot2.usage.cache_read_input_tokens = event.usage.cache_read_input_tokens;
              }
              if (event.usage.server_tool_use != null) {
                snapshot2.usage.server_tool_use = event.usage.server_tool_use;
              }
              if (event.usage.iterations != null) {
                snapshot2.usage.iterations = event.usage.iterations;
              }
              if (event.usage.fallback_credit != null) {
                snapshot2.usage.fallback_credit = event.usage.fallback_credit;
              }
              if (event.usage.output_tokens_details != null) {
                snapshot2.usage.output_tokens_details = event.usage.output_tokens_details;
              }
              return snapshot2;
            case "content_block_start":
              snapshot2.content.push(event.content_block);
              if (event.content_block.type === "fallback") {
                snapshot2.model = event.content_block.to.model;
              }
              return snapshot2;
            case "content_block_delta": {
              const snapshotContent = snapshot2.content.at(event.index);
              switch (event.delta.type) {
                case "text_delta": {
                  if (snapshotContent?.type === "text") {
                    snapshot2.content[event.index] = {
                      ...snapshotContent,
                      text: (snapshotContent.text || "") + event.delta.text
                    };
                  }
                  break;
                }
                case "citations_delta": {
                  if (snapshotContent?.type === "text") {
                    snapshot2.content[event.index] = {
                      ...snapshotContent,
                      citations: [...snapshotContent.citations ?? [], event.delta.citation]
                    };
                  }
                  break;
                }
                case "input_json_delta": {
                  if (snapshotContent && tracksToolInput(snapshotContent)) {
                    const jsonBuf = (snapshotContent[JSON_BUF_PROPERTY] || "") + event.delta.partial_json;
                    snapshot2.content[event.index] = withLazyInput(snapshotContent, jsonBuf);
                  }
                  break;
                }
                case "thinking_delta": {
                  if (snapshotContent?.type === "thinking") {
                    snapshot2.content[event.index] = {
                      ...snapshotContent,
                      thinking: snapshotContent.thinking + event.delta.thinking
                    };
                  }
                  break;
                }
                case "signature_delta": {
                  if (snapshotContent?.type === "thinking") {
                    snapshot2.content[event.index] = {
                      ...snapshotContent,
                      signature: event.delta.signature
                    };
                  }
                  break;
                }
                case "compaction_delta": {
                  if (snapshotContent?.type === "compaction") {
                    const block = { ...snapshotContent, content: event.delta.content };
                    if ("encrypted_content" in event.delta) {
                      block.encrypted_content = event.delta.encrypted_content;
                    }
                    snapshot2.content[event.index] = block;
                  }
                  break;
                }
                default:
                  checkNever(event.delta);
              }
              return snapshot2;
            }
            case "content_block_stop": {
              const snapshotContent = snapshot2.content.at(event.index);
              if (snapshotContent && tracksToolInput(snapshotContent) && JSON_BUF_PROPERTY in snapshotContent) {
                let input;
                try {
                  input = snapshotContent.input;
                } catch (err) {
                  input = {};
                  __classPrivateFieldGet(this, _BetaMessageStream_handleError, "f").call(this, __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_toolInputParseError).call(this, snapshotContent, err));
                }
                Object.defineProperty(snapshotContent, "input", {
                  value: input,
                  enumerable: true,
                  configurable: true,
                  writable: true
                });
              }
              return snapshot2;
            }
          }
        }, _BetaMessageStream_toolInputParseError = function _BetaMessageStream_toolInputParseError2(block, err) {
          const jsonBuf = block[JSON_BUF_PROPERTY];
          return new AnthropicError(`Unable to parse tool parameter JSON from model. Please retry your request or adjust your prompt. Error: ${err}. JSON: ${jsonBuf}`);
        }, Symbol.asyncIterator)]() {
          const pushQueue = [];
          const readQueue = [];
          let done = false;
          this.on("streamEvent", (event) => {
            const reader = readQueue.shift();
            if (reader) {
              reader.resolve(event);
            } else {
              pushQueue.push(event);
            }
          });
          this.on("end", () => {
            done = true;
            for (const reader of readQueue) {
              reader.resolve(void 0);
            }
            readQueue.length = 0;
          });
          this.on("abort", (err) => {
            done = true;
            for (const reader of readQueue) {
              reader.reject(err);
            }
            readQueue.length = 0;
          });
          this.on("error", (err) => {
            done = true;
            for (const reader of readQueue) {
              reader.reject(err);
            }
            readQueue.length = 0;
          });
          return {
            next: async () => {
              if (!pushQueue.length) {
                if (done) {
                  return { value: void 0, done: true };
                }
                return new Promise((resolve2, reject) => readQueue.push({ resolve: resolve2, reject })).then((chunk2) => chunk2 ? { value: chunk2, done: false } : { value: void 0, done: true });
              }
              const chunk = pushQueue.shift();
              return { value: chunk, done: false };
            },
            return: async () => {
              this.abort();
              return { value: void 0, done: true };
            }
          };
        }
        toReadableStream() {
          const stream2 = new Stream(this[Symbol.asyncIterator].bind(this), this.controller);
          return stream2.toReadableStream();
        }
      }
      return BetaMessageStream2;
    })();
  }
});

// node_modules/@anthropic-ai/sdk/lib/internal/BetaToolRunnerStream.mjs
var _BetaToolRunnerStream_instances, _BetaToolRunnerStream_onToolCall, _BetaToolRunnerStream_emitted, _BetaToolRunnerStream_readers, _BetaToolRunnerStream_toolCalls, _BetaToolRunnerStream_closed, _BetaToolRunnerStream_ready, _BetaToolRunnerStream_fallback, _BetaToolRunnerStream_track, _BetaToolRunnerStream_release, _BetaToolRunnerStream_removeReader, BetaToolRunnerStream;
var init_BetaToolRunnerStream = __esm({
  "node_modules/@anthropic-ai/sdk/lib/internal/BetaToolRunnerStream.mjs"() {
    init_tslib();
    init_stainless_helper_header();
    init_BetaMessageStream();
    BetaToolRunnerStream = /* @__PURE__ */ (() => {
      class BetaToolRunnerStream2 extends BetaMessageStream {
        constructor(params, onToolCall) {
          super(params);
          _BetaToolRunnerStream_instances.add(this);
          _BetaToolRunnerStream_onToolCall.set(this, void 0);
          _BetaToolRunnerStream_emitted.set(this, 0);
          _BetaToolRunnerStream_readers.set(this, []);
          _BetaToolRunnerStream_toolCalls.set(this, []);
          _BetaToolRunnerStream_closed.set(this, void 0);
          _BetaToolRunnerStream_ready.set(this, []);
          _BetaToolRunnerStream_fallback.set(this, false);
          __classPrivateFieldSet(this, _BetaToolRunnerStream_onToolCall, onToolCall, "f");
        }
        /** The `tool_use` blocks that have finished streaming, in the model's order */
        get toolCalls() {
          return __classPrivateFieldGet(this, _BetaToolRunnerStream_toolCalls, "f");
        }
        /** Sends the request as `client.beta.messages.stream()` does. */
        static start(messages, params, options, onToolCall) {
          const stream2 = new BetaToolRunnerStream2({ ...params, stream: true }, onToolCall);
          for (const message of params.messages) {
            stream2._addMessageParam(message);
          }
          stream2._run(() => stream2._createMessage(messages, { ...params, stream: true }, { ...options, headers: { ...options?.headers, [STAINLESS_HELPER_METHOD_HEADER]: "stream" } }));
          return stream2;
        }
        _emit(event, ...args) {
          var _a2;
          if (event !== "streamEvent" || this.ended) {
            super._emit(event, ...args);
            return;
          }
          __classPrivateFieldSet(this, _BetaToolRunnerStream_emitted, (_a2 = __classPrivateFieldGet(this, _BetaToolRunnerStream_emitted, "f"), _a2++, _a2), "f");
          const [streamEvent, snapshot2] = args;
          const block = streamEvent.type === "content_block_stop" ? snapshot2.content[streamEvent.index] : void 0;
          const closed = block?.type === "tool_use" ? block : void 0;
          if (closed) {
            __classPrivateFieldGet(this, _BetaToolRunnerStream_toolCalls, "f").push(closed);
          }
          super._emit(event, ...args);
          __classPrivateFieldGet(this, _BetaToolRunnerStream_instances, "m", _BetaToolRunnerStream_track).call(this, streamEvent, closed);
          __classPrivateFieldGet(this, _BetaToolRunnerStream_instances, "m", _BetaToolRunnerStream_release).call(this);
        }
        [(_BetaToolRunnerStream_onToolCall = /* @__PURE__ */ new WeakMap(), _BetaToolRunnerStream_emitted = /* @__PURE__ */ new WeakMap(), _BetaToolRunnerStream_readers = /* @__PURE__ */ new WeakMap(), _BetaToolRunnerStream_toolCalls = /* @__PURE__ */ new WeakMap(), _BetaToolRunnerStream_closed = /* @__PURE__ */ new WeakMap(), _BetaToolRunnerStream_ready = /* @__PURE__ */ new WeakMap(), _BetaToolRunnerStream_fallback = /* @__PURE__ */ new WeakMap(), _BetaToolRunnerStream_instances = /* @__PURE__ */ new WeakSet(), Symbol.asyncIterator)]() {
          const iterator = super[Symbol.asyncIterator]();
          const reader = { handled: __classPrivateFieldGet(this, _BetaToolRunnerStream_emitted, "f") };
          __classPrivateFieldGet(this, _BetaToolRunnerStream_readers, "f").push(reader);
          let holdsEvent = false;
          return {
            next: async () => {
              if (holdsEvent) {
                holdsEvent = false;
                reader.handled++;
                __classPrivateFieldGet(this, _BetaToolRunnerStream_instances, "m", _BetaToolRunnerStream_release).call(this);
              }
              try {
                const result = await iterator.next();
                holdsEvent = !result.done;
                if (result.done) {
                  __classPrivateFieldGet(this, _BetaToolRunnerStream_instances, "m", _BetaToolRunnerStream_removeReader).call(this, reader);
                }
                return result;
              } catch (error) {
                __classPrivateFieldGet(this, _BetaToolRunnerStream_instances, "m", _BetaToolRunnerStream_removeReader).call(this, reader);
                throw error;
              }
            },
            return: async () => {
              const result = iterator.return?.();
              __classPrivateFieldGet(this, _BetaToolRunnerStream_instances, "m", _BetaToolRunnerStream_removeReader).call(this, reader);
              return await result ?? { value: void 0, done: true };
            }
          };
        }
      }
      _BetaToolRunnerStream_track = function _BetaToolRunnerStream_track2(event, closed) {
        if (__classPrivateFieldGet(this, _BetaToolRunnerStream_fallback, "f")) {
          return;
        }
        if (event.type === "content_block_start" && event.content_block.type === "fallback") {
          __classPrivateFieldSet(this, _BetaToolRunnerStream_fallback, true, "f");
          __classPrivateFieldSet(this, _BetaToolRunnerStream_closed, void 0, "f");
          return;
        }
        const movedOn = event.type === "content_block_start" || event.type === "message_delta" && event.delta.stop_reason === "tool_use";
        if (__classPrivateFieldGet(this, _BetaToolRunnerStream_closed, "f") && movedOn) {
          __classPrivateFieldGet(this, _BetaToolRunnerStream_ready, "f").push({ toolUse: __classPrivateFieldGet(this, _BetaToolRunnerStream_closed, "f"), event: __classPrivateFieldGet(this, _BetaToolRunnerStream_emitted, "f") });
          __classPrivateFieldSet(this, _BetaToolRunnerStream_closed, void 0, "f");
        }
        if (closed) {
          __classPrivateFieldSet(this, _BetaToolRunnerStream_closed, closed, "f");
        }
      }, _BetaToolRunnerStream_release = function _BetaToolRunnerStream_release2() {
        if (this.errored || this.controller.signal.aborted) {
          return;
        }
        const handled = Math.min(__classPrivateFieldGet(this, _BetaToolRunnerStream_emitted, "f"), ...__classPrivateFieldGet(this, _BetaToolRunnerStream_readers, "f").map((reader) => reader.handled));
        while (__classPrivateFieldGet(this, _BetaToolRunnerStream_ready, "f")[0] && __classPrivateFieldGet(this, _BetaToolRunnerStream_ready, "f")[0].event <= handled) {
          __classPrivateFieldGet(this, _BetaToolRunnerStream_onToolCall, "f").call(this, __classPrivateFieldGet(this, _BetaToolRunnerStream_ready, "f").shift().toolUse);
        }
      }, _BetaToolRunnerStream_removeReader = function _BetaToolRunnerStream_removeReader2(reader) {
        const index = __classPrivateFieldGet(this, _BetaToolRunnerStream_readers, "f").indexOf(reader);
        if (index >= 0) {
          __classPrivateFieldGet(this, _BetaToolRunnerStream_readers, "f").splice(index, 1);
          __classPrivateFieldGet(this, _BetaToolRunnerStream_instances, "m", _BetaToolRunnerStream_release).call(this);
        }
      };
      return BetaToolRunnerStream2;
    })();
  }
});

// node_modules/@anthropic-ai/sdk/lib/tools/BetaToolRunner.mjs
function rejectCompactionParam(params) {
  if ("compaction" in params && params.compaction != null) {
    throw new AnthropicError("`compaction` cannot be set on a tool runner: every request in the loop would compact again. Call `runner.compactBeforeNextTurn()` when the conversation should be compacted instead.");
  }
}
function rejectCompactionControl(params) {
  if ("compactionControl" in params && params.compactionControl != null) {
    throw new AnthropicError("`compactionControl` has been removed from the tool runner. Use server-side compaction instead: call `runner.compactBeforeNextTurn()` when the conversation should be compacted.");
  }
}
function rejectRunToolsEagerlyWithoutStream(params) {
  if (params.runToolsEagerly && !params.stream) {
    throw new TypeError("`runToolsEagerly: true` needs `stream: true` in the tool runner's params, because a reply that isn't streamed arrives whole.");
  }
}
function rejectCompactionEdit(params) {
  if (params.context_management?.edits?.some((edit) => edit.type.startsWith("compact_"))) {
    throw new AnthropicError("`compactBeforeNextTurn()` can't be used while `context_management` has a compaction edit, because the API doesn't accept a compaction block together with one. Remove the edit first.");
  }
}
function withoutCompactionIncompatibleParams(params) {
  const { context_management, stop_sequences, output_format, ...kept } = params;
  const withoutFormat = ({ format, ...outputConfig }) => outputConfig;
  if (kept.tool_choice?.type === "any" || kept.tool_choice?.type === "tool") {
    delete kept.tool_choice;
  }
  if (kept.output_config) {
    kept.output_config = withoutFormat(kept.output_config);
  }
  if (Array.isArray(kept.fallbacks)) {
    kept.fallbacks = kept.fallbacks.map((fallback) => fallback.output_config ? { ...fallback, output_config: withoutFormat(fallback.output_config) } : fallback);
  }
  return kept;
}
async function generateToolResponse(runnable, available2, lastMessage, requestOptions, calls) {
  if (!lastMessage || lastMessage.role !== "assistant" || !lastMessage.content || typeof lastMessage.content === "string") {
    return null;
  }
  const toolUseBlocks = lastMessage.content.filter((content) => content.type === "tool_use");
  if (toolUseBlocks.length === 0) {
    return null;
  }
  const toolResults = await Promise.all(toolUseBlocks.map((toolUse) => {
    const call = calls?.get(toolUse.id);
    if (call?.status === "started") {
      return call.result;
    }
    const result = runToolCall(runnable, available2, toolUse, requestOptions);
    calls?.set(toolUse.id, { status: "started", result });
    return result;
  }));
  return {
    role: "user",
    content: toolResults
  };
}
async function runToolCall(runnable, available2, toolUse, requestOptions) {
  const tool = available2.has(toolUse.name) ? runnable.get(toolUse.name) : void 0;
  if (!tool) {
    return toolNotFoundResult(toolUse);
  }
  try {
    let input = toolUse.input;
    if ("parse" in tool && tool.parse) {
      input = tool.parse(input);
    }
    const result = await tool.run(input, {
      toolUse,
      toolUseBlock: toolUse,
      signal: requestOptions?.signal
    });
    return {
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: result
    };
  } catch (error) {
    return {
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: error instanceof ToolError ? error.content : `Error: ${error instanceof Error ? error.message : String(error)}`,
      is_error: true
    };
  }
}
function asContentParam(content) {
  return content;
}
function toolNotFoundResult(toolUse) {
  return {
    type: "tool_result",
    tool_use_id: toolUse.id,
    content: `Error: Tool '${toolUse.name}' not found`,
    is_error: true
  };
}
function applyToolChange(block, available2) {
  switch (block.type) {
    case "tool_removal":
    case "tool_addition":
      applyToolReference(block, available2);
      break;
  }
}
function applyToolReference(block, available2) {
  const name = changedToolName(block.tool);
  if (name === void 0)
    return;
  if (block.type === "tool_removal") {
    available2.delete(name);
  } else {
    available2.add(name);
  }
}
function changedToolName(tool) {
  switch (tool.type) {
    case "tool_reference":
      return tool.name;
    case "tool_definition":
      return "name" in tool.definition ? tool.definition.name : void 0;
    default:
      return void 0;
  }
}
function determineNextStepFromStopReason(stopReason) {
  if (stopReason === null)
    return "stop";
  switch (stopReason) {
    case "tool_use":
      return "run_tools";
    case "pause_turn":
    // pause_after_compaction hands the turn back before the model answers; sending it back
    // unchanged continues it.
    case "compaction":
      return "resume";
    case "end_turn":
    case "stop_sequence":
    case "max_tokens":
    case "model_context_window_exceeded":
    case "refusal":
      return "stop";
    default:
      checkNever(stopReason);
      return "stop";
  }
}
var _BetaToolRunner_instances, _BetaToolRunner_consumed, _BetaToolRunner_mutated, _BetaToolRunner_state, _BetaToolRunner_options, _BetaToolRunner_message, _BetaToolRunner_stream, _BetaToolRunner_toolResponse, _BetaToolRunner_completion, _BetaToolRunner_iterationCount, _BetaToolRunner_compaction, _BetaToolRunner_calls, _BetaToolRunner_lastStopReason, _BetaToolRunner_toolOverrides, _BetaToolRunner_pendingToolChanges, _BetaToolRunner_send, _BetaToolRunner_streamThatStartsTools, _BetaToolRunner_startedCallsSettled, _BetaToolRunner_compact, _BetaToolRunner_runnableTools, _BetaToolRunner_availableToolNames, _BetaToolRunner_recordRemovalsFromHistory, _BetaToolRunner_compactAfterFinalTurn, _BetaToolRunner_generateToolResponse, _BetaToolRunner_flushPendingToolChanges, _BetaToolRunner_pendingToolChangesMessage, BetaToolRunner;
var init_BetaToolRunner = __esm({
  "node_modules/@anthropic-ai/sdk/lib/tools/BetaToolRunner.mjs"() {
    init_tslib();
    init_ToolError();
    init_error();
    init_BetaToolRunnerStream();
    init_headers();
    init_promise();
    init_values();
    init_log();
    init_stainless_helper_header();
    BetaToolRunner = /* @__PURE__ */ (() => {
      class BetaToolRunner2 {
        constructor(client2, params, options) {
          _BetaToolRunner_instances.add(this);
          this.client = client2;
          _BetaToolRunner_consumed.set(this, false);
          _BetaToolRunner_mutated.set(this, false);
          _BetaToolRunner_state.set(this, void 0);
          _BetaToolRunner_options.set(this, void 0);
          _BetaToolRunner_message.set(this, void 0);
          _BetaToolRunner_stream.set(this, void 0);
          _BetaToolRunner_toolResponse.set(this, void 0);
          _BetaToolRunner_completion.set(this, void 0);
          _BetaToolRunner_iterationCount.set(this, 0);
          _BetaToolRunner_compaction.set(this, { status: "idle" });
          _BetaToolRunner_calls.set(this, void 0);
          _BetaToolRunner_lastStopReason.set(this, null);
          _BetaToolRunner_toolOverrides.set(this, /* @__PURE__ */ new Map());
          _BetaToolRunner_pendingToolChanges.set(this, []);
          rejectCompactionParam(params);
          rejectCompactionControl(params);
          rejectRunToolsEagerlyWithoutStream(params);
          __classPrivateFieldSet(this, _BetaToolRunner_state, {
            params: {
              // You can't clone the entire params since there are functions as handlers.
              // You also don't really need to clone params.messages, but it probably will prevent a foot gun
              // somewhere.
              ...params,
              // Not structuredClone(): it throws on a function, and a runnable tool written by value into a
              // `tool_addition` block has `run`. A JSON copy is the messages as they are sent, which drops it.
              messages: JSON.parse(JSON.stringify(params.messages))
            }
          }, "f");
          const collected = collectStainlessHelpers(params.tools, params.messages);
          __classPrivateFieldSet(this, _BetaToolRunner_options, {
            ...options,
            headers: buildHeaders([
              helperHeader("BetaToolRunner"),
              collected.length ? { [STAINLESS_HELPER_HEADER]: collected.join(", ") } : void 0,
              options?.headers
            ])
          }, "f");
          __classPrivateFieldSet(this, _BetaToolRunner_completion, promiseWithResolvers(), "f");
        }
        async *[(_BetaToolRunner_consumed = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_mutated = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_state = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_options = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_message = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_stream = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_toolResponse = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_completion = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_iterationCount = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_compaction = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_calls = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_lastStopReason = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_toolOverrides = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_pendingToolChanges = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_instances = /* @__PURE__ */ new WeakSet(), Symbol.asyncIterator)]() {
          var _a2;
          if (__classPrivateFieldGet(this, _BetaToolRunner_consumed, "f")) {
            throw new AnthropicError("Cannot iterate over a consumed stream");
          }
          __classPrivateFieldSet(this, _BetaToolRunner_consumed, true, "f");
          __classPrivateFieldSet(this, _BetaToolRunner_mutated, true, "f");
          __classPrivateFieldSet(this, _BetaToolRunner_toolResponse, void 0, "f");
          try {
            while (true) {
              try {
                if (__classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.max_iterations && __classPrivateFieldGet(this, _BetaToolRunner_iterationCount, "f") >= __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.max_iterations) {
                  break;
                }
                __classPrivateFieldGet(this, _BetaToolRunner_instances, "m", _BetaToolRunner_flushPendingToolChanges).call(this);
                if (__classPrivateFieldGet(this, _BetaToolRunner_compaction, "f").status === "scheduled" && determineNextStepFromStopReason(__classPrivateFieldGet(this, _BetaToolRunner_lastStopReason, "f")) !== "resume") {
                  yield* __classPrivateFieldGet(this, _BetaToolRunner_instances, "m", _BetaToolRunner_compact).call(this, __classPrivateFieldGet(this, _BetaToolRunner_compaction, "f").config);
                  continue;
                }
                __classPrivateFieldSet(this, _BetaToolRunner_mutated, false, "f");
                __classPrivateFieldSet(this, _BetaToolRunner_toolResponse, void 0, "f");
                __classPrivateFieldSet(this, _BetaToolRunner_iterationCount, (_a2 = __classPrivateFieldGet(this, _BetaToolRunner_iterationCount, "f"), _a2++, _a2), "f");
                __classPrivateFieldSet(this, _BetaToolRunner_message, void 0, "f");
                const { max_iterations, runToolsEagerly, ...params } = __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params;
                yield* __classPrivateFieldGet(this, _BetaToolRunner_instances, "m", _BetaToolRunner_send).call(this, params);
                if (!__classPrivateFieldGet(this, _BetaToolRunner_mutated, "f")) {
                  const message = await __classPrivateFieldGet(this, _BetaToolRunner_message, "f");
                  const nextStep = determineNextStepFromStopReason(message.stop_reason);
                  __classPrivateFieldSet(this, _BetaToolRunner_lastStopReason, message.stop_reason, "f");
                  __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.messages.push({
                    role: message.role,
                    content: asContentParam(message.content)
                  });
                  const { container } = __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params;
                  if (message.container) {
                    if (container == null) {
                      __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.container = message.container.id;
                    } else if (typeof container === "object" && container.id == null) {
                      __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.container = { ...container, id: message.container.id };
                    }
                  }
                  if (nextStep === "stop") {
                    yield* __classPrivateFieldGet(this, _BetaToolRunner_instances, "m", _BetaToolRunner_compactAfterFinalTurn).call(this);
                    break;
                  }
                  if (nextStep === "resume") {
                    continue;
                  }
                } else {
                  __classPrivateFieldSet(this, _BetaToolRunner_lastStopReason, null, "f");
                }
                const toolMessage = await __classPrivateFieldGet(this, _BetaToolRunner_instances, "m", _BetaToolRunner_generateToolResponse).call(this, __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.messages.at(-1));
                if (toolMessage) {
                  __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.messages.push(toolMessage);
                } else if (!__classPrivateFieldGet(this, _BetaToolRunner_mutated, "f")) {
                  yield* __classPrivateFieldGet(this, _BetaToolRunner_instances, "m", _BetaToolRunner_compactAfterFinalTurn).call(this);
                  break;
                }
              } finally {
                __classPrivateFieldGet(this, _BetaToolRunner_stream, "f")?.abort();
                __classPrivateFieldSet(this, _BetaToolRunner_stream, void 0, "f");
              }
            }
            await __classPrivateFieldGet(this, _BetaToolRunner_instances, "m", _BetaToolRunner_startedCallsSettled).call(this);
            if (!__classPrivateFieldGet(this, _BetaToolRunner_message, "f")) {
              throw new AnthropicError("ToolRunner concluded without a message from the server");
            }
            __classPrivateFieldGet(this, _BetaToolRunner_completion, "f").resolve(await __classPrivateFieldGet(this, _BetaToolRunner_message, "f"));
          } catch (error) {
            __classPrivateFieldSet(this, _BetaToolRunner_consumed, false, "f");
            __classPrivateFieldGet(this, _BetaToolRunner_completion, "f").promise.catch(() => {
            });
            __classPrivateFieldGet(this, _BetaToolRunner_completion, "f").reject(error);
            __classPrivateFieldSet(this, _BetaToolRunner_completion, promiseWithResolvers(), "f");
            throw error;
          }
        }
        setMessagesParams(paramsOrMutator) {
          const params = typeof paramsOrMutator === "function" ? paramsOrMutator(__classPrivateFieldGet(this, _BetaToolRunner_state, "f").params) : paramsOrMutator;
          rejectCompactionParam(params);
          rejectRunToolsEagerlyWithoutStream(params);
          if (__classPrivateFieldGet(this, _BetaToolRunner_compaction, "f").status !== "idle") {
            rejectCompactionEdit(params);
          }
          if (__classPrivateFieldGet(this, _BetaToolRunner_compaction, "f").status === "in_flight" && params.messages !== __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.messages) {
            throw new AnthropicError("Message params can't be changed while the conversation is being compacted, because the compaction response is about to replace them. Change them after this iteration instead.");
          }
          __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params = params;
          __classPrivateFieldSet(this, _BetaToolRunner_mutated, true, "f");
          __classPrivateFieldSet(this, _BetaToolRunner_toolResponse, void 0, "f");
        }
        setRequestOptions(optionsOrMutator) {
          if (typeof optionsOrMutator === "function") {
            __classPrivateFieldSet(this, _BetaToolRunner_options, optionsOrMutator(__classPrivateFieldGet(this, _BetaToolRunner_options, "f")), "f");
          } else {
            __classPrivateFieldSet(this, _BetaToolRunner_options, { ...__classPrivateFieldGet(this, _BetaToolRunner_options, "f"), ...optionsOrMutator }, "f");
          }
        }
        /**
         * Get the tool response for the last message from the assistant.
         * Avoids redundant tool executions by caching results. With `runToolsEagerly`, it reuses the calls of
         * the reply that have started and runs the rest, including the ones `deferToolCall()` is holding, so that no
         * call runs twice.
         *
         * @returns A promise that resolves to a BetaMessageParam containing tool results, or null if no tools need to be executed
         *
         * @example
         * const toolResponse = await runner.generateToolResponse();
         * if (toolResponse) {
         *   console.log('Tool results:', toolResponse.content);
         * }
         */
        async generateToolResponse(signal = __classPrivateFieldGet(this, _BetaToolRunner_options, "f").signal) {
          const message = await __classPrivateFieldGet(this, _BetaToolRunner_message, "f") ?? this.params.messages.at(-1);
          if (!message) {
            return null;
          }
          return __classPrivateFieldGet(this, _BetaToolRunner_instances, "m", _BetaToolRunner_generateToolResponse).call(this, message, signal);
        }
        /**
         * Hold a tool call of the current reply until you are done with the reply, which is when it runs without
         * streaming: at the end of the loop body, or when you call `generateToolResponse()`.
         *
         * With `runToolsEagerly` the runner otherwise starts each call while the reply streams, as soon as
         * the model has moved on from it: when the next block starts, or the reply stops with `tool_use`. A call
         * never starts before your stream listeners and any `for await` over the stream have handled that event, so
         * you can call this from either once you have seen the call. The other calls of the reply still start early.
         * It does nothing for a call that has started, outside the loop body, and without `runToolsEagerly`.
         *
         * @param toolUse - The `tool_use` block of the call, or its id
         *
         * @example
         * for await (const stream of runner) {
         *   stream.on('contentBlock', (block) => {
         *     if (block.type === 'tool_use' && block.name === 'delete_file') {
         *       runner.deferToolCall(block);
         *     }
         *   });
         *   await stream.finalMessage();
         *   // No `delete_file` call has started yet.
         * }
         */
        deferToolCall(toolUse) {
          const id = typeof toolUse === "string" ? toolUse : toolUse.id;
          if (__classPrivateFieldGet(this, _BetaToolRunner_calls, "f") && !__classPrivateFieldGet(this, _BetaToolRunner_calls, "f").has(id)) {
            __classPrivateFieldGet(this, _BetaToolRunner_calls, "f").set(id, { status: "held" });
          }
        }
        /**
         * The tool calls of the current reply that `deferToolCall()` is holding, in the model's order, as their
         * `tool_use` blocks. A call is in the list once its block has finished streaming, so read the list when you
         * are done with the stream. A call that has started is not in it. It is empty without
         * `runToolsEagerly`.
         *
         * Held calls are listed whatever the reply's `stop_reason`, because `generateToolResponse()` runs them
         * whatever it is. After `max_tokens` the input of the last call can be cut off.
         *
         * @example
         * for await (const stream of runner) {
         *   stream.on('contentBlock', (block) => {
         *     if (block.type === 'tool_use' && block.name === 'delete_file') {
         *       runner.deferToolCall(block);
         *     }
         *   });
         *   await stream.finalMessage();
         *
         *   const held = runner.deferredToolCalls;
         *   if (held.length > 0 && !(await confirm(held))) break;
         * }
         */
        get deferredToolCalls() {
          const stream2 = __classPrivateFieldGet(this, _BetaToolRunner_stream, "f");
          const calls = __classPrivateFieldGet(this, _BetaToolRunner_calls, "f");
          if (!(stream2 instanceof BetaToolRunnerStream) || !calls) {
            return [];
          }
          return stream2.toolCalls.filter((toolUse) => calls.get(toolUse.id)?.status === "held");
        }
        /**
         * Wait for the async iterator to complete. This works even if the async iterator hasn't yet started, and
         * will wait for an instance to start and go to completion.
         *
         * @returns A promise that resolves to the final BetaMessage when the iterator completes
         *
         * @example
         * // Start consuming the iterator
         * for await (const message of runner) {
         *   console.log('Message:', message.content);
         * }
         *
         * // Meanwhile, wait for completion from another part of the code
         * const finalMessage = await runner.done();
         * console.log('Final response:', finalMessage.content);
         */
        done() {
          return __classPrivateFieldGet(this, _BetaToolRunner_completion, "f").promise;
        }
        /**
         * Returns a promise indicating that the stream is done. Unlike .done(), this will eagerly read the stream:
         * * If the iterator has not been consumed, consume the entire iterator and return the final message from the
         * assistant.
         * * If the iterator has been consumed, waits for it to complete and returns the final message.
         *
         * @returns A promise that resolves to the final BetaMessage from the conversation
         * @throws {AnthropicError} If no messages were processed during the conversation
         *
         * @example
         * const finalMessage = await runner.runUntilDone();
         * console.log('Final response:', finalMessage.content);
         */
        async runUntilDone() {
          if (!__classPrivateFieldGet(this, _BetaToolRunner_consumed, "f")) {
            for await (const _ of this) {
            }
          }
          return this.done();
        }
        /**
         * Get the current parameters being used by the ToolRunner.
         *
         * @returns A readonly view of the current ToolRunnerParams
         *
         * @example
         * const currentParams = runner.params;
         * console.log('Current model:', currentParams.model);
         * console.log('Message count:', currentParams.messages.length);
         */
        get params() {
          return __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params;
        }
        /**
         * Add one or more messages to the conversation history.
         *
         * @param messages - One or more BetaMessageParam objects to add to the conversation
         *
         * @example
         * runner.pushMessages(
         *   { role: 'user', content: 'Also, what about the weather in NYC?' }
         * );
         *
         * @example
         * // Adding multiple messages
         * runner.pushMessages(
         *   { role: 'user', content: 'What about NYC?' },
         *   { role: 'user', content: 'And Boston?' }
         * );
         */
        pushMessages(...messages) {
          this.setMessagesParams((params) => ({
            ...params,
            messages: [...params.messages, ...messages]
          }));
        }
        /**
         * Schedule a compaction of the conversation. Once the current turn has finished, including any tool
         * calls, the runner requests a summary and replaces the message history with the compaction response,
         * which is yielded like any other message. Requires the `compact-2026-09-04` beta.
         *
         * @param compaction - The config to send, as `messages.create()` takes it. Defaults to `{ type: 'summarize' }`
         *
         * @example
         * for await (const message of runner) {
         *   if (message.usage.input_tokens > 100_000) {
         *     runner.compactBeforeNextTurn();
         *   }
         * }
         */
        compactBeforeNextTurn(compaction) {
          if (__classPrivateFieldGet(this, _BetaToolRunner_compaction, "f").status === "in_flight") {
            return;
          }
          rejectCompactionEdit(__classPrivateFieldGet(this, _BetaToolRunner_state, "f").params);
          __classPrivateFieldSet(this, _BetaToolRunner_compaction, { status: "scheduled", config: compaction ?? { type: "summarize" } }, "f");
        }
        /**
         * Give the model more tools without changing `params.tools`, which would miss the prompt cache.
         *
         * Each tool's whole definition is sent in a `tool_addition` block with the next request, and a
         * runnable tool replaces a runnable tool of the same name straight away, even for a call already in
         * the message being handled. A call that started while the reply streamed keeps the old one. A raw
         * definition is only sent: the runner never runs it, and stops running a tool of the same name.
         * Requires the `inline-tools-2026-09-15` beta, which the runner does not add for you.
         *
         * @param tools - Runnable tools (for example from `betaZodTool()`) or raw tool definitions
         *
         * @example
         * runner.addTools(queryDatabaseTool);
         */
        addTools(...tools) {
          for (const tool of tools) {
            if ("name" in tool) {
              __classPrivateFieldGet(this, _BetaToolRunner_toolOverrides, "f").set(tool.name, "run" in tool ? tool : null);
            }
            __classPrivateFieldGet(this, _BetaToolRunner_pendingToolChanges, "f").push({ type: "addition", tool });
          }
        }
        /**
         * Take tools away from the model without changing `params.tools`, which would miss the prompt cache.
         *
         * The tools stop being run straight away: a call to one of them, even one in the message being
         * handled, gets the same "not found" error result as a call to an unknown tool. A call that started
         * while the reply streamed finishes as usual. The model is told in a `tool_removal` block with the
         * next request. Use {@link addTools} to bring a tool back.
         * Requires the `inline-tools-2026-09-15` beta, which the runner does not add for you.
         *
         * @param tools - The tools to remove, or their names
         *
         * @example
         * runner.removeTools('query_database');
         */
        removeTools(...tools) {
          for (const tool of tools) {
            const name = typeof tool === "string" ? tool : tool.name;
            __classPrivateFieldGet(this, _BetaToolRunner_toolOverrides, "f").set(name, null);
            __classPrivateFieldGet(this, _BetaToolRunner_pendingToolChanges, "f").push({ type: "removal", name });
          }
        }
        /**
         * Makes the ToolRunner directly awaitable, equivalent to calling .runUntilDone()
         * This allows using `await runner` instead of `await runner.runUntilDone()`
         */
        then(onfulfilled, onrejected) {
          return this.runUntilDone().then(onfulfilled, onrejected);
        }
      }
      _BetaToolRunner_send = /**
       * Sends one request and yields its message, or its stream when streaming. `#message` and `#stream` are set
       * before the yield, so they are there while the caller handles the item; the loop aborts the stream at the
       * end of the iteration.
       */
      async function* _BetaToolRunner_send2(params) {
        await __classPrivateFieldGet(this, _BetaToolRunner_instances, "m", _BetaToolRunner_startedCallsSettled).call(this);
        __classPrivateFieldSet(this, _BetaToolRunner_calls, void 0, "f");
        if (params.stream) {
          __classPrivateFieldSet(this, _BetaToolRunner_stream, __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.runToolsEagerly ? __classPrivateFieldGet(this, _BetaToolRunner_instances, "m", _BetaToolRunner_streamThatStartsTools).call(this, params) : this.client.beta.messages.stream({ ...params }, __classPrivateFieldGet(this, _BetaToolRunner_options, "f")), "f");
          __classPrivateFieldSet(this, _BetaToolRunner_message, __classPrivateFieldGet(this, _BetaToolRunner_stream, "f").finalMessage(), "f");
          __classPrivateFieldGet(this, _BetaToolRunner_message, "f").catch(() => {
          });
          yield __classPrivateFieldGet(this, _BetaToolRunner_stream, "f");
        } else {
          __classPrivateFieldSet(this, _BetaToolRunner_message, this.client.beta.messages.create({ ...params, stream: false }, __classPrivateFieldGet(this, _BetaToolRunner_options, "f")), "f");
          yield __classPrivateFieldGet(this, _BetaToolRunner_message, "f");
        }
      }, _BetaToolRunner_streamThatStartsTools = function _BetaToolRunner_streamThatStartsTools2(params) {
        const calls = /* @__PURE__ */ new Map();
        __classPrivateFieldSet(this, _BetaToolRunner_calls, calls, "f");
        return BetaToolRunnerStream.start(this.client.beta.messages, params, __classPrivateFieldGet(this, _BetaToolRunner_options, "f"), (toolUse) => {
          if (calls.has(toolUse.id)) {
            return;
          }
          const result = runToolCall(__classPrivateFieldGet(this, _BetaToolRunner_instances, "m", _BetaToolRunner_runnableTools).call(this), __classPrivateFieldGet(this, _BetaToolRunner_instances, "m", _BetaToolRunner_availableToolNames).call(this), toolUse, __classPrivateFieldGet(this, _BetaToolRunner_options, "f"));
          result.catch(() => {
          });
          calls.set(toolUse.id, { status: "started", result });
        });
      }, _BetaToolRunner_startedCallsSettled = /** Waits for the calls of the last streamed reply that have started, whether or not their results were sent. */
      async function _BetaToolRunner_startedCallsSettled2() {
        const started = [...__classPrivateFieldGet(this, _BetaToolRunner_calls, "f")?.values() ?? []].filter((call) => call.status === "started");
        await Promise.allSettled(started.map((call) => call.result));
      }, _BetaToolRunner_compact = async function* _BetaToolRunner_compact2(compaction) {
        rejectCompactionEdit(__classPrivateFieldGet(this, _BetaToolRunner_state, "f").params);
        const { max_iterations, runToolsEagerly, ...requestParams } = __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params;
        const params = withoutCompactionIncompatibleParams(requestParams);
        __classPrivateFieldSet(this, _BetaToolRunner_compaction, { status: "in_flight" }, "f");
        __classPrivateFieldSet(this, _BetaToolRunner_toolResponse, void 0, "f");
        const lastMessage = __classPrivateFieldGet(this, _BetaToolRunner_message, "f");
        try {
          yield* __classPrivateFieldGet(this, _BetaToolRunner_instances, "m", _BetaToolRunner_send).call(this, { ...params, compaction });
          const message = await __classPrivateFieldGet(this, _BetaToolRunner_message, "f");
          if (message.content.some((block) => block.type === "compaction" && block.content)) {
            __classPrivateFieldGet(this, _BetaToolRunner_instances, "m", _BetaToolRunner_recordRemovalsFromHistory).call(this);
            __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.messages = [{ role: message.role, content: message.content }];
          } else {
            loggerFor(this.client).warn("Compaction produced no summary; keeping the conversation as it is.");
            __classPrivateFieldSet(this, _BetaToolRunner_message, lastMessage, "f");
          }
        } finally {
          __classPrivateFieldSet(this, _BetaToolRunner_compaction, { status: "idle" }, "f");
        }
      }, _BetaToolRunner_runnableTools = function _BetaToolRunner_runnableTools2() {
        const runnable = /* @__PURE__ */ new Map();
        for (const tool of __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.tools) {
          if ("run" in tool) {
            runnable.set(tool.name, tool);
          }
        }
        for (const [name, tool] of __classPrivateFieldGet(this, _BetaToolRunner_toolOverrides, "f")) {
          if (tool) {
            runnable.set(name, tool);
          } else {
            runnable.delete(name);
          }
        }
        return runnable;
      }, _BetaToolRunner_availableToolNames = function _BetaToolRunner_availableToolNames2() {
        const available2 = new Set(__classPrivateFieldGet(this, _BetaToolRunner_instances, "m", _BetaToolRunner_runnableTools).call(this).keys());
        for (const message of [...__classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.messages, __classPrivateFieldGet(this, _BetaToolRunner_instances, "m", _BetaToolRunner_pendingToolChangesMessage).call(this)]) {
          if (typeof message.content === "string") {
            continue;
          }
          for (const block of message.content) {
            if (message.role === "system") {
              applyToolChange(block, available2);
            } else if (message.role === "assistant" && block.type === "compaction") {
              for (const change of block.tool_changes ?? []) {
                applyToolChange(change, available2);
              }
            }
          }
        }
        return available2;
      }, _BetaToolRunner_recordRemovalsFromHistory = function _BetaToolRunner_recordRemovalsFromHistory2() {
        const available2 = __classPrivateFieldGet(this, _BetaToolRunner_instances, "m", _BetaToolRunner_availableToolNames).call(this);
        for (const name of __classPrivateFieldGet(this, _BetaToolRunner_instances, "m", _BetaToolRunner_runnableTools).call(this).keys()) {
          if (!available2.has(name)) {
            __classPrivateFieldGet(this, _BetaToolRunner_toolOverrides, "f").set(name, null);
          }
        }
      }, _BetaToolRunner_compactAfterFinalTurn = async function* _BetaToolRunner_compactAfterFinalTurn2() {
        if (__classPrivateFieldGet(this, _BetaToolRunner_compaction, "f").status !== "scheduled") {
          return;
        }
        const lastContent = __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.messages.at(-1)?.content;
        if (Array.isArray(lastContent) && lastContent.some((block) => block.type === "tool_use")) {
          loggerFor(this.client).warn("The pending compaction was skipped because the last turn ended with tool calls that were not run. Call `compactBeforeNextTurn()` again if you continue the conversation.");
          __classPrivateFieldSet(this, _BetaToolRunner_compaction, { status: "idle" }, "f");
          return;
        }
        yield* __classPrivateFieldGet(this, _BetaToolRunner_instances, "m", _BetaToolRunner_compact).call(this, __classPrivateFieldGet(this, _BetaToolRunner_compaction, "f").config);
      }, _BetaToolRunner_generateToolResponse = async function _BetaToolRunner_generateToolResponse2(lastMessage, signal = __classPrivateFieldGet(this, _BetaToolRunner_options, "f").signal) {
        if (__classPrivateFieldGet(this, _BetaToolRunner_toolResponse, "f") !== void 0) {
          return __classPrivateFieldGet(this, _BetaToolRunner_toolResponse, "f");
        }
        __classPrivateFieldSet(this, _BetaToolRunner_toolResponse, generateToolResponse(__classPrivateFieldGet(this, _BetaToolRunner_instances, "m", _BetaToolRunner_runnableTools).call(this), __classPrivateFieldGet(this, _BetaToolRunner_instances, "m", _BetaToolRunner_availableToolNames).call(this), lastMessage, { ...__classPrivateFieldGet(this, _BetaToolRunner_options, "f"), signal }, __classPrivateFieldGet(this, _BetaToolRunner_calls, "f")), "f");
        return __classPrivateFieldGet(this, _BetaToolRunner_toolResponse, "f");
      }, _BetaToolRunner_flushPendingToolChanges = function _BetaToolRunner_flushPendingToolChanges2() {
        if (__classPrivateFieldGet(this, _BetaToolRunner_lastStopReason, "f") === "pause_turn" || __classPrivateFieldGet(this, _BetaToolRunner_pendingToolChanges, "f").length === 0) {
          return;
        }
        __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.messages.push(__classPrivateFieldGet(this, _BetaToolRunner_instances, "m", _BetaToolRunner_pendingToolChangesMessage).call(this));
        __classPrivateFieldSet(this, _BetaToolRunner_pendingToolChanges, [], "f");
      }, _BetaToolRunner_pendingToolChangesMessage = function _BetaToolRunner_pendingToolChangesMessage2() {
        const content = [];
        for (const change of __classPrivateFieldGet(this, _BetaToolRunner_pendingToolChanges, "f")) {
          if (change.type === "removal") {
            content.push({ type: "tool_removal", tool: { type: "tool_reference", name: change.name } });
            continue;
          }
          let definition = change.tool;
          if ("run" in change.tool) {
            const { run, parse, close, ...rest } = change.tool;
            definition = rest;
          }
          content.push({ type: "tool_addition", tool: { type: "tool_definition", definition } });
        }
        return { role: "system", content };
      };
      return BetaToolRunner2;
    })();
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/messages/messages.mjs
function transformOutputFormat(params) {
  if (!params.output_format) {
    return params;
  }
  if (params.output_config?.format) {
    throw new AnthropicError("Both output_format and output_config.format were provided. Please use only output_config.format (output_format is deprecated).");
  }
  const { output_format, ...rest } = params;
  return {
    ...rest,
    output_config: {
      ...params.output_config,
      format: output_format
    }
  };
}
var DEPRECATED_MODELS, MODELS_TO_WARN_WITH_THINKING_ENABLED, Messages;
var init_messages = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/messages/messages.mjs"() {
    init_error2();
    init_batches();
    init_resource();
    init_constants();
    init_headers();
    init_stainless_helper_header();
    init_beta_parser();
    init_BetaMessageStream();
    init_BetaToolRunner();
    init_ToolError();
    init_batches();
    DEPRECATED_MODELS = {};
    MODELS_TO_WARN_WITH_THINKING_ENABLED = ["claude-mythos-preview", "claude-opus-4-6"];
    Messages = /* @__PURE__ */ (() => {
      class Messages3 extends APIResource {
        constructor() {
          super(...arguments);
          this.batches = new Batches(this._client);
        }
        create(params, options) {
          const modifiedParams = transformOutputFormat(params);
          const { betas, user_profile_id, workspace_id, ...body } = modifiedParams;
          if (body.model in DEPRECATED_MODELS) {
            console.warn(`The model '${body.model}' is deprecated and will reach end-of-life on ${DEPRECATED_MODELS[body.model]}
Please migrate to a newer model. Visit https://docs.anthropic.com/en/docs/resources/model-deprecations for more information.`);
          }
          if (MODELS_TO_WARN_WITH_THINKING_ENABLED.includes(body.model) && body.thinking && body.thinking.type === "enabled") {
            console.warn(`Using Claude with ${body.model} and 'thinking.type=enabled' is deprecated. Use 'thinking.type=adaptive' instead which results in better model performance in our testing: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking`);
          }
          let timeout = options?.timeout ?? this._client._options.timeout;
          if (!body.stream && timeout == null) {
            const maxNonstreamingTokens = MODEL_NONSTREAMING_TOKENS[body.model] ?? void 0;
            timeout = this._client.calculateNonstreamingTimeout(body.max_tokens, maxNonstreamingTokens);
          }
          const helperHeader2 = stainlessHelperHeader(body.tools, body.messages);
          return this._client.post("/v1/messages?beta=true", {
            body,
            timeout: timeout ?? 6e5,
            ...options,
            headers: buildHeaders([
              {
                ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0,
                ...user_profile_id != null ? { "anthropic-user-profile-id": user_profile_id } : void 0,
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              helperHeader2,
              options?.headers
            ]),
            stream: modifiedParams.stream ?? false
          });
        }
        /**
         * Send a structured list of input messages with text and/or image content, along with an expected `output_format` and
         * the response will be automatically parsed and available in the `parsed_output` property of the message.
         *
         * @example
         * ```ts
         * const message = await client.beta.messages.parse({
         *   model: 'claude-3-5-sonnet-20241022',
         *   max_tokens: 1024,
         *   messages: [{ role: 'user', content: 'What is 2+2?' }],
         *   output_format: zodOutputFormat(z.object({ answer: z.number() }), 'math'),
         * });
         *
         * console.log(message.parsed_output?.answer); // 4
         * ```
         */
        parse(params, options) {
          options = {
            ...options,
            headers: buildHeaders([
              { "anthropic-beta": [...params.betas ?? [], "structured-outputs-2025-12-15"].toString() },
              options?.headers
            ])
          };
          return this.create(params, options).then((message) => parseBetaMessage(message, params, { logger: this._client.logger ?? console }));
        }
        /**
         * Create a Message stream
         */
        stream(body, options) {
          return BetaMessageStream.createMessage(this, body, options);
        }
        /**
         * Count the number of tokens in a Message.
         *
         * The Token Count API can be used to count the number of tokens in a Message,
         * including tools, images, and documents, without creating it.
         *
         * Learn more about token counting in our
         * [user guide](https://platform.claude.com/docs/en/build-with-claude/token-counting)
         *
         * @example
         * ```ts
         * const betaMessageTokensCount =
         *   await client.beta.messages.countTokens({
         *     messages: [{ content: 'Hello, world', role: 'user' }],
         *     model: 'claude-opus-5',
         *   });
         * ```
         */
        countTokens(params, options) {
          const modifiedParams = transformOutputFormat(params);
          const { betas, user_profile_id, workspace_id, ...body } = modifiedParams;
          return this._client.post("/v1/messages/count_tokens?beta=true", {
            body,
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "token-counting-2024-11-01"].toString(),
                ...user_profile_id != null ? { "anthropic-user-profile-id": user_profile_id } : void 0,
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        toolRunner(body, options) {
          return new BetaToolRunner(this._client, body, options);
        }
      }
      Messages3.Batches = Batches;
      Messages3.BetaToolRunner = BetaToolRunner;
      Messages3.ToolError = ToolError;
      return Messages3;
    })();
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/organization/api-keys.mjs
var APIKeys;
var init_api_keys = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/organization/api-keys.mjs"() {
    init_resource();
    init_pagination();
    init_path();
    APIKeys = class extends APIResource {
      /**
       * Get API Key
       *
       * @example
       * ```ts
       * const betaAPIKey =
       *   await client.beta.organization.apiKeys.retrieve(
       *     'api_key_id',
       *   );
       * ```
       */
      retrieve(apiKeyID, options) {
        return this._client.get(path3`/v1/organizations/api_keys/${apiKeyID}?beta=true`, options);
      }
      /**
       * Update API Key
       *
       * @example
       * ```ts
       * const betaAPIKey =
       *   await client.beta.organization.apiKeys.update(
       *     'api_key_id',
       *   );
       * ```
       */
      update(apiKeyID, body, options) {
        return this._client.post(path3`/v1/organizations/api_keys/${apiKeyID}?beta=true`, { body, ...options });
      }
      /**
       * List API Keys
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaAPIKey of client.beta.organization.apiKeys.list()) {
       *   // ...
       * }
       * ```
       */
      list(query = {}, options) {
        return this._client.getAPIList("/v1/organizations/api_keys?beta=true", Page, {
          query,
          ...options
        });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/organization/compliance-settings.mjs
var ComplianceSettings;
var init_compliance_settings = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/organization/compliance-settings.mjs"() {
    init_resource();
    ComplianceSettings = class extends APIResource {
      /**
       * Retrieve your organization's Compliance Settings.
       *
       * Compliance Settings is a singleton resource: there is exactly one per
       * organization, addressed without an identifier. The `state` field reflects
       * whether the Compliance API is enabled. An organization with a parent
       * organization reads the state inherited from the parent's configuration.
       *
       * @example
       * ```ts
       * const betaComplianceSettings =
       *   await client.beta.organization.complianceSettings.retrieve();
       * ```
       */
      retrieve(options) {
        return this._client.get("/v1/organizations/compliance_settings?beta=true", options);
      }
      /**
       * Update your organization's Compliance Settings.
       *
       * Setting `state` to `enabled` turns on the Compliance API and begins capturing
       * organization activity events. Setting it to `disabled` turns both off. `state`
       * reflects whether the Compliance API is enabled.
       *
       * A request that sets `state` to its current value succeeds and leaves the
       * resource unchanged. A `disabled` request stays in effect until a later `enabled`
       * request or the organization's next provisioning action that enables Access
       * Transparency: enabling Access Transparency also enables the Compliance API,
       * which serves its activity events, so such provisioning (including re-runs)
       * re-enables the Compliance API even after a `disabled` request. Automated
       * provisioning never disables compliance settings.
       *
       * @example
       * ```ts
       * const betaComplianceSettings =
       *   await client.beta.organization.complianceSettings.update({
       *     state: { type: 'enabled' },
       *   });
       * ```
       */
      update(body, options) {
        return this._client.post("/v1/organizations/compliance_settings?beta=true", { body, ...options });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/organization/external-keys.mjs
var ExternalKeys;
var init_external_keys = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/organization/external-keys.mjs"() {
    init_resource();
    init_pagination();
    init_path();
    ExternalKeys = class extends APIResource {
      /**
       * Create an external key config owned by the caller's organization.
       *
       * @example
       * ```ts
       * const betaExternalKey =
       *   await client.beta.organization.externalKeys.create({
       *     provider_config: {
       *       kms_arn:
       *         'arn:aws:kms:us-east-1:111122223333:key/abcd1234-5678-90ab-cdef-000011112222',
       *       type: 'aws',
       *     },
       *   });
       * ```
       */
      create(body, options) {
        return this._client.post("/v1/organizations/external_keys?beta=true", { body, ...options });
      }
      /**
       * Retrieve a single external key config in the caller's organization by ID.
       *
       * @example
       * ```ts
       * const betaExternalKey =
       *   await client.beta.organization.externalKeys.retrieve(
       *     'external_key_id',
       *   );
       * ```
       */
      retrieve(externalKeyID, options) {
        return this._client.get(path3`/v1/organizations/external_keys/${externalKeyID}?beta=true`, options);
      }
      /**
       * Partially update an external key config. Omitted fields are left unchanged.
       *
       * `display_name` is always editable. `geo` and `provider_config` cannot be changed
       * once any workspace references this config, because previously encrypted data
       * requires the original key identity to decrypt.
       *
       * @example
       * ```ts
       * const betaExternalKey =
       *   await client.beta.organization.externalKeys.update(
       *     'external_key_id',
       *   );
       * ```
       */
      update(externalKeyID, body, options) {
        return this._client.post(path3`/v1/organizations/external_keys/${externalKeyID}?beta=true`, {
          body,
          ...options
        });
      }
      /**
       * List external key configs in the caller's organization.
       *
       * Results are ordered by creation time (newest first). Use the `next_page` cursor
       * from the response to fetch subsequent pages.
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaExternalKey of client.beta.organization.externalKeys.list()) {
       *   // ...
       * }
       * ```
       */
      list(query = {}, options) {
        return this._client.getAPIList("/v1/organizations/external_keys?beta=true", PageCursor, {
          query,
          ...options
        });
      }
      /**
       * Delete an external key config.
       *
       * The request is rejected if any workspace still references this config.
       *
       * @example
       * ```ts
       * const externalKey =
       *   await client.beta.organization.externalKeys.delete(
       *     'external_key_id',
       *   );
       * ```
       */
      delete(externalKeyID, options) {
        return this._client.delete(path3`/v1/organizations/external_keys/${externalKeyID}?beta=true`, options);
      }
      /**
       * Validate an external key config against the customer's KMS.
       *
       * Anthropic performs an encrypt/decrypt roundtrip against the configured KMS key
       * and waits up to 30 seconds for the result. The response status is `success` if
       * the roundtrip succeeded, or `failure` with an error message if it failed or
       * timed out.
       *
       * @example
       * ```ts
       * const response =
       *   await client.beta.organization.externalKeys.validate(
       *     'external_key_id',
       *   );
       * ```
       */
      validate(externalKeyID, options) {
        return this._client.post(path3`/v1/organizations/external_keys/${externalKeyID}/validate?beta=true`, options);
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/organization/invites.mjs
var Invites;
var init_invites = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/organization/invites.mjs"() {
    init_resource();
    init_pagination();
    init_path();
    Invites = class extends APIResource {
      /**
       * Invite a user to join the organization by email.
       *
       * On plans that draw members from a finite pool of purchased seats, the invite
       * automatically consumes a seat from the lowest tier with availability; there is
       * no seat-tier parameter. When no seat is free the request fails with a 400 error
       * rather than purchasing a seat.
       *
       * @example
       * ```ts
       * const betaOrganizationInvite =
       *   await client.beta.organization.invites.create({
       *     email: 'user@emaildomain.com',
       *     role: 'user',
       *   });
       * ```
       */
      create(body, options) {
        return this._client.post("/v1/organizations/invites?beta=true", { body, ...options });
      }
      /**
       * Retrieve an invite by ID.
       *
       * @example
       * ```ts
       * const betaOrganizationInvite =
       *   await client.beta.organization.invites.retrieve(
       *     'invite_id',
       *   );
       * ```
       */
      retrieve(inviteID, options) {
        return this._client.get(path3`/v1/organizations/invites/${inviteID}?beta=true`, options);
      }
      /**
       * List the organization's invites.
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaOrganizationInvite of client.beta.organization.invites.list()) {
       *   // ...
       * }
       * ```
       */
      list(query = {}, options) {
        return this._client.getAPIList("/v1/organizations/invites?beta=true", Page, {
          query,
          ...options
        });
      }
      /**
       * Delete a pending invite.
       *
       * @example
       * ```ts
       * const invite =
       *   await client.beta.organization.invites.delete(
       *     'invite_id',
       *   );
       * ```
       */
      delete(inviteID, options) {
        return this._client.delete(path3`/v1/organizations/invites/${inviteID}?beta=true`, options);
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/organization/rate-limits.mjs
var RateLimits;
var init_rate_limits = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/organization/rate-limits.mjs"() {
    init_resource();
    init_pagination();
    RateLimits = class extends APIResource {
      /**
       * List Messages API rate limits for your organization.
       *
       * Each entry corresponds to one rate-limit group (either a model family or an
       * API-surface category such as the Files API or Message Batches) and contains the
       * set of limiter values that apply to it.
       *
       * When `limit` is omitted, every matching entry is returned in a single page; when
       * `limit` truncates the result, follow `next_page` to fetch the remaining entries.
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaOrganizationRateLimit of client.beta.organization.rateLimits.list()) {
       *   // ...
       * }
       * ```
       */
      list(query = {}, options) {
        return this._client.getAPIList("/v1/organizations/rate_limits?beta=true", PageCursor, { query, ...options });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/organization/users.mjs
var Users;
var init_users = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/organization/users.mjs"() {
    init_resource();
    init_pagination();
    init_path();
    Users = class extends APIResource {
      /**
       * Retrieve a member of the organization by user ID.
       *
       * @example
       * ```ts
       * const betaOrganizationUser =
       *   await client.beta.organization.users.retrieve('user_id');
       * ```
       */
      retrieve(userID, options) {
        return this._client.get(path3`/v1/organizations/users/${userID}?beta=true`, options);
      }
      /**
       * Update a member's organization role.
       *
       * @example
       * ```ts
       * const betaOrganizationUser =
       *   await client.beta.organization.users.update('user_id', {
       *     role: 'user',
       *   });
       * ```
       */
      update(userID, body, options) {
        return this._client.post(path3`/v1/organizations/users/${userID}?beta=true`, { body, ...options });
      }
      /**
       * List the organization's members.
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaOrganizationUser of client.beta.organization.users.list()) {
       *   // ...
       * }
       * ```
       */
      list(query = {}, options) {
        return this._client.getAPIList("/v1/organizations/users?beta=true", Page, {
          query,
          ...options
        });
      }
      /**
       * Remove a member from the organization.
       *
       * @example
       * ```ts
       * const user = await client.beta.organization.users.remove(
       *   'user_id',
       * );
       * ```
       */
      remove(userID, options) {
        return this._client.delete(path3`/v1/organizations/users/${userID}?beta=true`, options);
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/organization/federation/issuers.mjs
var Issuers;
var init_issuers = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/organization/federation/issuers.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_path();
    Issuers = class extends APIResource {
      /**
       * **Requires an OAuth access token with the `org:admin` scope**, from
       * `ant auth login --scope org:admin` or a workload identity federation rule; Admin
       * API keys are not accepted. See
       * [Manage WIF with the Admin API](/docs/en/manage-claude/wif-admin-api).
       *
       * Register an OIDC issuer that Anthropic will trust for workload identity
       * federation in your organization.
       *
       * The `jwks` field controls how the issuer's signing keys are obtained and takes
       * one of three shapes selected by `type`: `discovery` (resolve keys through OIDC
       * discovery), `explicit_url` (fetch keys from a fixed JWKS URL), or `inline`
       * (provide a static key set). When `jwks.type` is `discovery` and no
       * `discovery_base` is set, the issuer URL must be publicly reachable over HTTPS so
       * Anthropic can fetch the discovery document; for `explicit_url` and `inline`
       * modes the issuer URL is only matched as the JWT's `iss` claim and is not
       * fetched.
       *
       * @example
       * ```ts
       * const betaFederationIssuer =
       *   await client.beta.organization.federation.issuers.create({
       *     issuer_url: 'x',
       *     name: 'x',
       *   });
       * ```
       */
      create(params, options) {
        const { betas, ...body } = params;
        return this._client.post("/v1/organizations/federation_issuers?beta=true", {
          body,
          ...options,
          headers: buildHeaders([
            { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
            options?.headers
          ])
        });
      }
      /**
       * **Requires an OAuth access token with the `org:admin` scope**, from
       * `ant auth login --scope org:admin` or a workload identity federation rule; Admin
       * API keys are not accepted. See
       * [Manage WIF with the Admin API](/docs/en/manage-claude/wif-admin-api).
       *
       * Retrieve a federation issuer by its ID (`fdis_...`).
       *
       * @example
       * ```ts
       * const betaFederationIssuer =
       *   await client.beta.organization.federation.issuers.retrieve(
       *     'federation_issuer_id',
       *   );
       * ```
       */
      retrieve(federationIssuerID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.get(path3`/v1/organizations/federation_issuers/${federationIssuerID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
            options?.headers
          ])
        });
      }
      /**
       * **Requires an OAuth access token with the `org:admin` scope**, from
       * `ant auth login --scope org:admin` or a workload identity federation rule; Admin
       * API keys are not accepted. See
       * [Manage WIF with the Admin API](/docs/en/manage-claude/wif-admin-api).
       *
       * Partially update a federation issuer.
       *
       * Setting `jwks` replaces the full JWKS shape at once. Archived issuers cannot be
       * updated; this returns 400. Create a new issuer instead.
       *
       * Updating an issuer that backs a rule with a scope outside `workspace:developer`
       * or `workspace:inference` requires a Console session.
       *
       * @example
       * ```ts
       * const betaFederationIssuer =
       *   await client.beta.organization.federation.issuers.update(
       *     'federation_issuer_id',
       *   );
       * ```
       */
      update(federationIssuerID, params, options) {
        const { betas, ...body } = params;
        return this._client.post(path3`/v1/organizations/federation_issuers/${federationIssuerID}?beta=true`, {
          body,
          ...options,
          headers: buildHeaders([
            { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
            options?.headers
          ])
        });
      }
      /**
       * **Requires an OAuth access token with the `org:admin` scope**, from
       * `ant auth login --scope org:admin` or a workload identity federation rule; Admin
       * API keys are not accepted. See
       * [Manage WIF with the Admin API](/docs/en/manage-claude/wif-admin-api).
       *
       * List federation issuers in your organization.
       *
       * Archived issuers are excluded unless `include_archived=true`.
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaFederationIssuer of client.beta.organization.federation.issuers.list()) {
       *   // ...
       * }
       * ```
       */
      list(params = {}, options) {
        const { betas, ...query } = params ?? {};
        return this._client.getAPIList("/v1/organizations/federation_issuers?beta=true", PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
            options?.headers
          ])
        });
      }
      /**
       * **Requires an OAuth access token with the `org:admin` scope**, from
       * `ant auth login --scope org:admin` or a workload identity federation rule; Admin
       * API keys are not accepted. See
       * [Manage WIF with the Admin API](/docs/en/manage-claude/wif-admin-api).
       *
       * Archive a federation issuer.
       *
       * Idempotent; re-archiving returns the issuer with its original `archived_at`.
       * Rejected with 400 if any live (non-archived) federation rule still references
       * the issuer; archive those rules first (a rule's issuer cannot be changed), or
       * recreate them against another issuer.
       *
       * @example
       * ```ts
       * const betaFederationIssuer =
       *   await client.beta.organization.federation.issuers.archive(
       *     'federation_issuer_id',
       *   );
       * ```
       */
      archive(federationIssuerID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.post(path3`/v1/organizations/federation_issuers/${federationIssuerID}/archive?beta=true`, {
          ...options,
          headers: buildHeaders([
            { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
            options?.headers
          ])
        });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/organization/federation/rules/workspaces.mjs
var Workspaces;
var init_workspaces = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/organization/federation/rules/workspaces.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_path();
    Workspaces = class extends APIResource {
      /**
       * **Requires an OAuth access token with the `org:admin` scope**, from
       * `ant auth login --scope org:admin` or a workload identity federation rule; Admin
       * API keys are not accepted. See
       * [Manage WIF with the Admin API](/docs/en/manage-claude/wif-admin-api).
       *
       * List workspaces where this federation rule is enabled.
       *
       * Returns all workspace enablements in a single response; the `limit` and `page`
       * parameters are accepted but have no effect, and `next_page` is always `null`.
       * Returns explicit per-workspace enablements only; for rules with
       * `applies_to_all_workspaces` or a legacy single `workspace_id`, check those
       * fields on the rule itself.
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaFederationRuleWorkspace of client.beta.organization.federation.rules.workspaces.list(
       *   'federation_rule_id',
       * )) {
       *   // ...
       * }
       * ```
       */
      list(federationRuleID, params = {}, options) {
        const { betas, ...query } = params ?? {};
        return this._client.getAPIList(path3`/v1/organizations/federation_rules/${federationRuleID}/workspaces?beta=true`, PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
            options?.headers
          ])
        });
      }
      /**
       * **Requires an OAuth access token with the `org:admin` scope**, from
       * `ant auth login --scope org:admin` or a workload identity federation rule; Admin
       * API keys are not accepted. See
       * [Manage WIF with the Admin API](/docs/en/manage-claude/wif-admin-api).
       *
       * Enable a federation rule for a workspace.
       *
       * Idempotent; re-enabling returns the existing enablement. The rule and workspace
       * must both belong to your organization. Membership of the rule's target service
       * account in this workspace is not checked at enablement: token exchange into this
       * workspace is rejected unless the target is a member (it is implicitly a member
       * of the default workspace). Archived rules are rejected with 400. OAuth callers
       * may only manage rules whose `oauth_scope` is `workspace:developer` or
       * `workspace:inference`; other scopes require a Console session.
       *
       * @example
       * ```ts
       * const betaFederationRuleWorkspace =
       *   await client.beta.organization.federation.rules.workspaces.add(
       *     'federation_rule_id',
       *     { workspace_id: 'workspace_id' },
       *   );
       * ```
       */
      add(federationRuleID, params, options) {
        const { betas, ...body } = params;
        return this._client.post(path3`/v1/organizations/federation_rules/${federationRuleID}/workspaces?beta=true`, {
          body,
          ...options,
          headers: buildHeaders([
            { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
            options?.headers
          ])
        });
      }
      /**
       * **Requires an OAuth access token with the `org:admin` scope**, from
       * `ant auth login --scope org:admin` or a workload identity federation rule; Admin
       * API keys are not accepted. See
       * [Manage WIF with the Admin API](/docs/en/manage-claude/wif-admin-api).
       *
       * Disable a federation rule for a workspace.
       *
       * Idempotent; succeeds even if the enablement was already removed. OAuth callers
       * may only manage rules whose `oauth_scope` is `workspace:developer` or
       * `workspace:inference`; other scopes require a Console session.
       *
       * @example
       * ```ts
       * const workspace =
       *   await client.beta.organization.federation.rules.workspaces.remove(
       *     'workspace_id',
       *     { federation_rule_id: 'federation_rule_id' },
       *   );
       * ```
       */
      remove(workspaceID, params, options) {
        const { federation_rule_id, betas } = params;
        return this._client.delete(path3`/v1/organizations/federation_rules/${federation_rule_id}/workspaces/${workspaceID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
            options?.headers
          ])
        });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/organization/federation/rules/rules.mjs
var Rules;
var init_rules = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/organization/federation/rules/rules.mjs"() {
    init_resource();
    init_workspaces();
    init_workspaces();
    init_pagination();
    init_headers();
    init_path();
    Rules = /* @__PURE__ */ (() => {
      class Rules2 extends APIResource {
        constructor() {
          super(...arguments);
          this.workspaces = new Workspaces(this._client);
        }
        /**
         * **Requires an OAuth access token with the `org:admin` scope**, from
         * `ant auth login --scope org:admin` or a workload identity federation rule; Admin
         * API keys are not accepted. See
         * [Manage WIF with the Admin API](/docs/en/manage-claude/wif-admin-api).
         *
         * Create a federation rule owned by your organization.
         *
         * The referenced issuer and the target service account must already exist in the
         * same organization; invalid references are rejected with a 400 error. The
         * workspace reference is validated. Membership is not checked at rule creation:
         * token exchange resolves a single enabled workspace per call and is rejected
         * unless the target service account is a member of that workspace (it is
         * implicitly a member of the default workspace). Rules on well-known shared
         * issuers (GitHub Actions, GitLab, Buildkite, Terraform Cloud, Google) must
         * constrain tenant identity via an identity-bearing claim, a tenant-pinning
         * subject prefix (such as `repo:YOUR_ORG/...`), or a CEL condition referencing one
         * of those identity claims (e.g. `claims.repository_owner`). OAuth callers may
         * only manage rules whose `oauth_scope` is `workspace:developer` or
         * `workspace:inference`; other scopes require a Console session.
         *
         * @example
         * ```ts
         * const betaFederationRule =
         *   await client.beta.organization.federation.rules.create({
         *     issuer_id: 'issuer_id',
         *     match: {},
         *     name: 'x',
         *     oauth_scope: 'x',
         *     target: {
         *       service_account_id: 'svac_01SDCCSbTxrXDpWc1phhtcfK',
         *       type: 'service_account',
         *     },
         *   });
         * ```
         */
        create(params, options) {
          const { betas, ...body } = params;
          return this._client.post("/v1/organizations/federation_rules?beta=true", {
            body,
            ...options,
            headers: buildHeaders([
              { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
              options?.headers
            ])
          });
        }
        /**
         * **Requires an OAuth access token with the `org:admin` scope**, from
         * `ant auth login --scope org:admin` or a workload identity federation rule; Admin
         * API keys are not accepted. See
         * [Manage WIF with the Admin API](/docs/en/manage-claude/wif-admin-api).
         *
         * Retrieve a federation rule by its ID (`fdrl_...`).
         *
         * @example
         * ```ts
         * const betaFederationRule =
         *   await client.beta.organization.federation.rules.retrieve(
         *     'federation_rule_id',
         *   );
         * ```
         */
        retrieve(federationRuleID, params = {}, options) {
          const { betas } = params ?? {};
          return this._client.get(path3`/v1/organizations/federation_rules/${federationRuleID}?beta=true`, {
            ...options,
            headers: buildHeaders([
              { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
              options?.headers
            ])
          });
        }
        /**
         * **Requires an OAuth access token with the `org:admin` scope**, from
         * `ant auth login --scope org:admin` or a workload identity federation rule; Admin
         * API keys are not accepted. See
         * [Manage WIF with the Admin API](/docs/en/manage-claude/wif-admin-api).
         *
         * Partially update a federation rule.
         *
         * `issuer_id` is immutable. `match` and `target` are replaced as whole objects
         * when set. Referenced service accounts and workspaces must exist in your
         * organization; invalid references are rejected with a 400 error. Archived rules
         * cannot be updated; this returns 400. Create a new rule instead. Rules on
         * well-known shared issuers (GitHub Actions, GitLab, Buildkite, Terraform Cloud,
         * Google) must constrain tenant identity via an identity-bearing claim, a
         * tenant-pinning subject prefix (such as `repo:YOUR_ORG/...`), or a CEL condition
         * referencing one of those identity claims (e.g. `claims.repository_owner`). On
         * these issuers the requirement is re-checked on every update; if an existing
         * rule's stored match does not yet constrain tenant identity, any update (even a
         * rename or description change) must also supply a conforming `match` in the same
         * request. OAuth callers may only manage rules whose `oauth_scope` is
         * `workspace:developer` or `workspace:inference`; other scopes require a Console
         * session.
         *
         * @example
         * ```ts
         * const betaFederationRule =
         *   await client.beta.organization.federation.rules.update(
         *     'federation_rule_id',
         *   );
         * ```
         */
        update(federationRuleID, params, options) {
          const { betas, ...body } = params;
          return this._client.post(path3`/v1/organizations/federation_rules/${federationRuleID}?beta=true`, {
            body,
            ...options,
            headers: buildHeaders([
              { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
              options?.headers
            ])
          });
        }
        /**
         * **Requires an OAuth access token with the `org:admin` scope**, from
         * `ant auth login --scope org:admin` or a workload identity federation rule; Admin
         * API keys are not accepted. See
         * [Manage WIF with the Admin API](/docs/en/manage-claude/wif-admin-api).
         *
         * List federation rules in your organization.
         *
         * Optionally filter by issuer with `issuer_id`. Archived rules are excluded unless
         * `include_archived=true`.
         *
         * @example
         * ```ts
         * // Automatically fetches more pages as needed.
         * for await (const betaFederationRule of client.beta.organization.federation.rules.list()) {
         *   // ...
         * }
         * ```
         */
        list(params = {}, options) {
          const { betas, ...query } = params ?? {};
          return this._client.getAPIList("/v1/organizations/federation_rules?beta=true", PageCursor, {
            query,
            ...options,
            headers: buildHeaders([
              { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
              options?.headers
            ])
          });
        }
        /**
         * **Requires an OAuth access token with the `org:admin` scope**, from
         * `ant auth login --scope org:admin` or a workload identity federation rule; Admin
         * API keys are not accepted. See
         * [Manage WIF with the Admin API](/docs/en/manage-claude/wif-admin-api).
         *
         * Archive a federation rule.
         *
         * Token exchange through this rule stops immediately. Idempotent; re-archiving
         * returns the rule with its original `archived_at`. Archiving clears the rule's
         * workspace targeting (`workspace_id` and `workspace_ids` are emptied). Tokens
         * already minted before archive remain valid until they expire. OAuth callers may
         * only manage rules whose `oauth_scope` is `workspace:developer` or
         * `workspace:inference`; other scopes require a Console session.
         *
         * @example
         * ```ts
         * const betaFederationRule =
         *   await client.beta.organization.federation.rules.archive(
         *     'federation_rule_id',
         *   );
         * ```
         */
        archive(federationRuleID, params = {}, options) {
          const { betas } = params ?? {};
          return this._client.post(path3`/v1/organizations/federation_rules/${federationRuleID}/archive?beta=true`, {
            ...options,
            headers: buildHeaders([
              { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
              options?.headers
            ])
          });
        }
      }
      Rules2.Workspaces = Workspaces;
      return Rules2;
    })();
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/organization/federation/federation.mjs
var Federation;
var init_federation = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/organization/federation/federation.mjs"() {
    init_resource();
    init_issuers();
    init_issuers();
    init_rules();
    init_rules();
    Federation = /* @__PURE__ */ (() => {
      class Federation2 extends APIResource {
        constructor() {
          super(...arguments);
          this.issuers = new Issuers(this._client);
          this.rules = new Rules(this._client);
        }
      }
      Federation2.Issuers = Issuers;
      Federation2.Rules = Rules;
      return Federation2;
    })();
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/organization/service-accounts/workspaces.mjs
var Workspaces2;
var init_workspaces2 = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/organization/service-accounts/workspaces.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_path();
    Workspaces2 = class extends APIResource {
      /**
       * **Requires an OAuth access token with the `org:admin` scope**, from
       * `ant auth login --scope org:admin` or a workload identity federation rule; Admin
       * API keys are not accepted. See
       * [Manage WIF with the Admin API](/docs/en/manage-claude/wif-admin-api).
       *
       * List the workspaces a service account is a member of.
       *
       * Each entry includes the service account's `workspace_role` in that workspace.
       * Use `limit` and the `next_page` cursor to paginate. When the service account has
       * no explicit default-workspace membership, the implicit (`implicit: true`)
       * membership is returned as the first entry on the first page; with `limit=1` the
       * first page may return up to 2 entries (the implicit entry plus one explicit
       * membership) so a pagination cursor can be derived. Memberships are returned only
       * while the service account is active. Without a `page` cursor, an archived
       * service account returns an empty list. A `page` cursor that does not match an
       * active membership returns a 400 invalid-request error. A cursor stops matching
       * when the membership is removed, the workspace is deleted, or the service account
       * is archived. Restart pagination from the first page to recover.
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaServiceAccountWorkspaceMember of client.beta.organization.serviceAccounts.workspaces.list(
       *   'service_account_id',
       * )) {
       *   // ...
       * }
       * ```
       */
      list(serviceAccountID, params = {}, options) {
        const { betas, ...query } = params ?? {};
        return this._client.getAPIList(path3`/v1/organizations/service_accounts/${serviceAccountID}/workspaces?beta=true`, PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
            options?.headers
          ])
        });
      }
      /**
       * **Requires an OAuth access token with the `org:admin` scope**, from
       * `ant auth login --scope org:admin` or a workload identity federation rule; Admin
       * API keys are not accepted. See
       * [Manage WIF with the Admin API](/docs/en/manage-claude/wif-admin-api).
       *
       * Add a service account to a workspace with the given `workspace_role`.
       *
       * Mirror of `POST /workspaces/{workspace_id}/service_accounts`, addressed from the
       * service-account side; both create the same membership. If the service account is
       * already an explicit member of the workspace, its `workspace_role` is replaced
       * with the value supplied here. Archived workspaces return 400. Archived service
       * accounts cannot be added and are rejected.
       *
       * @example
       * ```ts
       * const betaServiceAccountWorkspaceMember =
       *   await client.beta.organization.serviceAccounts.workspaces.add(
       *     'service_account_id',
       *     {
       *       workspace_id: 'workspace_id',
       *       workspace_role: 'workspace_admin',
       *     },
       *   );
       * ```
       */
      add(serviceAccountID, params, options) {
        const { betas, ...body } = params;
        return this._client.post(path3`/v1/organizations/service_accounts/${serviceAccountID}/workspaces?beta=true`, {
          body,
          ...options,
          headers: buildHeaders([
            { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
            options?.headers
          ])
        });
      }
      /**
       * **Requires an OAuth access token with the `org:admin` scope**, from
       * `ant auth login --scope org:admin` or a workload identity federation rule; Admin
       * API keys are not accepted. See
       * [Manage WIF with the Admin API](/docs/en/manage-claude/wif-admin-api).
       *
       * Remove a service account from a workspace.
       *
       * Mirror of
       * `DELETE /workspaces/{workspace_id}/service_accounts/{service_account_id}`,
       * addressed from the service-account side. Removal is idempotent (returns 200 even
       * if the membership was already removed). A DELETE against the implicit
       * default-workspace membership returns 200 but is a no-op and the membership
       * persists; deleting an explicit default-workspace row reverts to the implicit
       * `workspace_user` membership. Archived workspaces return 400.
       *
       * @example
       * ```ts
       * const workspace =
       *   await client.beta.organization.serviceAccounts.workspaces.remove(
       *     'workspace_id',
       *     { service_account_id: 'service_account_id' },
       *   );
       * ```
       */
      remove(workspaceID, params, options) {
        const { service_account_id, betas } = params;
        return this._client.delete(path3`/v1/organizations/service_accounts/${service_account_id}/workspaces/${workspaceID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
            options?.headers
          ])
        });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/organization/service-accounts/service-accounts.mjs
var ServiceAccounts;
var init_service_accounts = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/organization/service-accounts/service-accounts.mjs"() {
    init_resource();
    init_workspaces2();
    init_workspaces2();
    init_pagination();
    init_headers();
    init_path();
    ServiceAccounts = /* @__PURE__ */ (() => {
      class ServiceAccounts3 extends APIResource {
        constructor() {
          super(...arguments);
          this.workspaces = new Workspaces2(this._client);
        }
        /**
         * **Requires an OAuth access token with the `org:admin` scope**, from
         * `ant auth login --scope org:admin` or a workload identity federation rule; Admin
         * API keys are not accepted. See
         * [Manage WIF with the Admin API](/docs/en/manage-claude/wif-admin-api).
         *
         * Create a service account.
         *
         * A service account is a named workload identity that federation rules target.
         * `organization_role` is `developer` (default) or `admin`; a rule may only be
         * created or retargeted to grant `org:admin` scope when the target's
         * `organization_role` is `admin`. Creating an `admin`-role service account
         * requires an interactive credential (a user OAuth token or a Console session) — a
         * workload may only create `developer`-role service accounts.
         *
         * @example
         * ```ts
         * const betaServiceAccount =
         *   await client.beta.organization.serviceAccounts.create({
         *     name: 'ci-deploy-bot',
         *   });
         * ```
         */
        create(params, options) {
          const { betas, ...body } = params;
          return this._client.post("/v1/organizations/service_accounts?beta=true", {
            body,
            ...options,
            headers: buildHeaders([
              { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
              options?.headers
            ])
          });
        }
        /**
         * **Requires an OAuth access token with the `org:admin` scope**, from
         * `ant auth login --scope org:admin` or a workload identity federation rule; Admin
         * API keys are not accepted. See
         * [Manage WIF with the Admin API](/docs/en/manage-claude/wif-admin-api).
         *
         * Retrieve a service account by its ID (`svac_...`).
         *
         * @example
         * ```ts
         * const betaServiceAccount =
         *   await client.beta.organization.serviceAccounts.retrieve(
         *     'service_account_id',
         *   );
         * ```
         */
        retrieve(serviceAccountID, params = {}, options) {
          const { betas } = params ?? {};
          return this._client.get(path3`/v1/organizations/service_accounts/${serviceAccountID}?beta=true`, {
            ...options,
            headers: buildHeaders([
              { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
              options?.headers
            ])
          });
        }
        /**
         * **Requires an OAuth access token with the `org:admin` scope**, from
         * `ant auth login --scope org:admin` or a workload identity federation rule; Admin
         * API keys are not accepted. See
         * [Manage WIF with the Admin API](/docs/en/manage-claude/wif-admin-api).
         *
         * Update a service account.
         *
         * Only `description` and `organization_role` are mutable; `name` cannot be
         * changed. Archived service accounts cannot be updated; this returns 400. Setting
         * `organization_role` to `admin` (even when unchanged) requires an interactive
         * credential (a user OAuth token or a Console session).
         *
         * @example
         * ```ts
         * const betaServiceAccount =
         *   await client.beta.organization.serviceAccounts.update(
         *     'service_account_id',
         *   );
         * ```
         */
        update(serviceAccountID, params, options) {
          const { betas, ...body } = params;
          return this._client.post(path3`/v1/organizations/service_accounts/${serviceAccountID}?beta=true`, {
            body,
            ...options,
            headers: buildHeaders([
              { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
              options?.headers
            ])
          });
        }
        /**
         * **Requires an OAuth access token with the `org:admin` scope**, from
         * `ant auth login --scope org:admin` or a workload identity federation rule; Admin
         * API keys are not accepted. See
         * [Manage WIF with the Admin API](/docs/en/manage-claude/wif-admin-api).
         *
         * List service accounts in the caller's organization.
         *
         * Results are ordered by creation time, newest first. Use `limit` and the
         * `next_page` cursor to paginate; set `include_archived=true` to include archived
         * service accounts.
         *
         * @example
         * ```ts
         * // Automatically fetches more pages as needed.
         * for await (const betaServiceAccount of client.beta.organization.serviceAccounts.list()) {
         *   // ...
         * }
         * ```
         */
        list(params = {}, options) {
          const { betas, ...query } = params ?? {};
          return this._client.getAPIList("/v1/organizations/service_accounts?beta=true", PageCursor, {
            query,
            ...options,
            headers: buildHeaders([
              { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
              options?.headers
            ])
          });
        }
        /**
         * **Requires an OAuth access token with the `org:admin` scope**, from
         * `ant auth login --scope org:admin` or a workload identity federation rule; Admin
         * API keys are not accepted. See
         * [Manage WIF with the Admin API](/docs/en/manage-claude/wif-admin-api).
         *
         * Archive a service account.
         *
         * Idempotent; re-archiving returns the service account with its original
         * `archived_at`. Rejected with 400 if any live (non-archived) federation rule
         * still targets this service account, same as issuer archival; archive those rules
         * first or change their target to another service account.
         *
         * @example
         * ```ts
         * const betaServiceAccount =
         *   await client.beta.organization.serviceAccounts.archive(
         *     'service_account_id',
         *   );
         * ```
         */
        archive(serviceAccountID, params = {}, options) {
          const { betas } = params ?? {};
          return this._client.post(path3`/v1/organizations/service_accounts/${serviceAccountID}/archive?beta=true`, {
            ...options,
            headers: buildHeaders([
              { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
              options?.headers
            ])
          });
        }
      }
      ServiceAccounts3.Workspaces = Workspaces2;
      return ServiceAccounts3;
    })();
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/organization/workspaces/members.mjs
var Members;
var init_members = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/organization/workspaces/members.mjs"() {
    init_resource();
    init_pagination();
    init_path();
    Members = class extends APIResource {
      /**
       * Get Workspace Member
       *
       * @example
       * ```ts
       * const betaWorkspaceMember =
       *   await client.beta.organization.workspaces.members.retrieve(
       *     'user_id',
       *     { workspace_id: 'workspace_id' },
       *   );
       * ```
       */
      retrieve(userID, params, options) {
        const { workspace_id } = params;
        return this._client.get(path3`/v1/organizations/workspaces/${workspace_id}/members/${userID}?beta=true`, options);
      }
      /**
       * Update Workspace Member
       *
       * @example
       * ```ts
       * const betaWorkspaceMember =
       *   await client.beta.organization.workspaces.members.update(
       *     'user_id',
       *     {
       *       workspace_id: 'workspace_id',
       *       workspace_role: 'workspace_admin',
       *     },
       *   );
       * ```
       */
      update(userID, params, options) {
        const { workspace_id, ...body } = params;
        return this._client.post(path3`/v1/organizations/workspaces/${workspace_id}/members/${userID}?beta=true`, {
          body,
          ...options
        });
      }
      /**
       * List Workspace Members
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaWorkspaceMember of client.beta.organization.workspaces.members.list(
       *   'workspace_id',
       * )) {
       *   // ...
       * }
       * ```
       */
      list(workspaceID, query = {}, options) {
        return this._client.getAPIList(path3`/v1/organizations/workspaces/${workspaceID}/members?beta=true`, Page, { query, ...options });
      }
      /**
       * Create Workspace Member
       *
       * @example
       * ```ts
       * const betaWorkspaceMember =
       *   await client.beta.organization.workspaces.members.add(
       *     'workspace_id',
       *     {
       *       user_id: 'user_01WCz1FkmYMm4gnmykNKUu3Q',
       *       workspace_role: 'workspace_admin',
       *     },
       *   );
       * ```
       */
      add(workspaceID, body, options) {
        return this._client.post(path3`/v1/organizations/workspaces/${workspaceID}/members?beta=true`, {
          body,
          ...options
        });
      }
      /**
       * Delete Workspace Member
       *
       * @example
       * ```ts
       * const member =
       *   await client.beta.organization.workspaces.members.remove(
       *     'user_id',
       *     { workspace_id: 'workspace_id' },
       *   );
       * ```
       */
      remove(userID, params, options) {
        const { workspace_id } = params;
        return this._client.delete(path3`/v1/organizations/workspaces/${workspace_id}/members/${userID}?beta=true`, options);
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/organization/workspaces/rate-limits.mjs
var RateLimits2;
var init_rate_limits2 = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/organization/workspaces/rate-limits.mjs"() {
    init_resource();
    init_pagination();
    init_path();
    RateLimits2 = class extends APIResource {
      /**
       * List a workspace's rate limits.
       *
       * By default, returns only the groups and limiter types that have a
       * workspace-level override. With `include_inherited=true`, returns every group
       * with organization-level limits the workspace can see, listing for each the
       * values it inherits from the organization as well as its own overrides. Each
       * value's `source` says which it is.
       *
       * When `limit` is omitted, every matching entry is returned in a single page; when
       * `limit` truncates the result, follow `next_page` to fetch the remaining entries.
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaWorkspaceRateLimit of client.beta.organization.workspaces.rateLimits.list(
       *   'workspace_id',
       * )) {
       *   // ...
       * }
       * ```
       */
      list(workspaceID, query = {}, options) {
        return this._client.getAPIList(path3`/v1/organizations/workspaces/${workspaceID}/rate_limits?beta=true`, PageCursor, { query, ...options });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/organization/workspaces/service-accounts.mjs
var ServiceAccounts2;
var init_service_accounts2 = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/organization/workspaces/service-accounts.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_path();
    ServiceAccounts2 = class extends APIResource {
      /**
       * **Requires an OAuth access token with the `org:admin` scope**, from
       * `ant auth login --scope org:admin` or a workload identity federation rule; Admin
       * API keys are not accepted. See
       * [Manage WIF with the Admin API](/docs/en/manage-claude/wif-admin-api).
       *
       * Retrieve a service account's membership in a workspace.
       *
       * Returns the membership record, including the service account's `workspace_role`
       * in this workspace. Archived workspaces return 400. For the default workspace,
       * returns the implicit (`implicit: true`) membership when no explicit membership
       * exists; an explicitly added membership is returned with its assigned role. An
       * archived service account returns 404.
       *
       * @example
       * ```ts
       * const betaServiceAccountWorkspaceMember =
       *   await client.beta.organization.workspaces.serviceAccounts.retrieve(
       *     'service_account_id',
       *     { workspace_id: 'workspace_id' },
       *   );
       * ```
       */
      retrieve(serviceAccountID, params, options) {
        const { workspace_id, betas } = params;
        return this._client.get(path3`/v1/organizations/workspaces/${workspace_id}/service_accounts/${serviceAccountID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
            options?.headers
          ])
        });
      }
      /**
       * **Requires an OAuth access token with the `org:admin` scope**, from
       * `ant auth login --scope org:admin` or a workload identity federation rule; Admin
       * API keys are not accepted. See
       * [Manage WIF with the Admin API](/docs/en/manage-claude/wif-admin-api).
       *
       * Change a service account's role in a workspace.
       *
       * The new `workspace_role` replaces the current one. Only explicit memberships can
       * be updated; to set a role on the implicit default-workspace membership, add the
       * service account explicitly with
       * `POST /workspaces/{workspace_id}/service_accounts`. Archived workspaces
       * return 400. Archived service accounts cannot be updated and are rejected.
       *
       * @example
       * ```ts
       * const betaServiceAccountWorkspaceMember =
       *   await client.beta.organization.workspaces.serviceAccounts.update(
       *     'service_account_id',
       *     {
       *       workspace_id: 'workspace_id',
       *       workspace_role: 'workspace_admin',
       *     },
       *   );
       * ```
       */
      update(serviceAccountID, params, options) {
        const { workspace_id, betas, ...body } = params;
        return this._client.post(path3`/v1/organizations/workspaces/${workspace_id}/service_accounts/${serviceAccountID}?beta=true`, {
          body,
          ...options,
          headers: buildHeaders([
            { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
            options?.headers
          ])
        });
      }
      /**
       * **Requires an OAuth access token with the `org:admin` scope**, from
       * `ant auth login --scope org:admin` or a workload identity federation rule; Admin
       * API keys are not accepted. See
       * [Manage WIF with the Admin API](/docs/en/manage-claude/wif-admin-api).
       *
       * List the service accounts that are members of a workspace.
       *
       * Each entry includes the service account's `workspace_role`. Use `limit` and the
       * `next_page` cursor to paginate. Archived workspaces return 400; use
       * `GET /service_accounts/{id}/workspaces` to audit memberships of an archived
       * workspace. The implicit default-workspace membership is not included in this
       * list. Memberships of archived service accounts are omitted from the results.
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaServiceAccountWorkspaceMember of client.beta.organization.workspaces.serviceAccounts.list(
       *   'workspace_id',
       * )) {
       *   // ...
       * }
       * ```
       */
      list(workspaceID, params = {}, options) {
        const { betas, ...query } = params ?? {};
        return this._client.getAPIList(path3`/v1/organizations/workspaces/${workspaceID}/service_accounts?beta=true`, PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
            options?.headers
          ])
        });
      }
      /**
       * **Requires an OAuth access token with the `org:admin` scope**, from
       * `ant auth login --scope org:admin` or a workload identity federation rule; Admin
       * API keys are not accepted. See
       * [Manage WIF with the Admin API](/docs/en/manage-claude/wif-admin-api).
       *
       * Add a service account to a workspace with the given `workspace_role`.
       *
       * The role determines what the service account can do in the workspace and which
       * workspace-scoped permissions it can be granted when authenticating through
       * federation. Every service account is already an implicit `workspace_user` member
       * of the default workspace; adding it explicitly assigns a chosen role. If the
       * service account is already an explicit member of the workspace, its
       * `workspace_role` is replaced with the value supplied here. Archived workspaces
       * return 400. Archived service accounts cannot be added and are rejected.
       *
       * @example
       * ```ts
       * const betaServiceAccountWorkspaceMember =
       *   await client.beta.organization.workspaces.serviceAccounts.add(
       *     'workspace_id',
       *     {
       *       service_account_id: 'service_account_id',
       *       workspace_role: 'workspace_admin',
       *     },
       *   );
       * ```
       */
      add(workspaceID, params, options) {
        const { betas, ...body } = params;
        return this._client.post(path3`/v1/organizations/workspaces/${workspaceID}/service_accounts?beta=true`, {
          body,
          ...options,
          headers: buildHeaders([
            { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
            options?.headers
          ])
        });
      }
      /**
       * **Requires an OAuth access token with the `org:admin` scope**, from
       * `ant auth login --scope org:admin` or a workload identity federation rule; Admin
       * API keys are not accepted. See
       * [Manage WIF with the Admin API](/docs/en/manage-claude/wif-admin-api).
       *
       * Remove a service account from a workspace.
       *
       * Removal is idempotent (returns 200 even if the membership was already removed).
       * A DELETE against the implicit default-workspace membership returns 200 but is a
       * no-op and the membership persists; deleting an explicit default-workspace row
       * reverts to the implicit `workspace_user` membership. Archived workspaces
       * return 400.
       *
       * @example
       * ```ts
       * const serviceAccount =
       *   await client.beta.organization.workspaces.serviceAccounts.remove(
       *     'service_account_id',
       *     { workspace_id: 'workspace_id' },
       *   );
       * ```
       */
      remove(serviceAccountID, params, options) {
        const { workspace_id, betas } = params;
        return this._client.delete(path3`/v1/organizations/workspaces/${workspace_id}/service_accounts/${serviceAccountID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
            options?.headers
          ])
        });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/organization/workspaces/workspaces.mjs
var Workspaces3;
var init_workspaces3 = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/organization/workspaces/workspaces.mjs"() {
    init_resource();
    init_members();
    init_members();
    init_rate_limits2();
    init_rate_limits2();
    init_service_accounts2();
    init_service_accounts2();
    init_pagination();
    init_headers();
    init_path();
    Workspaces3 = /* @__PURE__ */ (() => {
      class Workspaces4 extends APIResource {
        constructor() {
          super(...arguments);
          this.rateLimits = new RateLimits2(this._client);
          this.members = new Members(this._client);
          this.serviceAccounts = new ServiceAccounts2(this._client);
        }
        /**
         * Create Workspace
         *
         * @example
         * ```ts
         * const betaWorkspace =
         *   await client.beta.organization.workspaces.create({
         *     name: 'x',
         *   });
         * ```
         */
        create(params, options) {
          const { betas, ...body } = params;
          return this._client.post("/v1/organizations/workspaces?beta=true", {
            body,
            ...options,
            headers: buildHeaders([
              { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
              options?.headers
            ])
          });
        }
        /**
         * Get Workspace
         *
         * @example
         * ```ts
         * const betaWorkspace =
         *   await client.beta.organization.workspaces.retrieve(
         *     'workspace_id',
         *   );
         * ```
         */
        retrieve(workspaceID, options) {
          return this._client.get(path3`/v1/organizations/workspaces/${workspaceID}?beta=true`, options);
        }
        /**
         * Update Workspace
         *
         * @example
         * ```ts
         * const betaWorkspace =
         *   await client.beta.organization.workspaces.update(
         *     'workspace_id',
         *   );
         * ```
         */
        update(workspaceID, body, options) {
          return this._client.post(path3`/v1/organizations/workspaces/${workspaceID}?beta=true`, {
            body,
            ...options
          });
        }
        /**
         * List Workspaces
         *
         * @example
         * ```ts
         * // Automatically fetches more pages as needed.
         * for await (const betaWorkspace of client.beta.organization.workspaces.list()) {
         *   // ...
         * }
         * ```
         */
        list(query = {}, options) {
          return this._client.getAPIList("/v1/organizations/workspaces?beta=true", Page, {
            query,
            ...options
          });
        }
        /**
         * Archive Workspace
         *
         * @example
         * ```ts
         * const betaWorkspace =
         *   await client.beta.organization.workspaces.archive(
         *     'workspace_id',
         *   );
         * ```
         */
        archive(workspaceID, options) {
          return this._client.post(path3`/v1/organizations/workspaces/${workspaceID}/archive?beta=true`, options);
        }
      }
      Workspaces4.RateLimits = RateLimits2;
      Workspaces4.Members = Members;
      Workspaces4.ServiceAccounts = ServiceAccounts2;
      return Workspaces4;
    })();
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/organization/organization.mjs
var Organization;
var init_organization = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/organization/organization.mjs"() {
    init_resource();
    init_api_keys();
    init_api_keys();
    init_compliance_settings();
    init_compliance_settings();
    init_external_keys();
    init_external_keys();
    init_invites();
    init_invites();
    init_rate_limits();
    init_rate_limits();
    init_users();
    init_users();
    init_federation();
    init_federation();
    init_service_accounts();
    init_service_accounts();
    init_workspaces3();
    init_workspaces3();
    Organization = /* @__PURE__ */ (() => {
      class Organization2 extends APIResource {
        constructor() {
          super(...arguments);
          this.apiKeys = new APIKeys(this._client);
          this.externalKeys = new ExternalKeys(this._client);
          this.federation = new Federation(this._client);
          this.invites = new Invites(this._client);
          this.serviceAccounts = new ServiceAccounts(this._client);
          this.users = new Users(this._client);
          this.workspaces = new Workspaces3(this._client);
          this.rateLimits = new RateLimits(this._client);
          this.complianceSettings = new ComplianceSettings(this._client);
        }
        /**
         * Retrieve information about the organization associated with the authenticated
         * API key.
         *
         * @example
         * ```ts
         * const betaOrganization =
         *   await client.beta.organization.retrieve();
         * ```
         */
        retrieve(options) {
          return this._client.get("/v1/organizations/me?beta=true", options);
        }
      }
      Organization2.APIKeys = APIKeys;
      Organization2.ExternalKeys = ExternalKeys;
      Organization2.Federation = Federation;
      Organization2.Invites = Invites;
      Organization2.ServiceAccounts = ServiceAccounts;
      Organization2.Users = Users;
      Organization2.Workspaces = Workspaces3;
      Organization2.RateLimits = RateLimits;
      Organization2.ComplianceSettings = ComplianceSettings;
      return Organization2;
    })();
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/sessions/events.mjs
var Events;
var init_events = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/sessions/events.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_path();
    init_SessionToolRunner();
    Events = /* @__PURE__ */ (() => {
      class Events3 extends APIResource {
        /**
         * List Events
         *
         * @example
         * ```ts
         * // Automatically fetches more pages as needed.
         * for await (const betaManagedAgentsSessionEvent of client.beta.sessions.events.list(
         *   'sesn_011CZkZAtmR3yMPDzynEDxu7',
         * )) {
         *   // ...
         * }
         * ```
         */
        list(sessionID, params = {}, options) {
          const { betas, workspace_id, ...query } = params ?? {};
          return this._client.getAPIList(path3`/v1/sessions/${sessionID}/events?beta=true`, PageCursor, {
            query,
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * Send Events
         *
         * @example
         * ```ts
         * const betaManagedAgentsSendSessionEvents =
         *   await client.beta.sessions.events.send(
         *     'sesn_011CZkZAtmR3yMPDzynEDxu7',
         *     {
         *       events: [
         *         {
         *           content: [
         *             {
         *               text: 'Where is my order #1234?',
         *               type: 'text',
         *             },
         *           ],
         *           type: 'user.message',
         *         },
         *       ],
         *     },
         *   );
         * ```
         */
        send(sessionID, params, options) {
          const { betas, workspace_id, ...body } = params;
          return this._client.post(path3`/v1/sessions/${sessionID}/events?beta=true`, {
            body,
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * Stream Events
         *
         * @example
         * ```ts
         * const betaManagedAgentsStreamSessionEvents =
         *   await client.beta.sessions.events.stream(
         *     'sesn_011CZkZAtmR3yMPDzynEDxu7',
         *   );
         * ```
         */
        stream(sessionID, params = {}, options) {
          const { betas, workspace_id, ...query } = params ?? {};
          return this._client.get(path3`/v1/sessions/${sessionID}/events/stream?beta=true`, {
            query,
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ]),
            stream: true
          });
        }
        /**
         * Attach to a session and dispatch every incoming `agent.tool_use` and
         * `agent.custom_tool_use` event to a local tool registry, sending the matching
         * result back (`user.tool_result` / `user.custom_tool_result`). The
         * sessions-side counterpart to `client.beta.messages.toolRunner`: yields one
         * entry per completed tool call so callers can observe each dispatch (and
         * `break` to abort cleanly).
         *
         * @example
         * ```ts
         * import { betaAgentToolset20260401 } from '@anthropic-ai/sdk/tools/agent-toolset/node';
         *
         * for await (const call of client.beta.sessions.events.toolRunner(work.data.id, {
         *   tools: [...betaAgentToolset20260401({ workdir }), myTool],
         * })) {
         *   console.log(`${call.name} -> ${call.isError ? 'error' : 'ok'}`);
         * }
         * ```
         */
        toolRunner(sessionID, opts) {
          return new SessionToolRunner(sessionID, { ...opts, client: this._client });
        }
      }
      Events3.SessionToolRunner = SessionToolRunner;
      return Events3;
    })();
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/sessions/resources.mjs
var Resources;
var init_resources = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/sessions/resources.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_path();
    Resources = class extends APIResource {
      /**
       * Get Session Resource
       *
       * @example
       * ```ts
       * const resource =
       *   await client.beta.sessions.resources.retrieve(
       *     'sesrsc_011CZkZBJq5dWxk9fVLNcPht',
       *     { session_id: 'sesn_011CZkZAtmR3yMPDzynEDxu7' },
       *   );
       * ```
       */
      retrieve(resourceID, params, options) {
        const { session_id, betas, workspace_id } = params;
        return this._client.get(path3`/v1/sessions/${session_id}/resources/${resourceID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * Update Session Resource
       *
       * @example
       * ```ts
       * const resource =
       *   await client.beta.sessions.resources.update(
       *     'sesrsc_011CZkZBJq5dWxk9fVLNcPht',
       *     {
       *       session_id: 'sesn_011CZkZAtmR3yMPDzynEDxu7',
       *       authorization_token: 'ghp_exampletoken',
       *     },
       *   );
       * ```
       */
      update(resourceID, params, options) {
        const { session_id, betas, workspace_id, ...body } = params;
        return this._client.post(path3`/v1/sessions/${session_id}/resources/${resourceID}?beta=true`, {
          body,
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * List Session Resources
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaManagedAgentsSessionResource of client.beta.sessions.resources.list(
       *   'sesn_011CZkZAtmR3yMPDzynEDxu7',
       * )) {
       *   // ...
       * }
       * ```
       */
      list(sessionID, params = {}, options) {
        const { betas, workspace_id, ...query } = params ?? {};
        return this._client.getAPIList(path3`/v1/sessions/${sessionID}/resources?beta=true`, PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * Delete Session Resource
       *
       * @example
       * ```ts
       * const betaManagedAgentsDeleteSessionResource =
       *   await client.beta.sessions.resources.delete(
       *     'sesrsc_011CZkZBJq5dWxk9fVLNcPht',
       *     { session_id: 'sesn_011CZkZAtmR3yMPDzynEDxu7' },
       *   );
       * ```
       */
      delete(resourceID, params, options) {
        const { session_id, betas, workspace_id } = params;
        return this._client.delete(path3`/v1/sessions/${session_id}/resources/${resourceID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * Add Session Resource
       *
       * @example
       * ```ts
       * const betaManagedAgentsFileResource =
       *   await client.beta.sessions.resources.add(
       *     'sesn_011CZkZAtmR3yMPDzynEDxu7',
       *     {
       *       file_id: 'file_011CNha8iCJcU1wXNR6q4V8w',
       *       type: 'file',
       *     },
       *   );
       * ```
       */
      add(sessionID, params, options) {
        const { betas, workspace_id, ...body } = params;
        return this._client.post(path3`/v1/sessions/${sessionID}/resources?beta=true`, {
          body,
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/sessions/threads/events.mjs
var Events2;
var init_events2 = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/sessions/threads/events.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_path();
    Events2 = class extends APIResource {
      /**
       * List Session Thread Events
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaManagedAgentsSessionEvent of client.beta.sessions.threads.events.list(
       *   'sthr_011CZkZVWa6oIjw0rgXZpnBt',
       *   { session_id: 'sesn_011CZkZAtmR3yMPDzynEDxu7' },
       * )) {
       *   // ...
       * }
       * ```
       */
      list(threadID, params, options) {
        const { session_id, betas, workspace_id, ...query } = params;
        return this._client.getAPIList(path3`/v1/sessions/${session_id}/threads/${threadID}/events?beta=true`, PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * Stream Session Thread Events
       *
       * @example
       * ```ts
       * const betaManagedAgentsStreamSessionThreadEvents =
       *   await client.beta.sessions.threads.events.stream(
       *     'sthr_011CZkZVWa6oIjw0rgXZpnBt',
       *     { session_id: 'sesn_011CZkZAtmR3yMPDzynEDxu7' },
       *   );
       * ```
       */
      stream(threadID, params, options) {
        const { session_id, betas, workspace_id, ...query } = params;
        return this._client.get(path3`/v1/sessions/${session_id}/threads/${threadID}/stream?beta=true`, {
          query,
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ]),
          stream: true
        });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/sessions/threads/threads.mjs
var Threads;
var init_threads = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/sessions/threads/threads.mjs"() {
    init_resource();
    init_events2();
    init_events2();
    init_pagination();
    init_headers();
    init_path();
    Threads = /* @__PURE__ */ (() => {
      class Threads2 extends APIResource {
        constructor() {
          super(...arguments);
          this.events = new Events2(this._client);
        }
        /**
         * Get Session Thread
         *
         * @example
         * ```ts
         * const betaManagedAgentsSessionThread =
         *   await client.beta.sessions.threads.retrieve(
         *     'sthr_011CZkZVWa6oIjw0rgXZpnBt',
         *     { session_id: 'sesn_011CZkZAtmR3yMPDzynEDxu7' },
         *   );
         * ```
         */
        retrieve(threadID, params, options) {
          const { session_id, betas, workspace_id } = params;
          return this._client.get(path3`/v1/sessions/${session_id}/threads/${threadID}?beta=true`, {
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * List Session Threads
         *
         * @example
         * ```ts
         * // Automatically fetches more pages as needed.
         * for await (const betaManagedAgentsSessionThread of client.beta.sessions.threads.list(
         *   'sesn_011CZkZAtmR3yMPDzynEDxu7',
         * )) {
         *   // ...
         * }
         * ```
         */
        list(sessionID, params = {}, options) {
          const { betas, workspace_id, ...query } = params ?? {};
          return this._client.getAPIList(path3`/v1/sessions/${sessionID}/threads?beta=true`, PageCursor, {
            query,
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * Archive Session Thread
         *
         * @example
         * ```ts
         * const betaManagedAgentsSessionThread =
         *   await client.beta.sessions.threads.archive(
         *     'sthr_011CZkZVWa6oIjw0rgXZpnBt',
         *     { session_id: 'sesn_011CZkZAtmR3yMPDzynEDxu7' },
         *   );
         * ```
         */
        archive(threadID, params, options) {
          const { session_id, betas, workspace_id } = params;
          return this._client.post(path3`/v1/sessions/${session_id}/threads/${threadID}/archive?beta=true`, {
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
      }
      Threads2.Events = Events2;
      return Threads2;
    })();
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/sessions/sessions.mjs
var Sessions;
var init_sessions = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/sessions/sessions.mjs"() {
    init_resource();
    init_events();
    init_events();
    init_resources();
    init_resources();
    init_threads();
    init_threads();
    init_pagination();
    init_headers();
    init_path();
    Sessions = /* @__PURE__ */ (() => {
      class Sessions2 extends APIResource {
        constructor() {
          super(...arguments);
          this.events = new Events(this._client);
          this.resources = new Resources(this._client);
          this.threads = new Threads(this._client);
        }
        /**
         * Create Session
         *
         * @example
         * ```ts
         * const betaManagedAgentsSession =
         *   await client.beta.sessions.create({
         *     agent: 'agent_011CZkYpogX7uDKUyvBTophP',
         *     environment_id: 'env_011CZkZ9X2dpNyB7HsEFoRfW',
         *   });
         * ```
         */
        create(params, options) {
          const { betas, workspace_id, ...body } = params;
          return this._client.post("/v1/sessions?beta=true", {
            body,
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * Get Session
         *
         * @example
         * ```ts
         * const betaManagedAgentsSession =
         *   await client.beta.sessions.retrieve(
         *     'sesn_011CZkZAtmR3yMPDzynEDxu7',
         *   );
         * ```
         */
        retrieve(sessionID, params = {}, options) {
          const { betas, workspace_id } = params ?? {};
          return this._client.get(path3`/v1/sessions/${sessionID}?beta=true`, {
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * Update Session
         *
         * @example
         * ```ts
         * const betaManagedAgentsSession =
         *   await client.beta.sessions.update(
         *     'sesn_011CZkZAtmR3yMPDzynEDxu7',
         *   );
         * ```
         */
        update(sessionID, params, options) {
          const { betas, workspace_id, ...body } = params;
          return this._client.post(path3`/v1/sessions/${sessionID}?beta=true`, {
            body,
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * List Sessions
         *
         * @example
         * ```ts
         * // Automatically fetches more pages as needed.
         * for await (const betaManagedAgentsSession of client.beta.sessions.list()) {
         *   // ...
         * }
         * ```
         */
        list(params = {}, options) {
          const { betas, workspace_id, ...query } = params ?? {};
          return this._client.getAPIList("/v1/sessions?beta=true", BidirectionalPageCursor, {
            query,
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * Delete Session
         *
         * @example
         * ```ts
         * const betaManagedAgentsDeletedSession =
         *   await client.beta.sessions.delete(
         *     'sesn_011CZkZAtmR3yMPDzynEDxu7',
         *   );
         * ```
         */
        delete(sessionID, params = {}, options) {
          const { betas, workspace_id } = params ?? {};
          return this._client.delete(path3`/v1/sessions/${sessionID}?beta=true`, {
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * Archive Session
         *
         * @example
         * ```ts
         * const betaManagedAgentsSession =
         *   await client.beta.sessions.archive(
         *     'sesn_011CZkZAtmR3yMPDzynEDxu7',
         *   );
         * ```
         */
        archive(sessionID, params = {}, options) {
          const { betas, workspace_id } = params ?? {};
          return this._client.post(path3`/v1/sessions/${sessionID}/archive?beta=true`, {
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
      }
      Sessions2.Events = Events;
      Sessions2.Resources = Resources;
      Sessions2.Threads = Threads;
      return Sessions2;
    })();
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/skills/versions.mjs
var Versions2;
var init_versions2 = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/skills/versions.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_uploads();
    init_path();
    Versions2 = class extends APIResource {
      /**
       * Create Skill Version
       *
       * @example
       * ```ts
       * const betaSkillVersion =
       *   await client.beta.skills.versions.create('skill_id', {
       *     files: [fs.createReadStream('path/to/file')],
       *   });
       * ```
       */
      create(skillID, params, options) {
        const { betas, workspace_id, ...body } = params;
        return this._client.post(path3`/v1/skills/${skillID}/versions?beta=true`, multipartFormRequestOptions({
          body,
          ...options,
          headers: buildHeaders([
            {
              ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0,
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        }, this._client, false));
      }
      /**
       * Get Skill Version
       *
       * @example
       * ```ts
       * const betaSkillVersion =
       *   await client.beta.skills.versions.retrieve('version', {
       *     skill_id: 'skill_id',
       *   });
       * ```
       */
      retrieve(version, params, options) {
        const { skill_id, betas, workspace_id } = params;
        return this._client.get(path3`/v1/skills/${skill_id}/versions/${version}?beta=true`, {
          ...options,
          headers: buildHeaders([
            {
              ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0,
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * List Skill Versions
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaSkillVersion of client.beta.skills.versions.list(
       *   'skill_id',
       * )) {
       *   // ...
       * }
       * ```
       */
      list(skillID, params = {}, options) {
        const { betas, workspace_id, ...query } = params ?? {};
        return this._client.getAPIList(path3`/v1/skills/${skillID}/versions?beta=true`, PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            {
              ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0,
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * Delete Skill Version
       *
       * @example
       * ```ts
       * const betaDeletedSkillVersion =
       *   await client.beta.skills.versions.delete('version', {
       *     skill_id: 'skill_id',
       *   });
       * ```
       */
      delete(version, params, options) {
        const { skill_id, betas, workspace_id } = params;
        return this._client.delete(path3`/v1/skills/${skill_id}/versions/${version}?beta=true`, {
          ...options,
          headers: buildHeaders([
            {
              ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0,
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * Download a skill version's content as a zip archive.
       *
       * @example
       * ```ts
       * const response = await client.beta.skills.versions.download(
       *   'version',
       *   { skill_id: 'skill_id' },
       * );
       *
       * const content = await response.blob();
       * console.log(content);
       * ```
       */
      download(version, params, options) {
        const { skill_id, betas, workspace_id } = params;
        return this._client.get(path3`/v1/skills/${skill_id}/versions/${version}/content?beta=true`, {
          ...options,
          headers: buildHeaders([
            {
              Accept: "application/binary",
              ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0,
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ]),
          __binaryResponse: true
        });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/skills/skills.mjs
var Skills;
var init_skills2 = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/skills/skills.mjs"() {
    init_resource();
    init_versions2();
    init_versions2();
    init_pagination();
    init_headers();
    init_uploads();
    init_path();
    Skills = /* @__PURE__ */ (() => {
      class Skills3 extends APIResource {
        constructor() {
          super(...arguments);
          this.versions = new Versions2(this._client);
        }
        /**
         * Create Skill
         *
         * @example
         * ```ts
         * const betaSkill = await client.beta.skills.create({
         *   files: [fs.createReadStream('path/to/file')],
         * });
         * ```
         */
        create(params, options) {
          const { betas, workspace_id, ...body } = params;
          return this._client.post("/v1/skills?beta=true", multipartFormRequestOptions({
            body,
            ...options,
            headers: buildHeaders([
              {
                ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0,
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          }, this._client, false));
        }
        /**
         * Get Skill
         *
         * @example
         * ```ts
         * const betaSkill = await client.beta.skills.retrieve(
         *   'skill_id',
         * );
         * ```
         */
        retrieve(skillID, params = {}, options) {
          const { betas, workspace_id } = params ?? {};
          return this._client.get(path3`/v1/skills/${skillID}?beta=true`, {
            ...options,
            headers: buildHeaders([
              {
                ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0,
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * List Skills
         *
         * @example
         * ```ts
         * // Automatically fetches more pages as needed.
         * for await (const betaSkill of client.beta.skills.list()) {
         *   // ...
         * }
         * ```
         */
        list(params = {}, options) {
          const { betas, workspace_id, ...query } = params ?? {};
          return this._client.getAPIList("/v1/skills?beta=true", PageCursor, {
            query,
            ...options,
            headers: buildHeaders([
              {
                ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0,
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * Delete Skill
         *
         * @example
         * ```ts
         * const betaDeletedSkill = await client.beta.skills.delete(
         *   'skill_id',
         * );
         * ```
         */
        delete(skillID, params = {}, options) {
          const { betas, workspace_id } = params ?? {};
          return this._client.delete(path3`/v1/skills/${skillID}?beta=true`, {
            ...options,
            headers: buildHeaders([
              {
                ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0,
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
      }
      Skills3.Versions = Versions2;
      return Skills3;
    })();
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/tunnels/certificates.mjs
var Certificates;
var init_certificates = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/tunnels/certificates.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_path();
    Certificates = class extends APIResource {
      /**
       * The Tunnels API is in research preview. It requires the
       * `anthropic-beta: mcp-tunnels-2026-06-22` header and may change without a
       * deprecation period. It supersedes the Admin API endpoints at
       * `/v1/organizations/tunnels`, which remain available during a migration window.
       *
       * Registers a public CA certificate on a tunnel. Anthropic verifies the gateway's
       * server certificate against this CA when it terminates the inner TLS session. A
       * tunnel holds at most two non-archived certificates.
       *
       * @example
       * ```ts
       * const betaTunnelCertificate =
       *   await client.beta.tunnels.certificates.create(
       *     'tunnel_id',
       *     { ca_certificate_pem: 'ca_certificate_pem' },
       *   );
       * ```
       */
      create(tunnelID, params, options) {
        const { betas, workspace_id, ...body } = params;
        return this._client.post(path3`/v1/tunnels/${tunnelID}/certificates?beta=true`, {
          body,
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "mcp-tunnels-2026-06-22"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * The Tunnels API is in research preview. It requires the
       * `anthropic-beta: mcp-tunnels-2026-06-22` header and may change without a
       * deprecation period. It supersedes the Admin API endpoints at
       * `/v1/organizations/tunnels`, which remain available during a migration window.
       *
       * Fetches a tunnel certificate by ID.
       *
       * @example
       * ```ts
       * const betaTunnelCertificate =
       *   await client.beta.tunnels.certificates.retrieve(
       *     'certificate_id',
       *     { tunnel_id: 'tunnel_id' },
       *   );
       * ```
       */
      retrieve(certificateID, params, options) {
        const { tunnel_id, betas, workspace_id } = params;
        return this._client.get(path3`/v1/tunnels/${tunnel_id}/certificates/${certificateID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "mcp-tunnels-2026-06-22"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * The Tunnels API is in research preview. It requires the
       * `anthropic-beta: mcp-tunnels-2026-06-22` header and may change without a
       * deprecation period. It supersedes the Admin API endpoints at
       * `/v1/organizations/tunnels`, which remain available during a migration window.
       *
       * Lists the certificates registered on a tunnel. Archived certificates are
       * excluded unless include_archived is set.
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaTunnelCertificate of client.beta.tunnels.certificates.list(
       *   'tunnel_id',
       * )) {
       *   // ...
       * }
       * ```
       */
      list(tunnelID, params = {}, options) {
        const { betas, workspace_id, ...query } = params ?? {};
        return this._client.getAPIList(path3`/v1/tunnels/${tunnelID}/certificates?beta=true`, PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "mcp-tunnels-2026-06-22"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * The Tunnels API is in research preview. It requires the
       * `anthropic-beta: mcp-tunnels-2026-06-22` header and may change without a
       * deprecation period. It supersedes the Admin API endpoints at
       * `/v1/organizations/tunnels`, which remain available during a migration window.
       *
       * Archives a tunnel certificate, removing it from the set Anthropic trusts for the
       * tunnel. The certificate record is retained. Archiving the last non-archived
       * certificate is permitted; the tunnel rejects MCP traffic until a new certificate
       * is added.
       *
       * @example
       * ```ts
       * const betaTunnelCertificate =
       *   await client.beta.tunnels.certificates.archive(
       *     'certificate_id',
       *     { tunnel_id: 'tunnel_id' },
       *   );
       * ```
       */
      archive(certificateID, params, options) {
        const { tunnel_id, betas, workspace_id } = params;
        return this._client.post(path3`/v1/tunnels/${tunnel_id}/certificates/${certificateID}/archive?beta=true`, {
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "mcp-tunnels-2026-06-22"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/tunnels/tunnels.mjs
var Tunnels;
var init_tunnels = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/tunnels/tunnels.mjs"() {
    init_resource();
    init_certificates();
    init_certificates();
    init_pagination();
    init_headers();
    init_path();
    Tunnels = /* @__PURE__ */ (() => {
      class Tunnels2 extends APIResource {
        constructor() {
          super(...arguments);
          this.certificates = new Certificates(this._client);
        }
        /**
         * The Tunnels API is in research preview. It requires the
         * `anthropic-beta: mcp-tunnels-2026-06-22` header and may change without a
         * deprecation period. It supersedes the Admin API endpoints at
         * `/v1/organizations/tunnels`, which remain available during a migration window.
         *
         * Creates a tunnel. Creation allocates a fresh hostname and provisions the tunnel;
         * it is not idempotent. The new tunnel rejects MCP traffic until at least one CA
         * certificate is added.
         *
         * @example
         * ```ts
         * const betaTunnel = await client.beta.tunnels.create();
         * ```
         */
        create(params, options) {
          const { betas, workspace_id, ...body } = params;
          return this._client.post("/v1/tunnels?beta=true", {
            body,
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "mcp-tunnels-2026-06-22"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * The Tunnels API is in research preview. It requires the
         * `anthropic-beta: mcp-tunnels-2026-06-22` header and may change without a
         * deprecation period. It supersedes the Admin API endpoints at
         * `/v1/organizations/tunnels`, which remain available during a migration window.
         *
         * Fetches a tunnel by ID.
         *
         * @example
         * ```ts
         * const betaTunnel = await client.beta.tunnels.retrieve(
         *   'tunnel_id',
         * );
         * ```
         */
        retrieve(tunnelID, params = {}, options) {
          const { betas, workspace_id } = params ?? {};
          return this._client.get(path3`/v1/tunnels/${tunnelID}?beta=true`, {
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "mcp-tunnels-2026-06-22"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * The Tunnels API is in research preview. It requires the
         * `anthropic-beta: mcp-tunnels-2026-06-22` header and may change without a
         * deprecation period. It supersedes the Admin API endpoints at
         * `/v1/organizations/tunnels`, which remain available during a migration window.
         *
         * Lists tunnels. Results are ordered by creation time, newest first; archived
         * tunnels are excluded unless include_archived is set.
         *
         * @example
         * ```ts
         * // Automatically fetches more pages as needed.
         * for await (const betaTunnel of client.beta.tunnels.list()) {
         *   // ...
         * }
         * ```
         */
        list(params = {}, options) {
          const { betas, workspace_id, ...query } = params ?? {};
          return this._client.getAPIList("/v1/tunnels?beta=true", PageCursor, {
            query,
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "mcp-tunnels-2026-06-22"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * The Tunnels API is in research preview. It requires the
         * `anthropic-beta: mcp-tunnels-2026-06-22` header and may change without a
         * deprecation period. It supersedes the Admin API endpoints at
         * `/v1/organizations/tunnels`, which remain available during a migration window.
         *
         * Archives a tunnel. Archival is irreversible: every non-archived certificate on
         * the tunnel is archived in the same operation, the hostname is retired and never
         * re-allocated, and the tunnel token is invalidated. Retrying against an
         * already-archived tunnel returns the existing record unchanged.
         *
         * @example
         * ```ts
         * const betaTunnel = await client.beta.tunnels.archive(
         *   'tunnel_id',
         * );
         * ```
         */
        archive(tunnelID, params = {}, options) {
          const { betas, workspace_id } = params ?? {};
          return this._client.post(path3`/v1/tunnels/${tunnelID}/archive?beta=true`, {
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "mcp-tunnels-2026-06-22"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * The Tunnels API is in research preview. It requires the
         * `anthropic-beta: mcp-tunnels-2026-06-22` header and may change without a
         * deprecation period. It supersedes the Admin API endpoints at
         * `/v1/organizations/tunnels`, which remain available during a migration window.
         *
         * Reveals a tunnel's connector token. The value is fetched live on each call;
         * Anthropic does not store it. Repeated calls return the same value until the
         * token is rotated. Exposed as POST so the token does not appear in intermediary
         * access logs.
         *
         * @example
         * ```ts
         * const betaTunnelToken =
         *   await client.beta.tunnels.revealToken('tunnel_id');
         * ```
         */
        revealToken(tunnelID, params = {}, options) {
          const { betas, workspace_id } = params ?? {};
          return this._client.post(path3`/v1/tunnels/${tunnelID}/reveal_token?beta=true`, {
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "mcp-tunnels-2026-06-22"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * The Tunnels API is in research preview. It requires the
         * `anthropic-beta: mcp-tunnels-2026-06-22` header and may change without a
         * deprecation period. It supersedes the Admin API endpoints at
         * `/v1/organizations/tunnels`, which remain available during a migration window.
         *
         * Rotates a tunnel's connector token. Rotation invalidates the current token for
         * new connections and returns a fresh value; established connections are not
         * severed. A connector restarted after rotation must use the new value.
         *
         * @example
         * ```ts
         * const betaTunnelToken =
         *   await client.beta.tunnels.rotateToken('tunnel_id');
         * ```
         */
        rotateToken(tunnelID, params, options) {
          const { betas, workspace_id, ...body } = params;
          return this._client.post(path3`/v1/tunnels/${tunnelID}/rotate_token?beta=true`, {
            body,
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "mcp-tunnels-2026-06-22"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
      }
      Tunnels2.Certificates = Certificates;
      return Tunnels2;
    })();
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/vaults/credentials.mjs
var Credentials;
var init_credentials2 = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/vaults/credentials.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_path();
    Credentials = class extends APIResource {
      /**
       * Create Credential
       *
       * @example
       * ```ts
       * const betaManagedAgentsCredential =
       *   await client.beta.vaults.credentials.create(
       *     'vlt_011CZkZDLs7fYzm1hXNPeRjv',
       *     {
       *       auth: {
       *         token: 'bearer_exampletoken',
       *         mcp_server_url:
       *           'https://example-server.modelcontextprotocol.io/sse',
       *         type: 'static_bearer',
       *       },
       *     },
       *   );
       * ```
       */
      create(vaultID, params, options) {
        const { betas, workspace_id, ...body } = params;
        return this._client.post(path3`/v1/vaults/${vaultID}/credentials?beta=true`, {
          body,
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * Get Credential
       *
       * @example
       * ```ts
       * const betaManagedAgentsCredential =
       *   await client.beta.vaults.credentials.retrieve(
       *     'vcrd_011CZkZEMt8gZan2iYOQfSkw',
       *     { vault_id: 'vlt_011CZkZDLs7fYzm1hXNPeRjv' },
       *   );
       * ```
       */
      retrieve(credentialID, params, options) {
        const { vault_id, betas, workspace_id } = params;
        return this._client.get(path3`/v1/vaults/${vault_id}/credentials/${credentialID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * Update Credential
       *
       * @example
       * ```ts
       * const betaManagedAgentsCredential =
       *   await client.beta.vaults.credentials.update(
       *     'vcrd_011CZkZEMt8gZan2iYOQfSkw',
       *     { vault_id: 'vlt_011CZkZDLs7fYzm1hXNPeRjv' },
       *   );
       * ```
       */
      update(credentialID, params, options) {
        const { vault_id, betas, workspace_id, ...body } = params;
        return this._client.post(path3`/v1/vaults/${vault_id}/credentials/${credentialID}?beta=true`, {
          body,
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * List Credentials
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaManagedAgentsCredential of client.beta.vaults.credentials.list(
       *   'vlt_011CZkZDLs7fYzm1hXNPeRjv',
       * )) {
       *   // ...
       * }
       * ```
       */
      list(vaultID, params = {}, options) {
        const { betas, workspace_id, ...query } = params ?? {};
        return this._client.getAPIList(path3`/v1/vaults/${vaultID}/credentials?beta=true`, PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * Delete Credential
       *
       * @example
       * ```ts
       * const betaManagedAgentsDeletedCredential =
       *   await client.beta.vaults.credentials.delete(
       *     'vcrd_011CZkZEMt8gZan2iYOQfSkw',
       *     { vault_id: 'vlt_011CZkZDLs7fYzm1hXNPeRjv' },
       *   );
       * ```
       */
      delete(credentialID, params, options) {
        const { vault_id, betas, workspace_id } = params;
        return this._client.delete(path3`/v1/vaults/${vault_id}/credentials/${credentialID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * Archive Credential
       *
       * @example
       * ```ts
       * const betaManagedAgentsCredential =
       *   await client.beta.vaults.credentials.archive(
       *     'vcrd_011CZkZEMt8gZan2iYOQfSkw',
       *     { vault_id: 'vlt_011CZkZDLs7fYzm1hXNPeRjv' },
       *   );
       * ```
       */
      archive(credentialID, params, options) {
        const { vault_id, betas, workspace_id } = params;
        return this._client.post(path3`/v1/vaults/${vault_id}/credentials/${credentialID}/archive?beta=true`, {
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * Validate Credential
       *
       * @example
       * ```ts
       * const betaManagedAgentsCredentialValidation =
       *   await client.beta.vaults.credentials.mcpOAuthValidate(
       *     'vcrd_011CZkZEMt8gZan2iYOQfSkw',
       *     { vault_id: 'vlt_011CZkZDLs7fYzm1hXNPeRjv' },
       *   );
       * ```
       */
      mcpOAuthValidate(credentialID, params, options) {
        const { vault_id, betas, workspace_id } = params;
        return this._client.post(path3`/v1/vaults/${vault_id}/credentials/${credentialID}/mcp_oauth_validate?beta=true`, {
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/vaults/vaults.mjs
var Vaults;
var init_vaults = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/vaults/vaults.mjs"() {
    init_resource();
    init_credentials2();
    init_credentials2();
    init_pagination();
    init_headers();
    init_path();
    Vaults = /* @__PURE__ */ (() => {
      class Vaults2 extends APIResource {
        constructor() {
          super(...arguments);
          this.credentials = new Credentials(this._client);
        }
        /**
         * Create Vault
         *
         * @example
         * ```ts
         * const betaManagedAgentsVault =
         *   await client.beta.vaults.create({
         *     display_name: 'Example vault',
         *   });
         * ```
         */
        create(params, options) {
          const { betas, workspace_id, ...body } = params;
          return this._client.post("/v1/vaults?beta=true", {
            body,
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * Get Vault
         *
         * @example
         * ```ts
         * const betaManagedAgentsVault =
         *   await client.beta.vaults.retrieve(
         *     'vlt_011CZkZDLs7fYzm1hXNPeRjv',
         *   );
         * ```
         */
        retrieve(vaultID, params = {}, options) {
          const { betas, workspace_id } = params ?? {};
          return this._client.get(path3`/v1/vaults/${vaultID}?beta=true`, {
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * Update Vault
         *
         * @example
         * ```ts
         * const betaManagedAgentsVault =
         *   await client.beta.vaults.update(
         *     'vlt_011CZkZDLs7fYzm1hXNPeRjv',
         *   );
         * ```
         */
        update(vaultID, params, options) {
          const { betas, workspace_id, ...body } = params;
          return this._client.post(path3`/v1/vaults/${vaultID}?beta=true`, {
            body,
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * List Vaults
         *
         * @example
         * ```ts
         * // Automatically fetches more pages as needed.
         * for await (const betaManagedAgentsVault of client.beta.vaults.list()) {
         *   // ...
         * }
         * ```
         */
        list(params = {}, options) {
          const { betas, workspace_id, ...query } = params ?? {};
          return this._client.getAPIList("/v1/vaults?beta=true", PageCursor, {
            query,
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * Delete Vault
         *
         * @example
         * ```ts
         * const betaManagedAgentsDeletedVault =
         *   await client.beta.vaults.delete(
         *     'vlt_011CZkZDLs7fYzm1hXNPeRjv',
         *   );
         * ```
         */
        delete(vaultID, params = {}, options) {
          const { betas, workspace_id } = params ?? {};
          return this._client.delete(path3`/v1/vaults/${vaultID}?beta=true`, {
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
        /**
         * Archive Vault
         *
         * @example
         * ```ts
         * const betaManagedAgentsVault =
         *   await client.beta.vaults.archive(
         *     'vlt_011CZkZDLs7fYzm1hXNPeRjv',
         *   );
         * ```
         */
        archive(vaultID, params = {}, options) {
          const { betas, workspace_id } = params ?? {};
          return this._client.post(path3`/v1/vaults/${vaultID}/archive?beta=true`, {
            ...options,
            headers: buildHeaders([
              {
                "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
      }
      Vaults2.Credentials = Credentials;
      return Vaults2;
    })();
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/beta.mjs
var Beta;
var init_beta = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/beta.mjs"() {
    init_resource();
    init_deployment_runs();
    init_deployment_runs();
    init_deployments();
    init_deployments();
    init_dreams();
    init_dreams();
    init_files();
    init_files();
    init_models();
    init_models();
    init_user_profiles();
    init_user_profiles();
    init_webhooks();
    init_webhooks();
    init_agents();
    init_agents();
    init_environments();
    init_environments();
    init_memory_stores();
    init_memory_stores();
    init_messages();
    init_messages();
    init_organization();
    init_organization();
    init_sessions();
    init_sessions();
    init_skills2();
    init_skills2();
    init_tunnels();
    init_tunnels();
    init_vaults();
    init_vaults();
    Beta = /* @__PURE__ */ (() => {
      class Beta2 extends APIResource {
        constructor() {
          super(...arguments);
          this.models = new Models(this._client);
          this.messages = new Messages(this._client);
          this.agents = new Agents(this._client);
          this.environments = new Environments(this._client);
          this.sessions = new Sessions(this._client);
          this.deployments = new Deployments(this._client);
          this.deploymentRuns = new DeploymentRuns(this._client);
          this.vaults = new Vaults(this._client);
          this.memoryStores = new MemoryStores(this._client);
          this.files = new Files(this._client);
          this.skills = new Skills(this._client);
          this.webhooks = new Webhooks(this._client);
          this.userProfiles = new UserProfiles(this._client);
          this.dreams = new Dreams(this._client);
          this.tunnels = new Tunnels(this._client);
          this.organization = new Organization(this._client);
        }
      }
      Beta2.Models = Models;
      Beta2.Messages = Messages;
      Beta2.Agents = Agents;
      Beta2.Environments = Environments;
      Beta2.Sessions = Sessions;
      Beta2.Deployments = Deployments;
      Beta2.DeploymentRuns = DeploymentRuns;
      Beta2.Vaults = Vaults;
      Beta2.MemoryStores = MemoryStores;
      Beta2.Files = Files;
      Beta2.Skills = Skills;
      Beta2.Webhooks = Webhooks;
      Beta2.UserProfiles = UserProfiles;
      Beta2.Dreams = Dreams;
      Beta2.Tunnels = Tunnels;
      Beta2.Organization = Organization;
      return Beta2;
    })();
  }
});

// node_modules/@anthropic-ai/sdk/resources/completions.mjs
var Completions;
var init_completions = __esm({
  "node_modules/@anthropic-ai/sdk/resources/completions.mjs"() {
    init_resource();
    init_headers();
    Completions = class extends APIResource {
      create(params, options) {
        const { betas, workspace_id, ...body } = params;
        return this._client.post("/v1/complete", {
          body,
          timeout: this._client._options.timeout ?? 6e5,
          ...options,
          headers: buildHeaders([
            {
              ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0,
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ]),
          stream: params.stream ?? false
        });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/files.mjs
var Files2;
var init_files2 = __esm({
  "node_modules/@anthropic-ai/sdk/resources/files.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_stainless_helper_header();
    init_uploads();
    init_path();
    Files2 = class extends APIResource {
      /**
       * List Files
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const fileMetadata of client.files.list()) {
       *   // ...
       * }
       * ```
       */
      list(params = {}, options) {
        const { workspace_id, ...query } = params ?? {};
        return this._client.getAPIList("/v1/files", PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            { ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0 },
            options?.headers
          ])
        });
      }
      /**
       * Delete File
       *
       * @example
       * ```ts
       * const deletedFile = await client.files.delete('file_id');
       * ```
       */
      delete(fileID, params = {}, options) {
        const { workspace_id } = params ?? {};
        return this._client.delete(path3`/v1/files/${fileID}`, {
          ...options,
          headers: buildHeaders([
            { ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0 },
            options?.headers
          ])
        });
      }
      /**
       * Download File
       *
       * @example
       * ```ts
       * const response = await client.files.download('file_id');
       *
       * const content = await response.blob();
       * console.log(content);
       * ```
       */
      download(fileID, params = {}, options) {
        const { workspace_id } = params ?? {};
        return this._client.get(path3`/v1/files/${fileID}/content`, {
          ...options,
          headers: buildHeaders([
            {
              Accept: "application/binary",
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ]),
          __binaryResponse: true
        });
      }
      /**
       * Get File Metadata
       *
       * @example
       * ```ts
       * const fileMetadata = await client.files.retrieveMetadata(
       *   'file_id',
       * );
       * ```
       */
      retrieveMetadata(fileID, params = {}, options) {
        const { workspace_id } = params ?? {};
        return this._client.get(path3`/v1/files/${fileID}`, {
          ...options,
          headers: buildHeaders([
            { ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0 },
            options?.headers
          ])
        });
      }
      /**
       * Upload File
       *
       * @example
       * ```ts
       * const fileMetadata = await client.files.upload({
       *   file: fs.createReadStream('path/to/file'),
       * });
       * ```
       */
      upload(params, options) {
        const { workspace_id, ...body } = params;
        return this._client.post("/v1/files", multipartFormRequestOptions({
          body,
          ...options,
          headers: buildHeaders([
            { ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0 },
            stainlessHelperHeaderFromFile(body.file),
            options?.headers
          ])
        }, this._client));
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/lib/parser.mjs
function getOutputFormat2(params) {
  return params?.output_config?.format;
}
function maybeParseMessage(message, params, opts) {
  const outputFormat = getOutputFormat2(params);
  if (!params || !("parse" in (outputFormat ?? {}))) {
    return {
      ...message,
      content: message.content.map((block) => {
        if (block.type === "text") {
          const parsedBlock = Object.defineProperty({ ...block }, "parsed_output", {
            value: null,
            enumerable: false
          });
          return parsedBlock;
        }
        return block;
      }),
      parsed_output: null
    };
  }
  return parseMessage(message, params, opts);
}
function parseMessage(message, params, opts) {
  let firstParsedOutput = null;
  const content = message.content.map((block) => {
    if (block.type === "text") {
      const parsedOutput = parseOutputFormat(params, block.text);
      if (firstParsedOutput === null) {
        firstParsedOutput = parsedOutput;
      }
      const parsedBlock = Object.defineProperty({ ...block }, "parsed_output", {
        value: parsedOutput,
        enumerable: false
      });
      return parsedBlock;
    }
    return block;
  });
  return {
    ...message,
    content,
    parsed_output: firstParsedOutput
  };
}
function parseOutputFormat(params, content) {
  const outputFormat = getOutputFormat2(params);
  if (outputFormat?.type !== "json_schema") {
    return null;
  }
  try {
    if ("parse" in outputFormat) {
      return outputFormat.parse(content);
    }
    return JSON.parse(content);
  } catch (error) {
    throw new AnthropicError(`Failed to parse structured output: ${error}`);
  }
}
var init_parser2 = __esm({
  "node_modules/@anthropic-ai/sdk/lib/parser.mjs"() {
    init_error();
  }
});

// node_modules/@anthropic-ai/sdk/lib/MessageStream.mjs
function tracksToolInput2(content) {
  return content.type === "tool_use" || content.type === "server_tool_use";
}
var _MessageStream_instances, _MessageStream_currentMessageSnapshot, _MessageStream_params, _MessageStream_connectedPromise, _MessageStream_resolveConnectedPromise, _MessageStream_rejectConnectedPromise, _MessageStream_endPromise, _MessageStream_resolveEndPromise, _MessageStream_rejectEndPromise, _MessageStream_listeners, _MessageStream_ended, _MessageStream_errored, _MessageStream_aborted, _MessageStream_catchingPromiseCreated, _MessageStream_response, _MessageStream_request_id, _MessageStream_workspace_id, _MessageStream_logger, _MessageStream_getFinalMessage, _MessageStream_getFinalText, _MessageStream_handleError, _MessageStream_beginRequest, _MessageStream_addStreamEvent, _MessageStream_endRequest, _MessageStream_accumulateMessage, MessageStream;
var init_MessageStream = __esm({
  "node_modules/@anthropic-ai/sdk/lib/MessageStream.mjs"() {
    init_tslib();
    init_stainless_helper_header();
    init_errors();
    init_values();
    init_error2();
    init_streaming2();
    init_parser2();
    init_message_stream_utils();
    MessageStream = /* @__PURE__ */ (() => {
      class MessageStream2 {
        constructor(params, opts) {
          _MessageStream_instances.add(this);
          this.messages = [];
          this.receivedMessages = [];
          _MessageStream_currentMessageSnapshot.set(this, void 0);
          _MessageStream_params.set(this, null);
          this.controller = new AbortController();
          _MessageStream_connectedPromise.set(this, void 0);
          _MessageStream_resolveConnectedPromise.set(this, () => {
          });
          _MessageStream_rejectConnectedPromise.set(this, () => {
          });
          _MessageStream_endPromise.set(this, void 0);
          _MessageStream_resolveEndPromise.set(this, () => {
          });
          _MessageStream_rejectEndPromise.set(this, () => {
          });
          _MessageStream_listeners.set(this, {});
          _MessageStream_ended.set(this, false);
          _MessageStream_errored.set(this, false);
          _MessageStream_aborted.set(this, false);
          _MessageStream_catchingPromiseCreated.set(this, false);
          _MessageStream_response.set(this, void 0);
          _MessageStream_request_id.set(this, void 0);
          _MessageStream_workspace_id.set(this, void 0);
          _MessageStream_logger.set(this, void 0);
          _MessageStream_handleError.set(this, (error) => {
            __classPrivateFieldSet(this, _MessageStream_errored, true, "f");
            if (isAbortError(error)) {
              error = new APIUserAbortError();
            }
            if (error instanceof APIUserAbortError) {
              __classPrivateFieldSet(this, _MessageStream_aborted, true, "f");
              return this._emit("abort", error);
            }
            if (error instanceof AnthropicError) {
              return this._emit("error", error);
            }
            if (error instanceof Error) {
              const anthropicError = new AnthropicError(error.message);
              anthropicError.cause = error;
              return this._emit("error", anthropicError);
            }
            return this._emit("error", new AnthropicError(String(error)));
          });
          __classPrivateFieldSet(this, _MessageStream_connectedPromise, new Promise((resolve2, reject) => {
            __classPrivateFieldSet(this, _MessageStream_resolveConnectedPromise, resolve2, "f");
            __classPrivateFieldSet(this, _MessageStream_rejectConnectedPromise, reject, "f");
          }), "f");
          __classPrivateFieldSet(this, _MessageStream_endPromise, new Promise((resolve2, reject) => {
            __classPrivateFieldSet(this, _MessageStream_resolveEndPromise, resolve2, "f");
            __classPrivateFieldSet(this, _MessageStream_rejectEndPromise, reject, "f");
          }), "f");
          __classPrivateFieldGet(this, _MessageStream_connectedPromise, "f").catch(() => {
          });
          __classPrivateFieldGet(this, _MessageStream_endPromise, "f").catch(() => {
          });
          __classPrivateFieldSet(this, _MessageStream_params, params, "f");
          __classPrivateFieldSet(this, _MessageStream_logger, opts?.logger ?? console, "f");
        }
        get response() {
          return __classPrivateFieldGet(this, _MessageStream_response, "f");
        }
        get request_id() {
          return __classPrivateFieldGet(this, _MessageStream_request_id, "f");
        }
        get workspace_id() {
          return __classPrivateFieldGet(this, _MessageStream_workspace_id, "f");
        }
        /**
         * Returns the `MessageStream` data, the raw `Response` instance and the ID of the request,
         * returned vie the `request-id` header which is useful for debugging requests and resporting
         * issues to Anthropic.
         *
         * This is the same as the `APIPromise.withResponse()` method.
         *
         * This method will raise an error if you created the stream using `MessageStream.fromReadableStream`
         * as no `Response` is available.
         */
        async withResponse() {
          __classPrivateFieldSet(this, _MessageStream_catchingPromiseCreated, true, "f");
          const response = await __classPrivateFieldGet(this, _MessageStream_connectedPromise, "f");
          if (!response) {
            throw new Error("Could not resolve a `Response` object");
          }
          return {
            data: this,
            response,
            request_id: response.headers.get("request-id"),
            workspace_id: response.headers.get("anthropic-workspace-id")
          };
        }
        /**
         * Intended for use on the frontend, consuming a stream produced with
         * `.toReadableStream()` on the backend.
         *
         * Note that messages sent to the model do not appear in `.on('message')`
         * in this context.
         */
        static fromReadableStream(stream2) {
          const runner = new MessageStream2(null);
          runner._run(() => runner._fromReadableStream(stream2));
          return runner;
        }
        static createMessage(messages, params, options, { logger } = {}) {
          const runner = new MessageStream2(params, { logger });
          for (const message of params.messages) {
            runner._addMessageParam(message);
          }
          __classPrivateFieldSet(runner, _MessageStream_params, { ...params, stream: true }, "f");
          runner._run(() => runner._createMessage(messages, { ...params, stream: true }, { ...options, headers: { ...options?.headers, [STAINLESS_HELPER_METHOD_HEADER]: "stream" } }));
          return runner;
        }
        _run(executor) {
          executor().then(() => {
            this._emitFinal();
            this._emit("end");
          }, __classPrivateFieldGet(this, _MessageStream_handleError, "f"));
        }
        _addMessageParam(message) {
          this.messages.push(message);
        }
        _addMessage(message, emit = true) {
          this.receivedMessages.push(message);
          if (emit) {
            this._emit("message", message);
          }
        }
        async _createMessage(messages, params, options) {
          const signal = options?.signal;
          let abortHandler;
          if (signal) {
            if (signal.aborted)
              this.controller.abort();
            abortHandler = this.controller.abort.bind(this.controller);
            signal.addEventListener("abort", abortHandler);
          }
          try {
            __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_beginRequest).call(this);
            const { response, data: stream2 } = await messages.create({ ...params, stream: true }, { ...options, signal: this.controller.signal }).withResponse();
            this._connected(response);
            for await (const event of stream2) {
              __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_addStreamEvent).call(this, event);
            }
            if (stream2.controller.signal?.aborted) {
              throw new APIUserAbortError();
            }
            __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_endRequest).call(this);
          } finally {
            if (signal && abortHandler) {
              signal.removeEventListener("abort", abortHandler);
            }
          }
        }
        _connected(response) {
          if (this.ended)
            return;
          __classPrivateFieldSet(this, _MessageStream_response, response, "f");
          __classPrivateFieldSet(this, _MessageStream_request_id, response?.headers.get("request-id"), "f");
          __classPrivateFieldSet(this, _MessageStream_workspace_id, response?.headers.get("anthropic-workspace-id"), "f");
          __classPrivateFieldGet(this, _MessageStream_resolveConnectedPromise, "f").call(this, response);
          this._emit("connect");
        }
        get ended() {
          return __classPrivateFieldGet(this, _MessageStream_ended, "f");
        }
        get errored() {
          return __classPrivateFieldGet(this, _MessageStream_errored, "f");
        }
        get aborted() {
          return __classPrivateFieldGet(this, _MessageStream_aborted, "f");
        }
        abort() {
          this.controller.abort();
        }
        /**
         * Adds the listener function to the end of the listeners array for the event.
         * No checks are made to see if the listener has already been added. Multiple calls passing
         * the same combination of event and listener will result in the listener being added, and
         * called, multiple times.
         * @returns this MessageStream, so that calls can be chained
         */
        on(event, listener) {
          const listeners = __classPrivateFieldGet(this, _MessageStream_listeners, "f")[event] || (__classPrivateFieldGet(this, _MessageStream_listeners, "f")[event] = []);
          listeners.push({ listener });
          return this;
        }
        /**
         * Removes the specified listener from the listener array for the event.
         * off() will remove, at most, one instance of a listener from the listener array. If any single
         * listener has been added multiple times to the listener array for the specified event, then
         * off() must be called multiple times to remove each instance.
         * @returns this MessageStream, so that calls can be chained
         */
        off(event, listener) {
          const listeners = __classPrivateFieldGet(this, _MessageStream_listeners, "f")[event];
          if (!listeners)
            return this;
          const index = listeners.findIndex((l) => l.listener === listener);
          if (index >= 0)
            listeners.splice(index, 1);
          return this;
        }
        /**
         * Adds a one-time listener function for the event. The next time the event is triggered,
         * this listener is removed and then invoked.
         * @returns this MessageStream, so that calls can be chained
         */
        once(event, listener) {
          const listeners = __classPrivateFieldGet(this, _MessageStream_listeners, "f")[event] || (__classPrivateFieldGet(this, _MessageStream_listeners, "f")[event] = []);
          listeners.push({ listener, once: true });
          return this;
        }
        /**
         * This is similar to `.once()`, but returns a Promise that resolves the next time
         * the event is triggered, instead of calling a listener callback.
         * @returns a Promise that resolves the next time given event is triggered,
         * or rejects if an error is emitted.  (If you request the 'error' event,
         * returns a promise that resolves with the error).
         *
         * Example:
         *
         *   const message = await stream.emitted('message') // rejects if the stream errors
         */
        emitted(event) {
          return new Promise((resolve2, reject) => {
            __classPrivateFieldSet(this, _MessageStream_catchingPromiseCreated, true, "f");
            if (event !== "error")
              this.once("error", reject);
            this.once(event, resolve2);
          });
        }
        async done() {
          __classPrivateFieldSet(this, _MessageStream_catchingPromiseCreated, true, "f");
          await __classPrivateFieldGet(this, _MessageStream_endPromise, "f");
        }
        get currentMessage() {
          return __classPrivateFieldGet(this, _MessageStream_currentMessageSnapshot, "f");
        }
        /**
         * @returns a promise that resolves with the the final assistant Message response,
         * or rejects if an error occurred or the stream ended prematurely without producing a Message.
         * If structured outputs were used, this will be a ParsedMessage with a `parsed_output` field.
         */
        async finalMessage() {
          await this.done();
          return __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_getFinalMessage).call(this);
        }
        /**
         * @returns a promise that resolves with the the final assistant Message's text response, concatenated
         * together if there are more than one text blocks.
         * Rejects if an error occurred or the stream ended prematurely without producing a Message.
         */
        async finalText() {
          await this.done();
          return __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_getFinalText).call(this);
        }
        _emit(event, ...args) {
          if (__classPrivateFieldGet(this, _MessageStream_ended, "f"))
            return;
          if (event === "end") {
            __classPrivateFieldSet(this, _MessageStream_ended, true, "f");
            __classPrivateFieldGet(this, _MessageStream_resolveEndPromise, "f").call(this);
          }
          const listeners = __classPrivateFieldGet(this, _MessageStream_listeners, "f")[event];
          if (listeners) {
            __classPrivateFieldGet(this, _MessageStream_listeners, "f")[event] = listeners.filter((l) => !l.once);
            listeners.forEach(({ listener }) => listener(...args));
          }
          if (event === "abort") {
            const error = args[0];
            if (!__classPrivateFieldGet(this, _MessageStream_catchingPromiseCreated, "f") && !listeners?.length) {
              Promise.reject(error);
            }
            __classPrivateFieldGet(this, _MessageStream_rejectConnectedPromise, "f").call(this, error);
            __classPrivateFieldGet(this, _MessageStream_rejectEndPromise, "f").call(this, error);
            this._emit("end");
            return;
          }
          if (event === "error") {
            const error = args[0];
            if (!__classPrivateFieldGet(this, _MessageStream_catchingPromiseCreated, "f") && !listeners?.length) {
              Promise.reject(error);
            }
            __classPrivateFieldGet(this, _MessageStream_rejectConnectedPromise, "f").call(this, error);
            __classPrivateFieldGet(this, _MessageStream_rejectEndPromise, "f").call(this, error);
            this._emit("end");
          }
        }
        _emitFinal() {
          const finalMessage = this.receivedMessages.at(-1);
          if (finalMessage) {
            this._emit("finalMessage", __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_getFinalMessage).call(this));
          }
        }
        async _fromReadableStream(readableStream, options) {
          const signal = options?.signal;
          let abortHandler;
          if (signal) {
            if (signal.aborted)
              this.controller.abort();
            abortHandler = this.controller.abort.bind(this.controller);
            signal.addEventListener("abort", abortHandler);
          }
          try {
            __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_beginRequest).call(this);
            this._connected(null);
            const stream2 = Stream.fromReadableStream(readableStream, this.controller);
            for await (const event of stream2) {
              __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_addStreamEvent).call(this, event);
            }
            if (stream2.controller.signal?.aborted) {
              throw new APIUserAbortError();
            }
            __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_endRequest).call(this);
          } finally {
            if (signal && abortHandler) {
              signal.removeEventListener("abort", abortHandler);
            }
          }
        }
        [(_MessageStream_currentMessageSnapshot = /* @__PURE__ */ new WeakMap(), _MessageStream_params = /* @__PURE__ */ new WeakMap(), _MessageStream_connectedPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_resolveConnectedPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_rejectConnectedPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_endPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_resolveEndPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_rejectEndPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_listeners = /* @__PURE__ */ new WeakMap(), _MessageStream_ended = /* @__PURE__ */ new WeakMap(), _MessageStream_errored = /* @__PURE__ */ new WeakMap(), _MessageStream_aborted = /* @__PURE__ */ new WeakMap(), _MessageStream_catchingPromiseCreated = /* @__PURE__ */ new WeakMap(), _MessageStream_response = /* @__PURE__ */ new WeakMap(), _MessageStream_request_id = /* @__PURE__ */ new WeakMap(), _MessageStream_workspace_id = /* @__PURE__ */ new WeakMap(), _MessageStream_logger = /* @__PURE__ */ new WeakMap(), _MessageStream_handleError = /* @__PURE__ */ new WeakMap(), _MessageStream_instances = /* @__PURE__ */ new WeakSet(), _MessageStream_getFinalMessage = function _MessageStream_getFinalMessage2() {
          if (this.receivedMessages.length === 0) {
            throw new AnthropicError("stream ended without producing a Message with role=assistant");
          }
          return this.receivedMessages.at(-1);
        }, _MessageStream_getFinalText = function _MessageStream_getFinalText2() {
          if (this.receivedMessages.length === 0) {
            throw new AnthropicError("stream ended without producing a Message with role=assistant");
          }
          const textBlocks = this.receivedMessages.at(-1).content.filter((block) => block.type === "text").map((block) => block.text);
          if (textBlocks.length === 0) {
            throw new AnthropicError("stream ended without producing a content block with type=text");
          }
          return textBlocks.join(" ");
        }, _MessageStream_beginRequest = function _MessageStream_beginRequest2() {
          if (this.ended)
            return;
          __classPrivateFieldSet(this, _MessageStream_currentMessageSnapshot, void 0, "f");
        }, _MessageStream_addStreamEvent = function _MessageStream_addStreamEvent2(event) {
          if (this.ended)
            return;
          const messageSnapshot = __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_accumulateMessage).call(this, event);
          this._emit("streamEvent", event, messageSnapshot);
          switch (event.type) {
            case "content_block_delta": {
              const content = messageSnapshot.content.at(-1);
              switch (event.delta.type) {
                case "text_delta": {
                  if (content.type === "text") {
                    this._emit("text", event.delta.text, content.text || "");
                  }
                  break;
                }
                case "citations_delta": {
                  if (content.type === "text") {
                    this._emit("citation", event.delta.citation, content.citations ?? []);
                  }
                  break;
                }
                case "input_json_delta": {
                  if (tracksToolInput2(content) && __classPrivateFieldGet(this, _MessageStream_listeners, "f").inputJson?.length) {
                    this._emit("inputJson", event.delta.partial_json, content.input);
                  }
                  break;
                }
                case "thinking_delta": {
                  if (content.type === "thinking") {
                    this._emit("thinking", event.delta.thinking, content.thinking);
                  }
                  break;
                }
                case "signature_delta": {
                  if (content.type === "thinking") {
                    this._emit("signature", content.signature);
                  }
                  break;
                }
                default:
                  checkNever(event.delta);
              }
              break;
            }
            case "message_stop": {
              this._addMessageParam(messageSnapshot);
              this._addMessage(maybeParseMessage(messageSnapshot, __classPrivateFieldGet(this, _MessageStream_params, "f"), { logger: __classPrivateFieldGet(this, _MessageStream_logger, "f") }), true);
              break;
            }
            case "content_block_stop": {
              this._emit("contentBlock", messageSnapshot.content.at(-1));
              break;
            }
            case "message_start": {
              __classPrivateFieldSet(this, _MessageStream_currentMessageSnapshot, messageSnapshot, "f");
              break;
            }
            case "content_block_start":
            case "message_delta":
              break;
          }
        }, _MessageStream_endRequest = function _MessageStream_endRequest2() {
          if (this.ended) {
            throw new AnthropicError(`stream has ended, this shouldn't happen`);
          }
          const snapshot2 = __classPrivateFieldGet(this, _MessageStream_currentMessageSnapshot, "f");
          if (!snapshot2) {
            throw new AnthropicError(`request ended without sending any chunks`);
          }
          __classPrivateFieldSet(this, _MessageStream_currentMessageSnapshot, void 0, "f");
          return maybeParseMessage(snapshot2, __classPrivateFieldGet(this, _MessageStream_params, "f"), { logger: __classPrivateFieldGet(this, _MessageStream_logger, "f") });
        }, _MessageStream_accumulateMessage = function _MessageStream_accumulateMessage2(event) {
          let snapshot2 = __classPrivateFieldGet(this, _MessageStream_currentMessageSnapshot, "f");
          if (event.type === "message_start") {
            if (snapshot2) {
              throw new AnthropicError(`Unexpected event order, got ${event.type} before receiving "message_stop"`);
            }
            return event.message;
          }
          if (!snapshot2) {
            throw new AnthropicError(`Unexpected event order, got ${event.type} before "message_start"`);
          }
          switch (event.type) {
            case "message_stop":
              return snapshot2;
            case "message_delta":
              snapshot2.stop_reason = event.delta.stop_reason;
              snapshot2.stop_sequence = event.delta.stop_sequence;
              snapshot2.stop_details = event.delta.stop_details;
              snapshot2.usage.output_tokens = event.usage.output_tokens;
              if (event.delta.container != null) {
                snapshot2.container = event.delta.container;
              }
              if (event.usage.input_tokens != null) {
                snapshot2.usage.input_tokens = event.usage.input_tokens;
              }
              if (event.usage.cache_creation_input_tokens != null) {
                snapshot2.usage.cache_creation_input_tokens = event.usage.cache_creation_input_tokens;
              }
              if (event.usage.cache_read_input_tokens != null) {
                snapshot2.usage.cache_read_input_tokens = event.usage.cache_read_input_tokens;
              }
              if (event.usage.server_tool_use != null) {
                snapshot2.usage.server_tool_use = event.usage.server_tool_use;
              }
              if (event.usage.output_tokens_details != null) {
                snapshot2.usage.output_tokens_details = event.usage.output_tokens_details;
              }
              return snapshot2;
            case "content_block_start":
              snapshot2.content.push({ ...event.content_block });
              return snapshot2;
            case "content_block_delta": {
              const snapshotContent = snapshot2.content.at(event.index);
              switch (event.delta.type) {
                case "text_delta": {
                  if (snapshotContent?.type === "text") {
                    snapshot2.content[event.index] = {
                      ...snapshotContent,
                      text: (snapshotContent.text || "") + event.delta.text
                    };
                  }
                  break;
                }
                case "citations_delta": {
                  if (snapshotContent?.type === "text") {
                    snapshot2.content[event.index] = {
                      ...snapshotContent,
                      citations: [...snapshotContent.citations ?? [], event.delta.citation]
                    };
                  }
                  break;
                }
                case "input_json_delta": {
                  if (snapshotContent && tracksToolInput2(snapshotContent)) {
                    const jsonBuf = (snapshotContent[JSON_BUF_PROPERTY] || "") + event.delta.partial_json;
                    snapshot2.content[event.index] = withLazyInput(snapshotContent, jsonBuf);
                  }
                  break;
                }
                case "thinking_delta": {
                  if (snapshotContent?.type === "thinking") {
                    snapshot2.content[event.index] = {
                      ...snapshotContent,
                      thinking: snapshotContent.thinking + event.delta.thinking
                    };
                  }
                  break;
                }
                case "signature_delta": {
                  if (snapshotContent?.type === "thinking") {
                    snapshot2.content[event.index] = {
                      ...snapshotContent,
                      signature: event.delta.signature
                    };
                  }
                  break;
                }
                default:
                  checkNever(event.delta);
              }
              return snapshot2;
            }
            case "content_block_stop": {
              const snapshotContent = snapshot2.content.at(event.index);
              if (snapshotContent && tracksToolInput2(snapshotContent) && JSON_BUF_PROPERTY in snapshotContent) {
                Object.defineProperty(snapshotContent, "input", {
                  value: snapshotContent.input,
                  enumerable: true,
                  configurable: true,
                  writable: true
                });
              }
              return snapshot2;
            }
          }
        }, Symbol.asyncIterator)]() {
          const pushQueue = [];
          const readQueue = [];
          let done = false;
          this.on("streamEvent", (event) => {
            const reader = readQueue.shift();
            if (reader) {
              reader.resolve(event);
            } else {
              pushQueue.push(event);
            }
          });
          this.on("end", () => {
            done = true;
            for (const reader of readQueue) {
              reader.resolve(void 0);
            }
            readQueue.length = 0;
          });
          this.on("abort", (err) => {
            done = true;
            for (const reader of readQueue) {
              reader.reject(err);
            }
            readQueue.length = 0;
          });
          this.on("error", (err) => {
            done = true;
            for (const reader of readQueue) {
              reader.reject(err);
            }
            readQueue.length = 0;
          });
          return {
            next: async () => {
              if (!pushQueue.length) {
                if (done) {
                  return { value: void 0, done: true };
                }
                return new Promise((resolve2, reject) => readQueue.push({ resolve: resolve2, reject })).then((chunk2) => chunk2 ? { value: chunk2, done: false } : { value: void 0, done: true });
              }
              const chunk = pushQueue.shift();
              return { value: chunk, done: false };
            },
            return: async () => {
              this.abort();
              return { value: void 0, done: true };
            }
          };
        }
        toReadableStream() {
          const stream2 = new Stream(this[Symbol.asyncIterator].bind(this), this.controller);
          return stream2.toReadableStream();
        }
      }
      return MessageStream2;
    })();
  }
});

// node_modules/@anthropic-ai/sdk/resources/messages/batches.mjs
var Batches2;
var init_batches2 = __esm({
  "node_modules/@anthropic-ai/sdk/resources/messages/batches.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_jsonl();
    init_error2();
    init_path();
    Batches2 = class extends APIResource {
      /**
       * Send a batch of Message creation requests.
       *
       * The Message Batches API can be used to process multiple Messages API requests at
       * once. Once a Message Batch is created, it begins processing immediately. Batches
       * can take up to 24 hours to complete.
       *
       * Learn more about the Message Batches API in our
       * [user guide](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
       *
       * @example
       * ```ts
       * const messageBatch = await client.messages.batches.create({
       *   requests: [
       *     {
       *       custom_id: 'my-custom-id-1',
       *       params: {
       *         max_tokens: 1024,
       *         messages: [
       *           { content: 'Hello, world', role: 'user' },
       *         ],
       *         model: 'claude-opus-5',
       *       },
       *     },
       *   ],
       * });
       * ```
       */
      create(params, options) {
        const { user_profile_id, workspace_id, ...body } = params;
        return this._client.post("/v1/messages/batches", {
          body,
          ...options,
          headers: buildHeaders([
            {
              ...user_profile_id != null ? { "anthropic-user-profile-id": user_profile_id } : void 0,
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * This endpoint is idempotent and can be used to poll for Message Batch
       * completion. To access the results of a Message Batch, make a request to the
       * `results_url` field in the response.
       *
       * Learn more about the Message Batches API in our
       * [user guide](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
       *
       * @example
       * ```ts
       * const messageBatch = await client.messages.batches.retrieve(
       *   'message_batch_id',
       * );
       * ```
       */
      retrieve(messageBatchID, params = {}, options) {
        const { workspace_id } = params ?? {};
        return this._client.get(path3`/v1/messages/batches/${messageBatchID}`, {
          ...options,
          headers: buildHeaders([
            { ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0 },
            options?.headers
          ])
        });
      }
      /**
       * List all Message Batches within a Workspace. Most recently created batches are
       * returned first.
       *
       * Learn more about the Message Batches API in our
       * [user guide](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const messageBatch of client.messages.batches.list()) {
       *   // ...
       * }
       * ```
       */
      list(params = {}, options) {
        const { workspace_id, ...query } = params ?? {};
        return this._client.getAPIList("/v1/messages/batches", Page, {
          query,
          ...options,
          headers: buildHeaders([
            { ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0 },
            options?.headers
          ])
        });
      }
      /**
       * Delete a Message Batch.
       *
       * Message Batches can only be deleted once they've finished processing. If you'd
       * like to delete an in-progress batch, you must first cancel it.
       *
       * Learn more about the Message Batches API in our
       * [user guide](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
       *
       * @example
       * ```ts
       * const deletedMessageBatch =
       *   await client.messages.batches.delete('message_batch_id');
       * ```
       */
      delete(messageBatchID, params = {}, options) {
        const { workspace_id } = params ?? {};
        return this._client.delete(path3`/v1/messages/batches/${messageBatchID}`, {
          ...options,
          headers: buildHeaders([
            { ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0 },
            options?.headers
          ])
        });
      }
      /**
       * Batches may be canceled any time before processing ends. Once cancellation is
       * initiated, the batch enters a `canceling` state, at which time the system may
       * complete any in-progress, non-interruptible requests before finalizing
       * cancellation.
       *
       * The number of canceled requests is specified in `request_counts`. To determine
       * which requests were canceled, check the individual results within the batch.
       * Note that cancellation may not result in any canceled requests if they were
       * non-interruptible.
       *
       * Learn more about the Message Batches API in our
       * [user guide](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
       *
       * @example
       * ```ts
       * const messageBatch = await client.messages.batches.cancel(
       *   'message_batch_id',
       * );
       * ```
       */
      cancel(messageBatchID, params = {}, options) {
        const { workspace_id } = params ?? {};
        return this._client.post(path3`/v1/messages/batches/${messageBatchID}/cancel`, {
          ...options,
          headers: buildHeaders([
            { ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0 },
            options?.headers
          ])
        });
      }
      /**
       * Streams the results of a Message Batch as a `.jsonl` file.
       *
       * Each line in the file is a JSON object containing the result of a single request
       * in the Message Batch. Results are not guaranteed to be in the same order as
       * requests. Use the `custom_id` field to match results to requests.
       *
       * Learn more about the Message Batches API in our
       * [user guide](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
       *
       * @example
       * ```ts
       * const messageBatchIndividualResponse =
       *   await client.messages.batches.results('message_batch_id');
       * ```
       */
      async results(messageBatchID, params = {}, options) {
        const batch = await this.retrieve(messageBatchID, params, options);
        if (!batch.results_url) {
          throw new AnthropicError(`No batch \`results_url\`; Has it finished processing? ${batch.processing_status} - ${batch.id}`);
        }
        const { workspace_id } = params ?? {};
        return this._client.get(batch.results_url, {
          ...options,
          headers: buildHeaders([
            {
              Accept: "application/binary",
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ]),
          stream: true,
          __binaryResponse: true
        })._thenUnwrap((_, props) => JSONLDecoder.fromResponse(props.response, props.controller));
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/messages/messages.mjs
var Messages2, DEPRECATED_MODELS2, MODELS_TO_WARN_WITH_THINKING_ENABLED2;
var init_messages2 = __esm({
  "node_modules/@anthropic-ai/sdk/resources/messages/messages.mjs"() {
    init_resource();
    init_headers();
    init_stainless_helper_header();
    init_MessageStream();
    init_parser2();
    init_batches2();
    init_batches2();
    init_constants();
    Messages2 = /* @__PURE__ */ (() => {
      class Messages3 extends APIResource {
        constructor() {
          super(...arguments);
          this.batches = new Batches2(this._client);
        }
        create(params, options) {
          const { user_profile_id, workspace_id, ...body } = params;
          if (body.model in DEPRECATED_MODELS2) {
            console.warn(`The model '${body.model}' is deprecated and will reach end-of-life on ${DEPRECATED_MODELS2[body.model]}
Please migrate to a newer model. Visit https://docs.anthropic.com/en/docs/resources/model-deprecations for more information.`);
          }
          if (MODELS_TO_WARN_WITH_THINKING_ENABLED2.includes(body.model) && body.thinking && body.thinking.type === "enabled") {
            console.warn(`Using Claude with ${body.model} and 'thinking.type=enabled' is deprecated. Use 'thinking.type=adaptive' instead which results in better model performance in our testing: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking`);
          }
          let timeout = options?.timeout ?? this._client._options.timeout;
          if (!body.stream && timeout == null) {
            const maxNonstreamingTokens = MODEL_NONSTREAMING_TOKENS[body.model] ?? void 0;
            timeout = this._client.calculateNonstreamingTimeout(body.max_tokens, maxNonstreamingTokens);
          }
          const helperHeader2 = stainlessHelperHeader(body.tools, body.messages);
          return this._client.post("/v1/messages", {
            body,
            timeout: timeout ?? 6e5,
            ...options,
            headers: buildHeaders([
              {
                ...user_profile_id != null ? { "anthropic-user-profile-id": user_profile_id } : void 0,
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              helperHeader2,
              options?.headers
            ]),
            stream: params.stream ?? false
          });
        }
        /**
         * Send a structured list of input messages with text and/or image content, along with an expected `output_config.format` and
         * the response will be automatically parsed and available in the `parsed_output` property of the message.
         *
         * @example
         * ```ts
         * const message = await client.messages.parse({
         *   model: 'claude-sonnet-4-5-20250929',
         *   max_tokens: 1024,
         *   messages: [{ role: 'user', content: 'What is 2+2?' }],
         *   output_config: {
         *     format: zodOutputFormat(z.object({ answer: z.number() })),
         *   },
         * });
         *
         * console.log(message.parsed_output?.answer); // 4
         * ```
         */
        parse(params, options) {
          return this.create(params, options).then((message) => parseMessage(message, params, { logger: this._client.logger ?? console }));
        }
        /**
         * Create a Message stream.
         *
         * If `output_config.format` is provided with a parseable format (like `zodOutputFormat()`),
         * the final message will include a `parsed_output` property with the parsed content.
         *
         * @example
         * ```ts
         * const stream = client.messages.stream({
         *   model: 'claude-sonnet-4-5-20250929',
         *   max_tokens: 1024,
         *   messages: [{ role: 'user', content: 'What is 2+2?' }],
         *   output_config: {
         *     format: zodOutputFormat(z.object({ answer: z.number() })),
         *   },
         * });
         *
         * const message = await stream.finalMessage();
         * console.log(message.parsed_output?.answer); // 4
         * ```
         */
        stream(body, options) {
          return MessageStream.createMessage(this, body, options, { logger: this._client.logger ?? console });
        }
        /**
         * Count the number of tokens in a Message.
         *
         * The Token Count API can be used to count the number of tokens in a Message,
         * including tools, images, and documents, without creating it.
         *
         * Learn more about token counting in our
         * [user guide](https://platform.claude.com/docs/en/build-with-claude/token-counting)
         *
         * @example
         * ```ts
         * const messageTokensCount =
         *   await client.messages.countTokens({
         *     messages: [{ content: 'Hello, world', role: 'user' }],
         *     model: 'claude-opus-5',
         *   });
         * ```
         */
        countTokens(params, options) {
          const { user_profile_id, workspace_id, ...body } = params;
          return this._client.post("/v1/messages/count_tokens", {
            body,
            ...options,
            headers: buildHeaders([
              {
                ...user_profile_id != null ? { "anthropic-user-profile-id": user_profile_id } : void 0,
                ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
              },
              options?.headers
            ])
          });
        }
      }
      Messages3.Batches = Batches2;
      return Messages3;
    })();
    DEPRECATED_MODELS2 = {};
    MODELS_TO_WARN_WITH_THINKING_ENABLED2 = ["claude-mythos-preview", "claude-opus-4-6"];
  }
});

// node_modules/@anthropic-ai/sdk/resources/models.mjs
var Models2;
var init_models2 = __esm({
  "node_modules/@anthropic-ai/sdk/resources/models.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_path();
    Models2 = class extends APIResource {
      /**
       * Get a specific model.
       *
       * The Models API response can be used to determine information about a specific
       * model or resolve a model alias to a model ID.
       *
       * @example
       * ```ts
       * const modelInfo = await client.models.retrieve('model_id');
       * ```
       */
      retrieve(modelID, params = {}, options) {
        const { betas, workspace_id } = params ?? {};
        return this._client.get(path3`/v1/models/${modelID}`, {
          ...options,
          headers: buildHeaders([
            {
              ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0,
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * List available models.
       *
       * The Models API response can be used to determine which models are available for
       * use in the API. More recently released models are listed first.
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const modelInfo of client.models.list()) {
       *   // ...
       * }
       * ```
       */
      list(params = {}, options) {
        const { betas, workspace_id, ...query } = params ?? {};
        return this._client.getAPIList("/v1/models", Page, {
          query,
          ...options,
          headers: buildHeaders([
            {
              ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0,
              ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0
            },
            options?.headers
          ])
        });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/skills/versions.mjs
var Versions3;
var init_versions3 = __esm({
  "node_modules/@anthropic-ai/sdk/resources/skills/versions.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_uploads();
    init_path();
    Versions3 = class extends APIResource {
      /**
       * Create Skill Version
       *
       * @example
       * ```ts
       * const skillVersion = await client.skills.versions.create(
       *   'skill_id',
       *   { files: [fs.createReadStream('path/to/file')] },
       * );
       * ```
       */
      create(skillID, params, options) {
        const { workspace_id, ...body } = params;
        return this._client.post(path3`/v1/skills/${skillID}/versions`, multipartFormRequestOptions({
          body,
          ...options,
          headers: buildHeaders([
            { ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0 },
            options?.headers
          ])
        }, this._client, false));
      }
      /**
       * Get Skill Version
       *
       * @example
       * ```ts
       * const skillVersion = await client.skills.versions.retrieve(
       *   'version',
       *   { skill_id: 'skill_id' },
       * );
       * ```
       */
      retrieve(version, params, options) {
        const { skill_id, workspace_id } = params;
        return this._client.get(path3`/v1/skills/${skill_id}/versions/${version}`, {
          ...options,
          headers: buildHeaders([
            { ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0 },
            options?.headers
          ])
        });
      }
      /**
       * List Skill Versions
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const skillVersion of client.skills.versions.list(
       *   'skill_id',
       * )) {
       *   // ...
       * }
       * ```
       */
      list(skillID, params = {}, options) {
        const { workspace_id, ...query } = params ?? {};
        return this._client.getAPIList(path3`/v1/skills/${skillID}/versions`, PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            { ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0 },
            options?.headers
          ])
        });
      }
      /**
       * Delete Skill Version
       *
       * @example
       * ```ts
       * const deletedSkillVersion =
       *   await client.skills.versions.delete('version', {
       *     skill_id: 'skill_id',
       *   });
       * ```
       */
      delete(version, params, options) {
        const { skill_id, workspace_id } = params;
        return this._client.delete(path3`/v1/skills/${skill_id}/versions/${version}`, {
          ...options,
          headers: buildHeaders([
            { ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0 },
            options?.headers
          ])
        });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/skills/skills.mjs
var Skills2;
var init_skills3 = __esm({
  "node_modules/@anthropic-ai/sdk/resources/skills/skills.mjs"() {
    init_resource();
    init_versions3();
    init_versions3();
    init_pagination();
    init_headers();
    init_uploads();
    init_path();
    Skills2 = /* @__PURE__ */ (() => {
      class Skills3 extends APIResource {
        constructor() {
          super(...arguments);
          this.versions = new Versions3(this._client);
        }
        /**
         * Create Skill
         *
         * @example
         * ```ts
         * const skill = await client.skills.create({
         *   files: [fs.createReadStream('path/to/file')],
         * });
         * ```
         */
        create(params, options) {
          const { workspace_id, ...body } = params;
          return this._client.post("/v1/skills", multipartFormRequestOptions({
            body,
            ...options,
            headers: buildHeaders([
              { ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0 },
              options?.headers
            ])
          }, this._client, false));
        }
        /**
         * Get Skill
         *
         * @example
         * ```ts
         * const skill = await client.skills.retrieve('skill_id');
         * ```
         */
        retrieve(skillID, params = {}, options) {
          const { workspace_id } = params ?? {};
          return this._client.get(path3`/v1/skills/${skillID}`, {
            ...options,
            headers: buildHeaders([
              { ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0 },
              options?.headers
            ])
          });
        }
        /**
         * List Skills
         *
         * @example
         * ```ts
         * // Automatically fetches more pages as needed.
         * for await (const skill of client.skills.list()) {
         *   // ...
         * }
         * ```
         */
        list(params = {}, options) {
          const { workspace_id, ...query } = params ?? {};
          return this._client.getAPIList("/v1/skills", PageCursor, {
            query,
            ...options,
            headers: buildHeaders([
              { ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0 },
              options?.headers
            ])
          });
        }
        /**
         * Delete Skill
         *
         * @example
         * ```ts
         * const deletedSkill = await client.skills.delete('skill_id');
         * ```
         */
        delete(skillID, params = {}, options) {
          const { workspace_id } = params ?? {};
          return this._client.delete(path3`/v1/skills/${skillID}`, {
            ...options,
            headers: buildHeaders([
              { ...workspace_id != null ? { "anthropic-workspace-id": workspace_id } : void 0 },
              options?.headers
            ])
          });
        }
      }
      Skills3.Versions = Versions3;
      return Skills3;
    })();
  }
});

// node_modules/@anthropic-ai/sdk/resources/index.mjs
var init_resources2 = __esm({
  "node_modules/@anthropic-ai/sdk/resources/index.mjs"() {
    init_shared();
    init_beta();
    init_completions();
    init_files2();
    init_messages2();
    init_models2();
    init_skills3();
  }
});

// node_modules/@anthropic-ai/sdk/client.mjs
var _BaseAnthropic_instances, _a, _BaseAnthropic_encoder, _BaseAnthropic_baseURLOverridden, HUMAN_PROMPT, AI_PROMPT, BaseAnthropic, Anthropic;
var init_client = __esm({
  "node_modules/@anthropic-ai/sdk/client.mjs"() {
    init_tslib();
    init_values();
    init_sleep();
    init_errors();
    init_detect_platform();
    init_request_signal();
    init_shims();
    init_request_options();
    init_query();
    init_version();
    init_error();
    init_types();
    init_token_cache();
    init_credential_chain();
    init_middleware();
    init_pagination();
    init_uploads2();
    init_resources2();
    init_api_promise();
    init_completions();
    init_files2();
    init_models2();
    init_beta();
    init_messages2();
    init_skills3();
    init_detect_platform();
    init_headers();
    init_env();
    init_log();
    init_values();
    HUMAN_PROMPT = "\\n\\nHuman:";
    AI_PROMPT = "\\n\\nAssistant:";
    BaseAnthropic = /* @__PURE__ */ (() => {
      class BaseAnthropic2 {
        /**
         * The active credential provider. Default credential resolution runs once
         * at construction time. If it fails, the error is surfaced on every
         * request and the client must be reconstructed — there is no retry path.
         *
         * Clones returned by {@link withOptions} share the parent's auth state
         * (provider, token cache, pending resolution, and any resolution error)
         * unless the caller passes an explicit `apiKey`, `authToken`,
         * `credentials`, `config`, or `profile` override.
         */
        get credentials() {
          return this._authState.provider;
        }
        /**
         * API Client for interfacing with the Anthropic API.
         *
         * @param {string | null | undefined} [opts.apiKey=process.env['ANTHROPIC_API_KEY'] ?? null]
         * @param {string | null | undefined} [opts.authToken=process.env['ANTHROPIC_AUTH_TOKEN'] ?? null]
         * @param {string | null | undefined} [opts.webhookKey=process.env['ANTHROPIC_WEBHOOK_SIGNING_KEY'] ?? null]
         * @param {string} [opts.baseURL=process.env['ANTHROPIC_BASE_URL'] ?? https://api.anthropic.com] - Override the default base URL for the API.
         * @param {number} [opts.timeout=10 minutes] - The maximum amount of time (in milliseconds) the client will wait for a response before timing out.
         * @param {MergedRequestInit} [opts.fetchOptions] - Additional `RequestInit` options to be passed to `fetch` calls.
         * @param {Fetch} [opts.fetch] - Specify a custom `fetch` function implementation.
         * @param {number} [opts.maxRetries=2] - The maximum number of times the client will retry a request.
         * @param {HeadersLike} opts.defaultHeaders - Default headers to include with every request to the API.
         * @param {Record<string, string | undefined>} opts.defaultQuery - Default query parameters to include with every request to the API.
         * @param {boolean} [opts.dangerouslyAllowBrowser=false] - By default, client-side use of this library is not allowed, as it risks exposing your secret API credentials to attackers.
         */
        constructor({ baseURL: baseURL2 = readEnv("ANTHROPIC_BASE_URL"), apiKey: apiKey2, authToken, webhookKey = readEnv("ANTHROPIC_WEBHOOK_SIGNING_KEY") ?? null, ...opts } = {}) {
          _BaseAnthropic_instances.add(this);
          this._requestAuthFlags = /* @__PURE__ */ new WeakMap();
          _BaseAnthropic_encoder.set(this, void 0);
          if (apiKey2 === void 0) {
            apiKey2 = opts.profile != null ? null : readEnv("ANTHROPIC_API_KEY") ?? null;
          }
          if (authToken === void 0) {
            authToken = opts.profile != null ? null : readEnv("ANTHROPIC_AUTH_TOKEN") ?? null;
          }
          if (opts.profile != null && (opts.credentials != null || opts.config != null)) {
            throw new TypeError("Pass at most one of `profile`, `credentials`, or `config`.");
          }
          const options = {
            apiKey: apiKey2,
            authToken,
            webhookKey,
            ...opts,
            baseURL: baseURL2 || `https://api.anthropic.com`
          };
          if (!options.dangerouslyAllowBrowser && isRunningInBrowser()) {
            throw new AnthropicError("It looks like you're running in a browser-like environment.\n\nThis is disabled by default, as it risks exposing your secret API credentials to attackers.\nIf you understand the risks and have appropriate mitigations in place,\nyou can set the `dangerouslyAllowBrowser` option to `true`, e.g.,\n\nnew Anthropic({ apiKey, dangerouslyAllowBrowser: true });\n");
          }
          this.baseURL = options.baseURL;
          this._baseURLIsExplicit = opts.__baseURLIsExplicit ?? !!baseURL2;
          this.timeout = options.timeout ?? _a.DEFAULT_TIMEOUT;
          this.logger = options.logger ?? console;
          this.logLevel = defaultLogLevel;
          this.logLevel = parseLogLevel(options.logLevel, "ClientOptions.logLevel", loggerFor(this)) ?? parseLogLevel(readEnv("ANTHROPIC_LOG"), "process.env['ANTHROPIC_LOG']", loggerFor(this)) ?? defaultLogLevel;
          this.fetchOptions = options.fetchOptions;
          this.maxRetries = validatePositiveInteger("maxRetries", options.maxRetries ?? 2);
          this.fetch = options.fetch ?? getDefaultFetch();
          __classPrivateFieldSet(this, _BaseAnthropic_encoder, FallbackEncoder, "f");
          this.middleware = [...options.middleware ?? []];
          const customHeadersEnv = readEnv("ANTHROPIC_CUSTOM_HEADERS");
          if (customHeadersEnv) {
            const parsed = {};
            for (const line of customHeadersEnv.split("\n")) {
              const colon = line.indexOf(":");
              if (colon >= 0) {
                parsed[line.substring(0, colon).trim()] = line.substring(colon + 1).trim();
              }
            }
            options.defaultHeaders = { ...parsed, ...options.defaultHeaders };
          }
          const inherited = opts.__auth;
          delete options.__auth;
          delete options.__baseURLIsExplicit;
          this._options = options;
          this.apiKey = typeof apiKey2 === "string" ? apiKey2 : null;
          this.authToken = authToken;
          this.webhookKey = webhookKey;
          if (inherited) {
            this._authState = inherited;
            if (!this._baseURLIsExplicit && inherited.baseURL) {
              this.baseURL = inherited.baseURL;
            }
          } else {
            this._authState = { provider: null, tokenCache: null, resolution: null, error: null, extraHeaders: {} };
            if (this.apiKey == null && this.authToken == null) {
              const credentials = options.credentials ?? null;
              if (credentials) {
                this._authState.provider = credentials;
                this._authState.tokenCache = this._makeTokenCache(credentials);
              } else if (options.config != null) {
                const result = resolveCredentialsFromConfig(options.config, this._credentialResolverOptions());
                this._authState.provider = result.provider;
                this._authState.tokenCache = this._makeTokenCache(result.provider);
                this._authState.extraHeaders = result.extraHeaders;
                this._applyCredentialBaseURL(result.baseURL);
              } else if (options.profile != null) {
                this._authState.resolution = this._resolveDefaultCredentials(options.profile);
              } else if (this._shouldResolveDefaultCredentials()) {
                this._authState.resolution = this._resolveDefaultCredentials();
              }
            }
          }
        }
        /**
         * Whether to lazily resolve auth from the default credential chain when no
         * explicit auth is configured. Called once from the constructor, so
         * overrides must not depend on subclass instance state. Subclasses that
         * bring their own auth scheme return false so unrelated local credentials
         * are never resolved or allowed to supply a base URL.
         */
        _shouldResolveDefaultCredentials() {
          return true;
        }
        /**
         * Stores a profile/config-supplied base URL on the shared auth state and, if
         * the caller did not pin `baseURL` via constructor option or env, adopts it
         * as this client's outbound API host. Precedence: ctor opt > env > profile >
         * hardcoded default.
         */
        _applyCredentialBaseURL(baseURL2) {
          if (!baseURL2)
            return;
          const normalized = baseURL2.replace(/\/+$/, "");
          this._authState.baseURL = normalized;
          if (!this._baseURLIsExplicit) {
            this.baseURL = normalized;
          }
        }
        /**
         * Options bag passed into the credential chain. `baseURL` here is only the
         * fallback host for the token-exchange POST when the config itself omits
         * `base_url`; the chain returns the config's own `base_url` (if any) on
         * {@link CredentialResult.baseURL}, which {@link _applyCredentialBaseURL}
         * then adopts for outbound API requests. The two are deliberately decoupled
         * so this fallback never round-trips into precedence.
         */
        _credentialResolverOptions() {
          return {
            baseURL: this.baseURL,
            fetch: this._credentialsFetch(),
            userAgent: this.getUserAgent(),
            onCacheWriteError: (err) => {
              loggerFor(this).debug("credential cache write failed (best-effort)", err);
            },
            onSafetyWarning: (msg) => {
              loggerFor(this).warn(msg);
            }
          };
        }
        /**
         * A `Fetch` for first-party credential token-exchange requests (OIDC
         * federation jwt-bearer grants, user-OAuth refresh grants) that routes
         * through this client's middleware chain, so middleware observes token
         * traffic like any other request. Only client-level middleware applies:
         * a minted token is shared across requests, so attributing the exchange
         * to any one request's per-request middleware would be arbitrary. For the
         * same reason, `ctx.options` is undefined for these requests.
         */
        _credentialsFetch() {
          return wrapFetchWithMiddleware(this.fetch, this.middleware, void 0, this);
        }
        _makeTokenCache(provider) {
          return new TokenCache(provider, (err) => {
            loggerFor(this).debug("advisory token refresh failed; serving cached token", err);
          });
        }
        /**
         * Create a new client instance re-using the same options given to the
         * current client with optional overriding.
         */
        withOptions(options) {
          const overridesStructuredAuth = "credentials" in options || "config" in options || "profile" in options;
          const overridesAuth = "apiKey" in options || "authToken" in options || overridesStructuredAuth;
          const internal = {
            ...this._options,
            // Only forward baseURL when the caller (or env) explicitly chose it.
            // For a non-explicit parent, this.baseURL may have been mutated to the
            // profile-resolved host; pinning that as the clone's options.baseURL
            // would make _options on the clone misreport caller intent and would
            // leave the clone stuck on the parent's host across an auth override.
            // The clone instead receives the construction-time value via
            // ...this._options above and re-adopts the profile host through the
            // shared _authState.baseURL + __baseURLIsExplicit=false path.
            ...this._baseURLIsExplicit ? { baseURL: this.baseURL } : {},
            maxRetries: this.maxRetries,
            timeout: this.timeout,
            logger: this.logger,
            logLevel: this.logLevel,
            fetch: this.fetch,
            fetchOptions: this.fetchOptions,
            middleware: this.middleware,
            apiKey: this.apiKey,
            authToken: this.authToken,
            webhookKey: this.webhookKey,
            // credentials: this.credentials is a no-op when __auth is shared (the
            // ctor takes the inherited path and ignores options.credentials); when
            // overridesAuth is true via apiKey/authToken only, it lets the clone
            // build a fresh TokenCache around the parent's provider.
            credentials: this.credentials,
            // When the caller passes a structured-credential override, drop inherited
            // structured-credential options so only `...options` supplies them —
            // otherwise an inherited `credentials`/`config`/`profile` would trip the
            // mutual-exclusion check or precedence over the override.
            ...overridesStructuredAuth ? { credentials: void 0, config: void 0, profile: void 0 } : {},
            ...options,
            // Always set __auth so any stale value from ...this._options is
            // overwritten. undefined means "build fresh auth from these options".
            __auth: overridesAuth ? void 0 : this._authState,
            __baseURLIsExplicit: "baseURL" in options ? true : this._baseURLIsExplicit
          };
          return new this.constructor(internal);
        }
        /**
         * Lazily resolves credentials from config files or environment variables.
         * Called once from the constructor when no explicit auth is provided, or
         * when an explicit `profile` was passed (in which case a missing/unresolved
         * profile is surfaced as an error instead of falling through to "no auth").
         * The returned promise is stored and awaited on the first request.
         */
        async _resolveDefaultCredentials(profile) {
          try {
            const result = await defaultCredentials(this._credentialResolverOptions(), profile);
            if (result) {
              this._authState.provider = result.provider;
              this._authState.tokenCache = this._makeTokenCache(result.provider);
              this._authState.extraHeaders = result.extraHeaders;
              this._applyCredentialBaseURL(result.baseURL);
            } else if (profile != null) {
              throw new AnthropicError(`Profile "${profile}" could not be resolved (no <config_dir>/configs/${profile}.json found).`);
            }
          } catch (err) {
            this._authState.error = err;
          } finally {
            this._authState.resolution = null;
          }
        }
        defaultQuery() {
          return this._options.defaultQuery;
        }
        validateHeaders({ values, nulls }) {
          if (values.get("x-api-key") || values.get("authorization")) {
            return;
          }
          if (this._authState.error) {
            throw this._authState.error;
          }
          if (this._authState.tokenCache || this._authState.resolution) {
            return;
          }
          if (this.apiKey && values.get("x-api-key")) {
            return;
          }
          if (nulls.has("x-api-key")) {
            return;
          }
          if (this.authToken && values.get("authorization")) {
            return;
          }
          if (nulls.has("authorization")) {
            return;
          }
          throw new Error('Could not resolve authentication method. Expected one of apiKey, authToken, credentials, config, or profile to be set. Or for one of the "X-Api-Key" or "Authorization" headers to be explicitly omitted');
        }
        _authFlags(opts) {
          let flags = this._requestAuthFlags.get(opts);
          if (!flags) {
            flags = { usedTokenCache: false, didRefreshFor401: false };
            this._requestAuthFlags.set(opts, flags);
          }
          return flags;
        }
        async authHeaders(opts) {
          if (this._authState.resolution) {
            await this._authState.resolution;
          }
          if (this._authState.error) {
            return void 0;
          }
          if (this._authState.tokenCache && this.apiKey == null) {
            const token = await this._authState.tokenCache.getToken();
            this._authFlags(opts).usedTokenCache = true;
            return buildHeaders([{ Authorization: `Bearer ${token}` }]);
          }
          return buildHeaders([await this.apiKeyAuth(opts), await this.bearerAuth(opts)]);
        }
        async apiKeyAuth(opts) {
          if (this.apiKey == null) {
            return void 0;
          }
          return buildHeaders([{ "X-Api-Key": this.apiKey }]);
        }
        async bearerAuth(opts) {
          if (this.authToken == null) {
            return void 0;
          }
          return buildHeaders([{ Authorization: `Bearer ${this.authToken}` }]);
        }
        stringifyQuery(query) {
          return stringifyQuery(query);
        }
        getUserAgent() {
          return `Anthropic/JS ${VERSION}`;
        }
        makeStatusError(status, error, message, headers) {
          return APIError.generate(status, error, message, headers);
        }
        buildURL(path11, query, defaultBaseURL) {
          const baseURL2 = !__classPrivateFieldGet(this, _BaseAnthropic_instances, "m", _BaseAnthropic_baseURLOverridden).call(this) && defaultBaseURL || this.baseURL;
          const url = isAbsoluteURL(path11) ? new URL(path11) : new URL(baseURL2 + (baseURL2.endsWith("/") && path11.startsWith("/") ? path11.slice(1) : path11));
          const defaultQuery = this.defaultQuery();
          const pathQuery = Object.fromEntries(url.searchParams);
          if (!isEmptyObj(defaultQuery) || !isEmptyObj(pathQuery)) {
            query = { ...pathQuery, ...defaultQuery, ...query };
          }
          if (typeof query === "object" && query && !Array.isArray(query)) {
            url.search = this.stringifyQuery(query);
          }
          return url.toString();
        }
        _calculateNonstreamingTimeout(maxTokens) {
          const defaultTimeout = 10 * 60;
          const expectedTimeout = 60 * 60 * maxTokens / 128e3;
          if (expectedTimeout > defaultTimeout) {
            throw new AnthropicError("Streaming is required for operations that may take longer than 10 minutes. See https://github.com/anthropics/anthropic-sdk-typescript#streaming-responses for more details");
          }
          return defaultTimeout * 1e3;
        }
        /**
         * Used as a callback for mutating the given `FinalRequestOptions` object.
         */
        async prepareOptions(options) {
        }
        /**
         * Used as a callback for mutating the given `RequestInit` object.
         *
         * This is useful for cases where you want to add certain headers based off of
         * the request properties, e.g. `method` or `url`.
         *
         * Runs after all middleware (including {@link backendMiddleware}),
         * immediately before each underlying fetch call, so it sees exactly what
         * goes over the wire. Middleware may replay a request by calling `next()`
         * more than once, so this hook can run multiple times per attempt:
         * overrides must be idempotent and overwrite headers from a previous
         * invocation rather than append to them.
         */
        async prepareRequest(request, { url, options }) {
          if (this._authState.tokenCache && this.apiKey == null) {
            const headers = request.headers instanceof Headers ? request.headers : new Headers(request.headers);
            for (const [k, v] of Object.entries(this._authState.extraHeaders)) {
              if (!headers.has(k))
                headers.set(k, v);
            }
            const existing = headers.get("anthropic-beta")?.split(",").map((s) => s.trim());
            if (!existing?.includes(OAUTH_API_BETA_HEADER)) {
              headers.set("anthropic-beta", [...existing ?? [], OAUTH_API_BETA_HEADER].join(","));
            }
            request.headers = headers;
          }
        }
        /**
         * Internal {@link Middleware} composed innermost in the chain — inside both
         * client-level and per-request middleware, immediately around the underlying
         * `fetch`. Subclasses for third-party backends override this to adapt the
         * canonical Anthropic-shaped request to the backend's wire shape (URL/body
         * rewriting, request signing) and to normalize the wire response back to the
         * canonical shape (e.g. AWS EventStream to SSE).
         *
         * Running inside the user's middleware means user middleware always observes
         * canonical Anthropic-shaped traffic, and the adaptation re-runs (e.g.
         * re-signs) on every `next()` invocation, covering whatever the middleware
         * mutated.
         *
         * Errors thrown here follow the middleware error policy: they propagate to
         * the caller as-is — no retries, no `APIConnectionError` wrapping — unless
         * retryable (see {@link Middleware}); throw a `RetryableError` to opt into
         * the retry path.
         */
        backendMiddleware() {
          return [];
        }
        get(path11, opts) {
          return this.methodRequest("get", path11, opts);
        }
        post(path11, opts) {
          return this.methodRequest("post", path11, opts);
        }
        patch(path11, opts) {
          return this.methodRequest("patch", path11, opts);
        }
        put(path11, opts) {
          return this.methodRequest("put", path11, opts);
        }
        delete(path11, opts) {
          return this.methodRequest("delete", path11, opts);
        }
        methodRequest(method, path11, opts) {
          return this.request(Promise.resolve(opts).then((opts2) => {
            return { method, path: path11, ...opts2 };
          }));
        }
        request(options, remainingRetries = null) {
          return new APIPromise(this, this.makeRequest(options, remainingRetries, void 0));
        }
        async makeRequest(optionsInput, retriesRemaining, retryOfRequestLogID) {
          const options = await optionsInput;
          let maxRetries = validatePositiveInteger("maxRetries", options.maxRetries ?? this.maxRetries);
          if (this.isStreamBody(options.body)) {
            maxRetries = 0;
          }
          if (retriesRemaining == null) {
            retriesRemaining = maxRetries;
            this._requestAuthFlags.delete(options);
          }
          await this.prepareOptions(options);
          const { req, url, timeout } = await this.buildRequest(options, {
            retryCount: maxRetries - retriesRemaining
          });
          const requestLogID = "log_" + (Math.random() * (1 << 24) | 0).toString(16).padStart(6, "0");
          const retryLogStr = retryOfRequestLogID === void 0 ? "" : `, retryOf: ${retryOfRequestLogID}`;
          const startTime = Date.now();
          if (options.signal?.aborted) {
            throw new APIUserAbortError();
          }
          const controller = new AbortController();
          const response = await this.fetchWithTimeout(url, req, timeout, controller, options, {
            requestLogID,
            retryOfRequestLogID
          }).catch(castToError);
          const headersTime = Date.now();
          if (response instanceof globalThis.Error) {
            releaseRequestSignal(controller);
            const retryMessage = `retrying, ${retriesRemaining} attempts remaining`;
            if (options.signal?.aborted) {
              throw new APIUserAbortError();
            }
            const isTimeout = isAbortError(response) || /timed? ?out/i.test(String(response) + ("cause" in response ? String(response.cause) : ""));
            const hasMiddleware = this.middleware.length > 0 || !!options.middleware?.length || this.backendMiddleware().length > 0;
            if (hasMiddleware && !isTimeout && !isRetryableError(response)) {
              loggerFor(this).info(`[${requestLogID}] middleware error (not retryable)`);
              debugLogRequestDetails(loggerFor(this), `[${requestLogID}] middleware error (not retryable)`, {
                retryOfRequestLogID,
                url,
                durationMs: headersTime - startTime,
                message: response.message
              });
              throw response;
            }
            if (retriesRemaining) {
              loggerFor(this).info(`[${requestLogID}] connection ${isTimeout ? "timed out" : "failed"} - ${retryMessage}`);
              debugLogRequestDetails(loggerFor(this), `[${requestLogID}] connection ${isTimeout ? "timed out" : "failed"} (${retryMessage})`, {
                retryOfRequestLogID,
                url,
                durationMs: headersTime - startTime,
                message: response.message
              });
              return this.retryRequest(options, retriesRemaining, retryOfRequestLogID ?? requestLogID);
            }
            loggerFor(this).info(`[${requestLogID}] connection ${isTimeout ? "timed out" : "failed"} - error; no more retries left`);
            debugLogRequestDetails(loggerFor(this), `[${requestLogID}] connection ${isTimeout ? "timed out" : "failed"} (error; no more retries left)`, {
              retryOfRequestLogID,
              url,
              durationMs: headersTime - startTime,
              message: response.message
            });
            if (isTimeout) {
              throw new APIConnectionTimeoutError();
            }
            if (hasMiddleware && !isFetchOriginError(response)) {
              throw response;
            }
            throw new APIConnectionError({ cause: response });
          }
          const specialHeaders = [...response.headers.entries()].filter(([name]) => name === "request-id" || name === "anthropic-workspace-id").map(([name, value]) => ", " + name + ": " + JSON.stringify(value)).join("");
          const responseInfo = `[${requestLogID}${retryLogStr}${specialHeaders}] ${req.method} ${url} ${response.ok ? "succeeded" : "failed"} with status ${response.status} in ${headersTime - startTime}ms`;
          if (!response.ok) {
            const shouldRetry = await this.shouldRetry(response, options);
            if (retriesRemaining && shouldRetry) {
              const retryMessage2 = `retrying, ${retriesRemaining} attempts remaining`;
              await CancelReadableStream(response.body);
              releaseRequestSignal(controller);
              loggerFor(this).info(`${responseInfo} - ${retryMessage2}`);
              debugLogRequestDetails(loggerFor(this), `[${requestLogID}] response error (${retryMessage2})`, {
                retryOfRequestLogID,
                url: response.url,
                status: response.status,
                headers: response.headers,
                durationMs: headersTime - startTime
              });
              return this.retryRequest(options, retriesRemaining, retryOfRequestLogID ?? requestLogID, response.headers);
            }
            const retryMessage = shouldRetry ? `error; no more retries left` : `error; not retryable`;
            loggerFor(this).info(`${responseInfo} - ${retryMessage}`);
            const errText = await response.text().catch((err2) => castToError(err2).message);
            const errJSON = safeJSON(errText);
            const errMessage = errJSON ? void 0 : errText;
            debugLogRequestDetails(loggerFor(this), `[${requestLogID}] response error (${retryMessage})`, {
              retryOfRequestLogID,
              url: response.url,
              status: response.status,
              headers: response.headers,
              message: errMessage,
              durationMs: Date.now() - startTime
            });
            releaseRequestSignal(controller);
            const err = this.makeStatusError(response.status, errJSON, errMessage, response.headers);
            throw err;
          }
          loggerFor(this).info(responseInfo);
          debugLogRequestDetails(loggerFor(this), `[${requestLogID}] response start`, {
            retryOfRequestLogID,
            url: response.url,
            status: response.status,
            headers: response.headers,
            durationMs: headersTime - startTime
          });
          armAbandonmentBackstop(response.body ?? response, controller);
          return { response, options, controller, requestLogID, retryOfRequestLogID, startTime };
        }
        getAPIList(path11, Page2, opts) {
          return this.requestAPIList(Page2, opts && "then" in opts ? opts.then((opts2) => ({ method: "get", path: path11, ...opts2 })) : { method: "get", path: path11, ...opts });
        }
        requestAPIList(Page2, options) {
          const request = this.makeRequest(options, null, void 0);
          return new PagePromise(this, request, Page2);
        }
        async fetchWithTimeout(url, init2, ms, controller, requestOptions, logCtx) {
          const { signal, method, ...options } = init2 || {};
          const abort = this._makeAbort(controller);
          if (signal) {
            signal.addEventListener("abort", abort, { once: true });
            registerRequestSignalCleanup(controller, signal, abort);
          }
          const isReadableBody = globalThis.ReadableStream && options.body instanceof globalThis.ReadableStream || typeof options.body === "object" && options.body !== null && Symbol.asyncIterator in options.body;
          const fetchOptions = {
            signal: controller.signal,
            ...isReadableBody ? { duplex: "half" } : {},
            method: "GET",
            ...options
          };
          if (method) {
            fetchOptions.method = method.toUpperCase();
          }
          const baseFetch = this.fetch;
          const timedFetch = async (innerUrl, innerInit) => {
            const timeout = setTimeout(abort, ms);
            try {
              return await baseFetch.call(void 0, innerUrl, innerInit);
            } finally {
              clearTimeout(timeout);
            }
          };
          const innerFetch = requestOptions === void 0 ? timedFetch : (async (innerUrl, innerInit = {}) => {
            const innerUrlStr = typeof innerUrl === "string" ? innerUrl : innerUrl instanceof URL ? innerUrl.href : innerUrl.url;
            innerInit.headers = innerInit.headers instanceof Headers ? innerInit.headers : new Headers(innerInit.headers);
            await this.prepareRequest(innerInit, { url: innerUrlStr, options: requestOptions });
            if (logCtx) {
              debugLogRequestDetails(loggerFor(this), `[${logCtx.requestLogID}] sending request`, {
                retryOfRequestLogID: logCtx.retryOfRequestLogID,
                method: innerInit.method,
                url: innerUrlStr,
                options: requestOptions,
                headers: innerInit.headers
              });
            }
            return timedFetch(innerUrl, innerInit);
          });
          const requestMiddleware = requestOptions?.middleware;
          const backendMiddleware = this.backendMiddleware();
          const allMiddleware = requestMiddleware?.length || backendMiddleware.length ? [...this.middleware, ...requestMiddleware ?? [], ...backendMiddleware] : this.middleware;
          return await wrapFetchWithMiddleware(innerFetch, allMiddleware, requestOptions, this)(url, fetchOptions);
        }
        async shouldRetry(response, options) {
          const flags = this._authFlags(options);
          if (response.status === 401 && this._authState.tokenCache && flags.usedTokenCache && !flags.didRefreshFor401) {
            flags.didRefreshFor401 = true;
            this._authState.tokenCache.invalidate();
            return true;
          }
          const shouldRetryHeader = response.headers.get("x-should-retry");
          if (shouldRetryHeader === "true")
            return true;
          if (shouldRetryHeader === "false")
            return false;
          if (response.status === 408)
            return true;
          if (response.status === 409)
            return true;
          if (response.status === 429)
            return true;
          if (response.status >= 500)
            return true;
          return false;
        }
        async retryRequest(options, retriesRemaining, requestLogID, responseHeaders) {
          let timeoutMillis;
          const retryAfterMillisHeader = responseHeaders?.get("retry-after-ms");
          if (retryAfterMillisHeader) {
            const timeoutMs = parseFloat(retryAfterMillisHeader);
            if (!Number.isNaN(timeoutMs)) {
              timeoutMillis = timeoutMs;
            }
          }
          const retryAfterHeader = responseHeaders?.get("retry-after");
          if (retryAfterHeader && !timeoutMillis) {
            const timeoutSeconds = parseFloat(retryAfterHeader);
            if (!Number.isNaN(timeoutSeconds)) {
              timeoutMillis = timeoutSeconds * 1e3;
            } else {
              timeoutMillis = Date.parse(retryAfterHeader) - Date.now();
            }
          }
          if (timeoutMillis === void 0 || !(timeoutMillis > 0 && timeoutMillis <= 2 ** 31 - 1)) {
            const maxRetries = options.maxRetries ?? this.maxRetries;
            timeoutMillis = this.calculateDefaultRetryTimeoutMillis(retriesRemaining, maxRetries);
          }
          await sleep(timeoutMillis, options.signal ?? void 0);
          return this.makeRequest(options, retriesRemaining - 1, requestLogID);
        }
        calculateDefaultRetryTimeoutMillis(retriesRemaining, maxRetries) {
          const initialRetryDelay = 0.5;
          const maxRetryDelay = 8;
          const numRetries = maxRetries - retriesRemaining;
          const sleepSeconds = Math.min(initialRetryDelay * Math.pow(2, numRetries), maxRetryDelay);
          const jitter2 = 1 - Math.random() * 0.25;
          return sleepSeconds * jitter2 * 1e3;
        }
        calculateNonstreamingTimeout(maxTokens, maxNonstreamingTokens) {
          const maxTime = 60 * 60 * 1e3;
          const defaultTime = 60 * 10 * 1e3;
          const expectedTime = maxTime * maxTokens / 128e3;
          if (expectedTime > defaultTime || maxNonstreamingTokens != null && maxTokens > maxNonstreamingTokens) {
            throw new AnthropicError("Streaming is required for operations that may take longer than 10 minutes. See https://github.com/anthropics/anthropic-sdk-typescript#long-requests for more details");
          }
          return defaultTime;
        }
        async buildRequest(inputOptions, { retryCount = 0 } = {}) {
          const options = { ...inputOptions };
          const { method, path: path11, query, defaultBaseURL } = options;
          if (this._authState.resolution) {
            await this._authState.resolution;
          }
          if (!this._baseURLIsExplicit && this._authState.baseURL && this.baseURL !== this._authState.baseURL) {
            this.baseURL = this._authState.baseURL;
          }
          const url = this.buildURL(path11, query, defaultBaseURL);
          if ("timeout" in options)
            validatePositiveInteger("timeout", options.timeout);
          options.timeout = options.timeout ?? this.timeout;
          const { bodyHeaders, body } = this.buildBody({ options });
          const reqHeaders = await this.buildHeaders({
            options: inputOptions,
            method,
            bodyHeaders,
            retryCount,
            timeout: options.timeout
          });
          const req = {
            method,
            headers: reqHeaders,
            ...options.signal && { signal: options.signal },
            ...globalThis.ReadableStream && body instanceof globalThis.ReadableStream && { duplex: "half" },
            ...body && { body },
            ...this.fetchOptions ?? {},
            ...options.fetchOptions ?? {}
          };
          return { req, url, timeout: options.timeout };
        }
        async buildHeaders({ options, method, bodyHeaders, retryCount, timeout }) {
          const headers = buildHeaders([
            {
              Accept: "application/json",
              "User-Agent": this.getUserAgent(),
              "X-Stainless-Retry-Count": String(retryCount),
              "X-Stainless-Timeout": String(Math.trunc(timeout / 1e3)),
              ...getPlatformHeaders(),
              ...this._options.dangerouslyAllowBrowser ? { "anthropic-dangerous-direct-browser-access": "true" } : void 0,
              "anthropic-version": "2023-06-01"
            },
            await this.authHeaders(options),
            this._options.defaultHeaders,
            bodyHeaders,
            options.headers
          ]);
          this.validateHeaders(headers);
          return headers.values;
        }
        _makeAbort(controller) {
          return () => controller.abort();
        }
        buildBody({ options: { body, headers: rawHeaders } }) {
          if (!body) {
            return { bodyHeaders: void 0, body: void 0 };
          }
          const headers = buildHeaders([rawHeaders]);
          if (
            // Pass raw type verbatim
            ArrayBuffer.isView(body) || body instanceof ArrayBuffer || body instanceof DataView || typeof body === "string" && // Preserve legacy string encoding behavior for now
            headers.values.has("content-type") || // `Blob` is superset of `File`
            globalThis.Blob && body instanceof globalThis.Blob || // `FormData` -> `multipart/form-data`
            body instanceof FormData || // `URLSearchParams` -> `application/x-www-form-urlencoded`
            body instanceof URLSearchParams || // Send chunked stream (each chunk has own `length`)
            globalThis.ReadableStream && body instanceof globalThis.ReadableStream
          ) {
            return { bodyHeaders: void 0, body };
          } else if (this.isStreamBody(body)) {
            return { bodyHeaders: void 0, body: ReadableStreamFrom(body) };
          } else if (typeof body === "object" && headers.values.get("content-type") === "application/x-www-form-urlencoded") {
            return {
              bodyHeaders: { "content-type": "application/x-www-form-urlencoded" },
              body: this.stringifyQuery(body)
            };
          } else {
            return __classPrivateFieldGet(this, _BaseAnthropic_encoder, "f").call(this, { body, headers });
          }
        }
        /**
         * Whether `body` is sent as a stream, which can be read only once:
         * a `ReadableStream`, an async iterable or an iterator.
         */
        isStreamBody(body) {
          if (globalThis.ReadableStream && body instanceof globalThis.ReadableStream) {
            return true;
          }
          return typeof body === "object" && body !== null && (Symbol.asyncIterator in body || Symbol.iterator in body && "next" in body && typeof body.next === "function");
        }
      }
      _a = BaseAnthropic2, _BaseAnthropic_encoder = /* @__PURE__ */ new WeakMap(), _BaseAnthropic_instances = /* @__PURE__ */ new WeakSet(), _BaseAnthropic_baseURLOverridden = function _BaseAnthropic_baseURLOverridden2() {
        return this.baseURL !== "https://api.anthropic.com";
      };
      BaseAnthropic2.Anthropic = _a;
      BaseAnthropic2.DEFAULT_TIMEOUT = 6e5;
      BaseAnthropic2.AnthropicError = AnthropicError;
      BaseAnthropic2.APIError = APIError;
      BaseAnthropic2.APIConnectionError = APIConnectionError;
      BaseAnthropic2.APIConnectionTimeoutError = APIConnectionTimeoutError;
      BaseAnthropic2.APIUserAbortError = APIUserAbortError;
      BaseAnthropic2.NotFoundError = NotFoundError;
      BaseAnthropic2.ConflictError = ConflictError;
      BaseAnthropic2.RateLimitError = RateLimitError;
      BaseAnthropic2.BadRequestError = BadRequestError;
      BaseAnthropic2.AuthenticationError = AuthenticationError;
      BaseAnthropic2.InternalServerError = InternalServerError;
      BaseAnthropic2.PermissionDeniedError = PermissionDeniedError;
      BaseAnthropic2.UnprocessableEntityError = UnprocessableEntityError;
      BaseAnthropic2.toFile = toFile;
      BaseAnthropic2.HUMAN_PROMPT = HUMAN_PROMPT;
      BaseAnthropic2.AI_PROMPT = AI_PROMPT;
      return BaseAnthropic2;
    })();
    Anthropic = /* @__PURE__ */ (() => {
      class Anthropic2 extends BaseAnthropic {
        constructor() {
          super(...arguments);
          this.completions = new Completions(this);
          this.messages = new Messages2(this);
          this.models = new Models2(this);
          this.files = new Files2(this);
          this.skills = new Skills2(this);
          this.beta = new Beta(this);
        }
      }
      Anthropic2.Completions = Completions;
      Anthropic2.Messages = Messages2;
      Anthropic2.Models = Models2;
      Anthropic2.Files = Files2;
      Anthropic2.Skills = Skills2;
      Anthropic2.Beta = Beta;
      return Anthropic2;
    })();
  }
});

// node_modules/@anthropic-ai/sdk/index.mjs
var init_sdk = __esm({
  "node_modules/@anthropic-ai/sdk/index.mjs"() {
    init_client();
  }
});

// server/claude-account.js
var claude_account_exports = {};
__export(claude_account_exports, {
  API_URL: () => API_URL,
  DEFAULT_MODEL: () => DEFAULT_MODEL,
  apiKey: () => apiKey,
  checkKey: () => checkKey,
  clearKey: () => clearKey,
  client: () => client,
  costOf: () => costOf,
  explain: () => explain,
  keySource: () => keySource,
  modelInfo: () => modelInfo,
  models: () => models,
  publicAccount: () => publicAccount,
  rateLimits: () => rateLimits,
  setKey: () => setKey,
  setSettings: () => setSettings,
  settings: () => settings,
  supportsSystemMessages: () => supportsSystemMessages,
  thinkingFor: () => thinkingFor,
  webTools: () => webTools
});
import fs6 from "node:fs";
import path5 from "node:path";
function baseURL() {
  const u = process.env.AGENT_HUB_CLAUDE_TEST_URL;
  return u && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(u) ? u : API_URL;
}
function checkKey(key) {
  const k = String(key || "").trim();
  if (!k) return "\u8ACB\u8CBC\u4E0A API key";
  if (/^sk-ant-o(at|rt)/i.test(k)) return "\u9019\u662F Claude Code\uFF0FClaude \u8A02\u95B1\u5E33\u865F\u7684\u767B\u5165 token\uFF0C\u4E0D\u662F API key\u3002\u4E2D\u63A7\u53F0\u53EA\u7528 Claude Console \u7684 API key\uFF1A\u5230 console.anthropic.com \u2192 API Keys \u5EFA\u7ACB\u4E00\u628A\uFF08sk-ant- \u958B\u982D\uFF09\u3002";
  if (/^sk-ant-admin/i.test(k)) return "\u9019\u662F Admin API key\uFF0C\u4E0D\u80FD\u62FF\u4F86\u5C0D\u8A71\u3002\u8ACB\u5728 Claude Console \u5EFA\u7ACB\u4E00\u822C\u7684 API key\uFF08sk-ant- \u958B\u982D\uFF09\u3002";
  if (!/^sk-ant-[a-z]+\d*-[\w-]{20,}$/i.test(k)) return "\u9019\u4E0D\u662F Claude Console \u7684 API key\uFF08\u61C9\u8A72\u662F sk-ant- \u958B\u982D\u7684\u4E00\u9577\u4E32\uFF09\u3002";
  return null;
}
function load() {
  try {
    const j = JSON.parse(fs6.readFileSync(FILE, "utf8"));
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}
function save() {
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs6.writeFileSync(tmp, JSON.stringify(saved, null, 2), { mode: 384 });
  fs6.renameSync(tmp, FILE);
}
function setKey(key) {
  const k = String(key || "").trim();
  const why = checkKey(k);
  if (why) throw Object.assign(new Error(why), { status: 400 });
  saved.apiKey = k;
  save();
  modelCache = null;
}
function clearKey() {
  delete saved.apiKey;
  save();
  modelCache = null;
}
function client(key = apiKey()) {
  if (!key) throw Object.assign(new Error("\u9084\u6C92\u6709\u8A2D\u5B9A Claude API key\u3002\u5728\u300C\u8A2D\u5B9A\u300D\u2192\u300CClaude API\u2026\u300D\u8CBC\u4E0A Claude Console \u7684 API key\u3002"), { status: 409, code: "no_key" });
  return new Anthropic({
    apiKey: key,
    authToken: null,
    baseURL: baseURL(),
    maxRetries: 3,
    timeout: 20 * 6e4,
    defaultHeaders: { "X-Api-Key": key, Authorization: null }
  });
}
function settings() {
  const d = saved.defaults || {};
  return {
    defaults: {
      model: typeof d.model === "string" && d.model ? d.model : DEFAULT_MODEL,
      effort: EFFORTS.includes(d.effort) ? d.effort : "high",
      permission: PERMISSIONS.includes(d.permission) ? d.permission : "manual",
      planMode: Boolean(d.planMode)
    },
    webTools: saved.webTools !== false
  };
}
function setSettings({ defaults: defaults2, webTools: webTools2 } = {}) {
  if (defaults2 && typeof defaults2 === "object") {
    const d = { ...saved.defaults || {} };
    if (typeof defaults2.model === "string" && defaults2.model.length <= 100) d.model = defaults2.model;
    if (EFFORTS.includes(defaults2.effort)) d.effort = defaults2.effort;
    if (PERMISSIONS.includes(defaults2.permission)) d.permission = defaults2.permission;
    if ("planMode" in defaults2) d.planMode = Boolean(defaults2.planMode);
    saved.defaults = d;
  }
  if (typeof webTools2 === "boolean") saved.webTools = webTools2;
  save();
}
function publicAccount() {
  const key = apiKey();
  return { hasKey: Boolean(key), keySource: keySource(), keyHint: masked(key), apiUrl: API_URL, ...settings() };
}
function info(id, live2) {
  const k = known(id);
  const caps = live2?.capabilities || {};
  let efforts = k?.efforts;
  if (!efforts && caps.effort?.supported) efforts = FIVE.filter((e) => caps.effort[e]?.supported);
  const adaptive = k ? !k.budget : Boolean(caps.thinking?.types?.adaptive?.supported);
  efforts = k?.budget ? ["off", "on"] : [...k?.off ? ["off"] : [], ...efforts || []];
  return {
    id,
    name: live2?.display_name || k?.name || id,
    efforts,
    defaultEffort: k?.budget ? "off" : k?.def || (efforts.includes("high") ? "high" : efforts[0] || null),
    image: caps.image_input ? Boolean(caps.image_input.supported) : true,
    context: live2?.max_input_tokens || k?.context || 2e5,
    maxOut: live2?.max_tokens || k?.maxOut || 64e3,
    adaptive,
    priced: Boolean(k?.price)
  };
}
async function models({ fresh = false } = {}) {
  if (!fresh && modelCache && Date.now() - modelCache.at < 10 * 6e4) return modelCache.models;
  let list = null;
  if (apiKey()) {
    try {
      const out2 = [];
      for await (const m of client().models.list({ limit: 100 })) out2.push(m);
      list = out2;
    } catch (err) {
      if (fresh) throw err;
    }
  }
  const ids = list ? list.map((m) => m.id) : KNOWN.map((m) => m.id);
  const byId = new Map((list || []).map((m) => [m.id, m]));
  const out = ids.filter((id) => /^claude-/.test(id)).map((id) => info(id, byId.get(id))).sort((a, b) => (known(a.id)?.order ?? 99) - (known(b.id)?.order ?? 99));
  if (list) modelCache = { at: Date.now(), models: out };
  return out;
}
function modelInfo(id) {
  return modelCache?.models.find((m) => m.id === id) || info(id, null);
}
function thinkingFor(model, effort) {
  const k = known(model);
  const m = modelInfo(model);
  if (k?.budget) return effort === "on" ? { thinking: { type: "enabled", budget_tokens: 16e3 } } : {};
  const efforts = m.efforts || [];
  if (effort === "off" && efforts.includes("off")) return { thinking: { type: k?.off || "disabled" } };
  const e = efforts.includes(effort) && effort !== "off" ? effort : m.defaultEffort && m.defaultEffort !== "off" ? m.defaultEffort : null;
  const out = {};
  if (m.adaptive) out.thinking = k?.summarized ? { type: "adaptive" } : { type: "adaptive", display: "summarized" };
  if (e && efforts.length) out.output_config = { effort: e };
  return out;
}
function webTools(model) {
  if (known(model)?.web) {
    return [
      { type: "web_search_20260209", name: "web_search", max_uses: 8 },
      { type: "web_fetch_20260209", name: "web_fetch", max_uses: 8 }
    ];
  }
  return [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }];
}
function costOf(model, usage = {}) {
  const k = known(model);
  if (!k?.price) return null;
  const input = usage.input_tokens || 0;
  const write = usage.cache_creation_input_tokens || 0;
  const read2 = usage.cache_read_input_tokens || 0;
  const [pin, pout, pread] = k.longPrice && input + write + read2 > 1e5 ? k.longPrice : k.price;
  const searches = usage.server_tool_use?.web_search_requests || 0;
  return (input * pin + write * pin * 1.25 + read2 * pread + (usage.output_tokens || 0) * pout) / 1e6 + searches * 0.01;
}
function rateLimits(headers) {
  if (!headers?.get) return null;
  const out = {};
  for (const kind of ["requests", "tokens", "input-tokens", "output-tokens"]) {
    const limit2 = headers.get(`anthropic-ratelimit-${kind}-limit`);
    if (limit2 == null) continue;
    out[kind] = { limit: Number(limit2), remaining: Number(headers.get(`anthropic-ratelimit-${kind}-remaining`)), reset: headers.get(`anthropic-ratelimit-${kind}-reset`) || null };
  }
  return Object.keys(out).length ? { ...out, at: Date.now() } : null;
}
function explain(err) {
  const status = err?.status;
  const msg = err?.error?.error?.message || err?.message || String(err);
  if (status === 401) return "Claude API key \u7121\u6548\u6216\u5DF2\u88AB\u64A4\u92B7\u3002\u5230\u300C\u8A2D\u5B9A\u300D\u2192\u300CClaude API\u2026\u300D\u63DB\u4E00\u628A Claude Console \u7684 API key\u3002";
  if (status === 403) return `\u9019\u628A API key \u6C92\u6709\u6B0A\u9650\uFF1A${msg}`;
  if (status === 404) return `\u627E\u4E0D\u5230\u9019\u500B\u6A21\u578B\uFF0C\u6216\u9019\u628A API key \u4E0D\u80FD\u7528\u5B83\uFF1A${msg}`;
  if (status === 429) return `\u9054\u5230 Claude API \u7684\u901F\u7387\u9650\u5236\uFF08\u91CD\u8A66\u5F8C\u4ECD\u7136\u5931\u6557\uFF09\u3002\u7A0D\u7B49\u4E00\u4E0B\u518D\u8A66\uFF0C\u6216\u5230 Claude Console \u67E5\u770B\u9650\u5236\u3002${msg ? `
${msg}` : ""}`;
  if (status === 529 || /overloaded/i.test(msg)) return "Anthropic \u7684\u4F3A\u670D\u5668\u76EE\u524D\u5FD9\u788C\uFF08overloaded\uFF09\uFF0C\u8ACB\u7A0D\u5F8C\u518D\u8A66\u3002";
  if (/credit balance/i.test(msg)) return "Claude Console \u5E33\u6236\u7684\u984D\u5EA6\u4E0D\u8DB3\u3002\u5230 console.anthropic.com \u2192 Billing \u5132\u503C\u5F8C\u518D\u8A66\u3002";
  if (status === 400) return `Claude API \u62D2\u7D55\u4E86\u9019\u500B\u8ACB\u6C42\uFF1A${msg}`;
  if (status >= 500) return `Anthropic \u7684\u4F3A\u670D\u5668\u767C\u751F\u932F\u8AA4\uFF08${status}\uFF09\uFF0C\u8ACB\u7A0D\u5F8C\u518D\u8A66\u3002`;
  if (err?.name === "APIConnectionError" || /fetch failed|ENOTFOUND|ECONNRE/i.test(msg)) return `\u9023\u4E0D\u4E0A api.anthropic.com\uFF1A${msg}`;
  return msg;
}
var FILE, API_URL, DEFAULT_MODEL, saved, envKey, apiKey, keySource, masked, EFFORTS, PERMISSIONS, FIVE, KNOWN, known, modelCache, supportsSystemMessages;
var init_claude_account = __esm({
  "server/claude-account.js"() {
    init_sdk();
    init_store();
    FILE = path5.join(DATA_DIR, "claude.json");
    API_URL = "https://api.anthropic.com";
    DEFAULT_MODEL = "claude-opus-5-5";
    saved = load();
    envKey = () => {
      const k = String(process.env.ANTHROPIC_API_KEY || "").trim();
      return k && !checkKey(k) ? k : "";
    };
    apiKey = () => saved.apiKey || envKey();
    keySource = () => saved.apiKey ? "hub" : envKey() ? "env" : null;
    masked = (k) => k ? `${k.split("-").slice(0, 3).join("-")}\u2026${k.slice(-4)}` : "";
    EFFORTS = ["off", "on", "low", "medium", "high", "xhigh", "max"];
    PERMISSIONS = ["manual", "edits", "auto"];
    FIVE = ["low", "medium", "high", "xhigh", "max"];
    KNOWN = [
      ["claude-opus-5-5", "Claude Opus 5.5", { price: [4, 20, 0.2], efforts: FIVE, def: "medium", sys: true, web: true }],
      ["claude-fable-5-1", "Claude Fable 5.1", { price: [10, 50, 0.25], efforts: FIVE, def: "high", sys: true }],
      ["claude-sonnet-5-5", "Claude Sonnet 5.5", { price: [2, 10, 0.2], efforts: FIVE, def: "high", off: "between_tools", sys: true, web: true }],
      ["claude-haiku-5-5", "Claude Haiku 5.5", { price: [0.1, 0.5, 0.01], longPrice: [0.5, 2.5, 0.05], efforts: FIVE, def: "medium", off: "disabled", sys: true }],
      ["claude-opus-5", "Claude Opus 5", { price: [5, 25, 0.5], efforts: FIVE, def: "high", off: "disabled", sys: true, web: true }],
      ["claude-fable-5", "Claude Fable 5", { price: [10, 50, 1], efforts: FIVE, def: "high", sys: true }],
      ["claude-sonnet-5", "Claude Sonnet 5", { price: [2, 10, 0.2], efforts: FIVE, def: "high", off: "disabled", web: true }],
      ["claude-opus-4-8", "Claude Opus 4.8", { price: [5, 25, 0.5], efforts: FIVE, def: "high", off: "disabled", sys: true, web: true }],
      ["claude-opus-4-7", "Claude Opus 4.7", { price: [5, 25, 0.5], efforts: FIVE, def: "high", off: "disabled", web: true }],
      ["claude-opus-4-6", "Claude Opus 4.6", { price: [5, 25, 0.5], efforts: ["low", "medium", "high", "max"], def: "high", off: "disabled", web: true, summarized: true }],
      ["claude-sonnet-4-6", "Claude Sonnet 4.6", { price: [3, 15, 0.3], efforts: ["low", "medium", "high", "max"], def: "high", off: "disabled", web: true, summarized: true }],
      ["claude-haiku-4-5", "Claude Haiku 4.5", { price: [1, 5, 0.1], budget: true, context: 2e5, maxOut: 64e3 }]
    ].map(([id, name, x], order) => ({ id, name, order, context: 1e6, maxOut: 128e3, ...x }));
    known = (id) => KNOWN.find((m) => m.id === id) || null;
    modelCache = null;
    supportsSystemMessages = (model) => Boolean(known(model)?.sys);
  }
});

// server/machines.js
import fs7 from "node:fs";
import path6 from "node:path";
import crypto4 from "node:crypto";
function getMachine(id) {
  return machines.get(id);
}
function rpc(machineId, op, args = {}, timeoutMs = 6e4) {
  const m = machines.get(machineId);
  if (!m) return Promise.reject(Object.assign(new Error("\u627E\u4E0D\u5230\u9019\u53F0\u6A5F\u5668"), { status: 404 }));
  if (!m.online || !m.ws) return Promise.reject(Object.assign(new Error(`\u6A5F\u5668\u300C${m.name}\u300D\u76EE\u524D\u96E2\u7DDA\uFF1A\u8ACB\u5728\u90A3\u53F0\u6A5F\u5668\u4E0A\u57F7\u884C\u9023\u63A5\u5668`), { status: 409 }));
  const id = crypto4.randomBytes(6).toString("hex");
  return new Promise((resolve2, reject) => {
    const timer = setTimeout(() => {
      m.pending.delete(id);
      reject(new Error(`\u6A5F\u5668\u300C${m.name}\u300D\u6C92\u6709\u5728\u6642\u9593\u5167\u56DE\u61C9`));
    }, timeoutMs);
    m.pending.set(id, { resolve: resolve2, reject, timer });
    m.ws.send(JSON.stringify({ t: "req", id, op, args }));
  });
}
async function rpcStream(machineId, op, args, onData, timeoutMs) {
  if (onData) streams.set(args.id, onData);
  try {
    return await rpc(machineId, op, args, timeoutMs);
  } finally {
    streams.delete(args.id);
  }
}
function tooOld(err, m) {
  if (/未知的操作/.test(err?.message || "")) return Object.assign(new Error(`\u300C${m?.name || "\u9019\u53F0\u96FB\u8166"}\u300D\u7684\u9023\u63A5\u5668\u592A\u820A\uFF0C\u4E0D\u652F\u63F4 Claude\u3002\u5728\u90A3\u53F0\u96FB\u8166\u91CD\u65B0\u57F7\u884C\u9023\u63A5\u6307\u4EE4\uFF08\u5DE6\u4E0B\u89D2\u300C\u9023\u63A5\u96FB\u8166\u2026\u300D\uFF09\u5F8C\u518D\u8A66\u3002`), { status: 409 });
  return err;
}
var FILE2, machines, streams;
var init_machines = __esm({
  "server/machines.js"() {
    init_store();
    FILE2 = path6.join(DATA_DIR, "machines.json");
    machines = /* @__PURE__ */ new Map();
    streams = /* @__PURE__ */ new Map();
    try {
      for (const m of JSON.parse(fs7.readFileSync(FILE2, "utf8"))) machines.set(m.id, { ...m, online: false, ws: null, pending: /* @__PURE__ */ new Map() });
    } catch {
    }
  }
});

// server/tools.js
import fssync2 from "node:fs";
import path7 from "node:path";
import { spawn as spawn2 } from "node:child_process";
function resolveInWorkspace(cwd, p = ".") {
  const root = fssync2.realpathSync(cwd);
  const target = path7.resolve(root, p);
  let probe = target;
  while (!fssync2.existsSync(probe)) probe = path7.dirname(probe);
  const real = path7.join(fssync2.realpathSync(probe), path7.relative(probe, target));
  for (const candidate of [target, real]) {
    const rel = path7.relative(root, candidate);
    if (rel === ".." || rel.startsWith(`..${path7.sep}`) || path7.isAbsolute(rel)) {
      throw new Error(`path "${p}" is outside the workspace`);
    }
  }
  return target;
}
function truncate(text, max = MAX_OUTPUT) {
  if (text.length <= max) return text;
  const head = text.slice(0, max * 0.6);
  const tail = text.slice(-max * 0.4);
  return `${head}

\u2026 [${text.length - head.length - tail.length} characters truncated] \u2026

${tail}`;
}
function runCommand(command2, { cwd, signal, timeoutMs = 12e4, onData } = {}) {
  timeoutMs = Math.min(Math.max(timeoutMs || 12e4, 1e3), 6e5);
  return new Promise((resolve2) => {
    const child = spawn2("bash", ["-c", command2], {
      cwd,
      detached: true,
      env: { ...process.env, TERM: "dumb", CI: process.env.CI ?? "1", GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    let killedBy = null;
    const kill = (why) => {
      killedBy = why;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
      }
    };
    const timer = setTimeout(() => kill("timeout"), timeoutMs);
    const onAbort = () => kill("interrupted");
    signal?.addEventListener("abort", onAbort, { once: true });
    const collect = (chunk) => {
      const s = chunk.toString();
      if (out.length < MAX_OUTPUT * 4) out += s;
      onData?.(s);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve2({ output: String(err.message), exitCode: -1, isError: true });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      let output = truncate(out.trimEnd());
      if (killedBy === "timeout") output += `
[command timed out after ${timeoutMs} ms]`;
      if (killedBy === "interrupted") output += "\n[interrupted by user]";
      resolve2({ output: output || "(no output)", exitCode: code ?? -1, isError: code !== 0 });
    });
  });
}
var MAX_OUTPUT;
var init_tools = __esm({
  "server/tools.js"() {
    MAX_OUTPUT = 3e4;
  }
});

// server/adapters/claude-tools.js
import fs8 from "node:fs/promises";
import fssync3 from "node:fs";
import path8 from "node:path";
import crypto5 from "node:crypto";
function validate(name, input) {
  const def = byName.get(name);
  if (!def) return `unknown tool "${name}"`;
  return check(def.input_schema, input, "input");
}
function check(schema, value, where) {
  const t = schema.type;
  if (t === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return `${where} must be an object`;
    for (const k of schema.required || []) if (value[k] === void 0 || value[k] === null) return `${where}.${k} is missing`;
    for (const [k, v] of Object.entries(value)) {
      const p = schema.properties?.[k];
      if (!p || v === void 0 || v === null) continue;
      const e = check(p, v, `${where}.${k}`);
      if (e) return e;
    }
    return null;
  }
  if (t === "array") {
    if (!Array.isArray(value)) return `${where} must be an array`;
    for (let i = 0; i < value.length; i++) {
      const e = schema.items && check(schema.items, value[i], `${where}[${i}]`);
      if (e) return e;
    }
    return null;
  }
  if (t === "string") {
    if (typeof value !== "string") return `${where} must be a string`;
    if (schema.enum && !schema.enum.includes(value)) return `${where} must be one of ${schema.enum.join(", ")}`;
    return null;
  }
  if (t === "integer" || t === "number") return typeof value === "number" && Number.isFinite(value) ? null : `${where} must be a number`;
  if (t === "boolean") return typeof value === "boolean" ? null : `${where} must be true or false`;
  return null;
}
function titleOf(name, input = {}, cwd = "") {
  const rel = (p) => cwd && typeof p === "string" && p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p;
  switch (name) {
    case "Bash":
      return String(input.command || "").split("\n")[0];
    case "Read":
    case "Write":
    case "Edit":
      return rel(input.file_path) || "";
    case "Glob":
    case "Grep":
      return `${input.pattern || ""}${input.path ? ` in ${rel(input.path)}` : ""}`;
    case "Task":
      return input.description || "";
    case "AskUserQuestion":
      return input.questions?.[0]?.question || "Claude \u6709\u554F\u984C\u8981\u554F\u4F60";
    case "ExitPlanMode":
      return "\u8A08\u756B";
    case "WebSearch":
      return input.query || "";
    case "WebFetch":
      return input.url || "";
    default:
      return "";
  }
}
function truncate2(text, max = MAX_OUTPUT2) {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.6));
  const tail = text.slice(-Math.floor(max * 0.4));
  return `${head}

\u2026 [${text.length - head.length - tail.length} characters cut] \u2026

${tail}`;
}
function remoteHost(machineId) {
  const call = (op, args, timeoutMs) => rpc(machineId, op, args, timeoutMs).catch((err) => Promise.reject(tooOld(err, getMachine(machineId))));
  return {
    name: machineId,
    stat: (cwd, p) => call("fs.stat", { cwd, path: p || "." }),
    async read(cwd, p) {
      const r = await call("fs.read", { cwd, path: p }, 12e4);
      return { ...r, buf: Buffer.from(r.data, "base64") };
    },
    write: (cwd, p, content) => call("fs.write", { cwd, path: p, content }, 12e4),
    walk: (cwd, p, limit2 = 2e3) => call("fs.walk", { cwd, path: p || ".", limit: limit2 }),
    async run(cwd, command2, { signal, timeoutMs, onData } = {}) {
      const id = crypto5.randomBytes(6).toString("hex");
      const ms = Math.min(Math.max(Number(timeoutMs) || 12e4, 1e3), 6e5);
      const stop = () => rpc(machineId, "sh.kill", { id }).catch(() => {
      });
      signal?.addEventListener("abort", stop, { once: true });
      try {
        const r = await rpcStream(machineId, "sh.run", { cwd, command: command2, timeoutMs: ms, id }, onData, ms + 3e4).catch((err) => Promise.reject(tooOld(err, getMachine(machineId))));
        let output = truncate2(String(r.output || "").trimEnd());
        if (r.killedBy === "timeout") output += `
[command timed out after ${ms} ms]`;
        if (r.killedBy === "interrupted") output += "\n[interrupted by user]";
        return { output: output || "(no output)", exitCode: r.exitCode };
      } finally {
        signal?.removeEventListener("abort", stop);
      }
    }
  };
}
async function execute(name, input, { host = localHost, cwd, signal, onData } = {}) {
  try {
    switch (name) {
      case "Bash": {
        const r = await host.run(cwd, input.command, { signal, timeoutMs: input.timeout, onData });
        return { content: `${r.output}
[exit code ${r.exitCode}]`, output: r.output, isError: r.exitCode !== 0 };
      }
      case "Read":
        return await read(host, cwd, input);
      case "Write": {
        const r = await host.write(cwd, input.file_path, input.content);
        const text = `${r.existed ? "Updated" : "Created"} ${r.rel} (${input.content.split("\n").length} lines)`;
        return { content: text, output: text, isError: false };
      }
      case "Edit": {
        const st2 = await host.stat(cwd, input.file_path);
        if (!st2.exists) return fail(`File does not exist: ${input.file_path}. Use Write to create it.`);
        if (input.old_string === input.new_string) return fail("old_string and new_string are the same; nothing to change.");
        const text = (await host.read(cwd, input.file_path)).buf.toString("utf8");
        const count2 = input.old_string ? text.split(input.old_string).length - 1 : 0;
        if (!count2) return fail("old_string was not found in the file. Read the file again and copy the exact text, whitespace included.");
        if (count2 > 1 && !input.replace_all) return fail(`old_string occurs ${count2} times. Include more surrounding lines to make it unique, or set replace_all.`);
        const next2 = input.replace_all ? text.split(input.old_string).join(input.new_string) : text.replace(input.old_string, () => input.new_string);
        await host.write(cwd, input.file_path, next2);
        const msg = `Edited ${st2.rel} (${input.replace_all ? `${count2} replacements` : "1 replacement"})`;
        return { content: msg, output: msg, isError: false };
      }
      case "Glob":
        return await glob2(host, cwd, input);
      case "Grep":
        return await grep(host, cwd, input, signal);
      default:
        return fail(`Unknown tool "${name}"`);
    }
  } catch (err) {
    return fail(err.message || String(err));
  }
}
async function read(host, cwd, input) {
  const type = IMAGE_TYPES[path8.extname(String(input.file_path)).toLowerCase()];
  const f = await host.read(cwd, input.file_path);
  if (type) {
    if (f.size > 375e4) return fail(`The image is too large to read (${Math.round(f.size / 1024)} KB, the limit is about 3.7 MB).`);
    return { content: [{ type: "image", source: { type: "base64", media_type: type, data: f.buf.toString("base64") } }], output: `\uFF08\u5716\u7247\uFF0C${Math.round(f.size / 1024)} KB\uFF09`, isError: false };
  }
  if (f.buf.subarray(0, 8e3).includes(0)) return fail(`${input.file_path} is a binary file (${f.size} bytes).`);
  const all = f.buf.toString("utf8").split("\n");
  if (all.length > 1 && all.at(-1) === "") all.pop();
  const start = Math.max((input.offset ?? 1) - 1, 0);
  const slice = all.slice(start, start + Math.max(1, input.limit ?? MAX_READ_LINES));
  let text = slice.map((l, i) => `${String(start + i + 1).padStart(6)}	${l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}\u2026 [line cut]` : l}`).join("\n");
  if (!all.length || all.length === 1 && !all[0]) text = "(the file is empty)";
  const rest = all.length - start - slice.length;
  if (rest > 0) text += `
\u2026 ${rest} more lines (read on with offset ${start + slice.length + 1})`;
  return { content: truncate2(text, 1e5), output: text, isError: false };
}
function globToRegExp(pattern) {
  let re = "";
  let i = 0;
  const p = pattern.replace(/^\.\//, "");
  while (i < p.length) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        const slash = p[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 3 : 2;
        continue;
      }
      re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = p.indexOf("}", i);
      if (end === -1) re += "\\{";
      else {
        re += `(?:${p.slice(i + 1, end).split(",").map((x) => x.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")).join("|")})`;
        i = end;
      }
    } else if (c === "[") {
      const end = p.indexOf("]", i + 1);
      if (end === -1) re += "\\[";
      else {
        re += `[${p.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else re += c.replace(/[.+^$()|\\/]/g, "\\$&");
    i++;
  }
  return new RegExp(`^${re}$`);
}
async function glob2(host, cwd, input) {
  const re = globToRegExp(input.pattern);
  const { rel, files } = await host.walk(cwd, input.path, 2e4);
  const hits = files.filter(([r]) => re.test(r)).sort((a, b) => b[1] - a[1]);
  const list = hits.slice(0, 200).map(([r]) => rel === "." ? r : `${rel}/${r}`);
  const more = hits.length > 200 ? `
\u2026 and ${hits.length - 200} more (narrow the pattern)` : "";
  const text = list.length ? list.join("\n") + more : "No files found.";
  return { content: text, output: list.length ? text : "", isError: false };
}
async function grep(host, cwd, input, signal) {
  const where = (await host.stat(cwd, input.path)).rel;
  const mode = input.output_mode || "files_with_matches";
  const ctx = mode === "content" && input.context ? Math.min(input.context, 20) : 0;
  const rg = ["rg --color never --no-heading -M 400 --glob '!.git' --glob '!node_modules'", mode === "files_with_matches" ? "-l" : mode === "count" ? "-c" : "-n", ctx ? `-C ${ctx}` : "", input.case_insensitive ? "-i" : "", input.glob ? `--glob ${q(input.glob)}` : "", `-e ${q(input.pattern)} -- ${q(where)}`];
  const gr = ["grep -rEI --exclude-dir=.git --exclude-dir=node_modules", mode === "files_with_matches" ? "-l" : mode === "count" ? "-c" : "-n", ctx ? `-C ${ctx}` : "", input.case_insensitive ? "-i" : "", input.glob ? `--include=${q(input.glob)}` : "", `-e ${q(input.pattern)} -- ${q(where)}`];
  const cmd = `if command -v rg >/dev/null 2>&1; then ${rg.filter(Boolean).join(" ")}; else ${gr.filter(Boolean).join(" ")}; fi`;
  const r = await host.run(cwd, cmd, { signal, timeoutMs: 3e4 });
  if (r.exitCode > 1 || r.exitCode === -1) return fail(`Search failed: ${r.output.trim() || `exit ${r.exitCode}`}`);
  let lines = r.output === "(no output)" ? [] : r.output.split("\n").filter(Boolean);
  if (mode === "count") lines = lines.filter((l) => !/:0$/.test(l));
  const shown = lines.slice(0, 250).map((l) => l.replace(/^\.\//, ""));
  const more = lines.length > 250 ? `
\u2026 ${lines.length - 250} more lines (narrow the search)` : "";
  const text = shown.length ? truncate2(shown.join("\n") + more) : "No matches.";
  return { content: text, output: shown.length ? text : "", isError: false };
}
var MAX_OUTPUT2, MAX_READ_LINES, MAX_LINE, IGNORED, IMAGE_TYPES, str, int, FILE_PATH, TOOLS, byName, toolKind, apiTools, localHost, fail, q;
var init_claude_tools = __esm({
  "server/adapters/claude-tools.js"() {
    init_tools();
    init_machines();
    MAX_OUTPUT2 = 3e4;
    MAX_READ_LINES = 2e3;
    MAX_LINE = 2e3;
    IGNORED = /* @__PURE__ */ new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".next", ".cache", "dist", "build", ".turbo"]);
    IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
    str = (description) => ({ type: "string", description });
    int = (description) => ({ type: "integer", description });
    FILE_PATH = str("Path of the file: absolute (inside the working directory) or relative to it.");
    TOOLS = [
      {
        name: "Bash",
        kind: "exec",
        description: "Run a shell command with bash in the working directory; returns its combined stdout/stderr and exit code. Use it for builds, tests, git, package managers and other terminal work. Each call starts a fresh shell in the working directory, so `cd` does not carry over: chain with && instead. Prefer Read, Grep and Glob for looking at files. Output beyond about 30,000 characters is cut in the middle. A command that never exits (a server, a watcher) blocks until the timeout: start those in the background (`nohup \u2026 > log 2>&1 &`).",
        input_schema: {
          type: "object",
          properties: {
            command: str("The command to run."),
            description: str("What the command does, in 5\u201310 words, shown to the user."),
            timeout: int("Timeout in milliseconds (default 120000, at most 600000).")
          },
          required: ["command"]
        }
      },
      {
        name: "Read",
        kind: "read",
        description: "Read a file. Returns its lines numbered like `cat -n`, up to 2000 lines from `offset`; read large files in parts with offset and limit. Images (PNG, JPEG, GIF, WebP) come back as the image itself. Read a file before you edit it.",
        input_schema: {
          type: "object",
          properties: { file_path: FILE_PATH, offset: int("Line number to start from (1-based)."), limit: int("How many lines to read (default 2000).") },
          required: ["file_path"]
        }
      },
      {
        name: "Write",
        kind: "edit",
        description: "Create a file, or replace a file's entire content; parent folders are created. To change part of an existing file use Edit instead, and Read a file before overwriting it. HTML files you write are shown to the user live in a side panel, so a page is a good way to present a report, a chart or a prototype.",
        input_schema: { type: "object", properties: { file_path: FILE_PATH, content: str("The complete content of the file.") }, required: ["file_path", "content"] }
      },
      {
        name: "Edit",
        kind: "edit",
        description: "Replace exact text in a file. old_string must match the file exactly, whitespace and indentation included, and occur exactly once unless replace_all is true: include enough surrounding lines to make it unique. Read the file first. Use one Edit per place you change.",
        input_schema: {
          type: "object",
          properties: {
            file_path: FILE_PATH,
            old_string: str("The exact text to replace."),
            new_string: str("The text to put in its place."),
            replace_all: { type: "boolean", description: "Replace every occurrence of old_string." }
          },
          required: ["file_path", "old_string", "new_string"]
        }
      },
      {
        name: "Glob",
        kind: "read",
        description: "Find files by path pattern, such as `**/*.ts` or `src/**/test_*.py`. Returns the matching paths, most recently modified first (at most 200). Skips .git, node_modules and similar folders.",
        input_schema: { type: "object", properties: { pattern: str("Glob pattern, relative to `path`."), path: str("Directory to search in (default: the working directory).") }, required: ["pattern"] }
      },
      {
        name: "Grep",
        kind: "read",
        description: "Search file contents with a regular expression (ripgrep syntax). output_mode 'files_with_matches' (default) lists the files that match, 'content' shows matching lines as path:line:text, 'count' counts matches per file. Narrow it with `glob` (e.g. '*.js') or `path`.",
        input_schema: {
          type: "object",
          properties: {
            pattern: str("Regular expression to search for."),
            path: str("File or directory to search (default: the working directory)."),
            glob: str('Only search files matching this glob, e.g. "*.py".'),
            output_mode: { type: "string", enum: ["files_with_matches", "content", "count"], description: "What to return (default files_with_matches)." },
            case_insensitive: { type: "boolean", description: "Ignore case." },
            context: int("Lines of context around each match ('content' mode).")
          },
          required: ["pattern"]
        }
      },
      {
        name: "TodoWrite",
        kind: "todo",
        description: "Create or update your todo list for the current task; the user sees it beside the conversation. Use it for work with three or more steps: list the steps, keep exactly one in_progress while you work on it, and mark each completed as soon as it is done. Send the whole list every time.",
        input_schema: {
          type: "object",
          properties: {
            todos: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  content: str('The step, as an imperative ("Run the tests").'),
                  status: { type: "string", enum: ["pending", "in_progress", "completed"] },
                  activeForm: str('The step as it is being done ("Running the tests").')
                },
                required: ["content", "status"]
              }
            }
          },
          required: ["todos"]
        }
      },
      {
        name: "AskUserQuestion",
        kind: "ask",
        description: "Ask the user one to four multiple-choice questions and wait for the answers. Use it when you need a decision you should not guess: a requirement, a preference, a trade-off between approaches. Give each question two to four options; the user can also type an answer of their own.",
        input_schema: {
          type: "object",
          properties: {
            questions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  question: str("The question, ending with a question mark."),
                  header: str("A very short label for it (at most 12 characters)."),
                  options: {
                    type: "array",
                    items: { type: "object", properties: { label: str("The choice, 1\u20135 words."), description: str("What choosing it means.") }, required: ["label"] }
                  },
                  multiSelect: { type: "boolean", description: "Allow picking more than one option." }
                },
                required: ["question", "options"]
              }
            }
          },
          required: ["questions"]
        }
      },
      {
        name: "ExitPlanMode",
        kind: "plan",
        description: "Use only in plan mode, once your plan is ready: it shows the plan to the user for approval. Pass it as Markdown \u2014 what you will change, file by file, and how you will check the result. If the user approves, plan mode ends and you carry out the plan; otherwise revise it from their feedback and call this again.",
        input_schema: { type: "object", properties: { plan: str("The plan, in Markdown.") }, required: ["plan"] }
      },
      {
        name: "Task",
        kind: "agent",
        description: "Launch a subagent that does a self-contained task on its own, in its own context, and reports back. Use it for broad searches or research that would otherwise fill this conversation with reading, and for independent parts of the work: call Task several times in one message to run them at the same time. A subagent has the file, Bash and web tools (not Task, AskUserQuestion or the plan tools), works in the same folder, and the user's permission mode applies to it. It sees nothing of this conversation, so give it a complete brief and say what to report.",
        input_schema: {
          type: "object",
          properties: { description: str("The task in 3\u20135 words, shown to the user."), prompt: str("The complete brief for the subagent.") },
          required: ["description", "prompt"]
        }
      }
    ];
    byName = new Map(TOOLS.map((t) => [t.name, t]));
    toolKind = (name) => byName.get(name)?.kind || "exec";
    apiTools = (names) => TOOLS.filter((t) => !names || names.includes(t.name)).map(({ name, description, input_schema }) => ({ name, description, input_schema, eager_input_streaming: true }));
    localHost = {
      name: "local",
      at(cwd, p) {
        const abs = resolveInWorkspace(cwd, typeof p === "string" && p ? p : ".");
        return { abs, rel: path8.relative(fssync3.realpathSync(cwd), abs).split(path8.sep).join("/") || "." };
      },
      async stat(cwd, p) {
        const at = this.at(cwd, p);
        const st2 = await fs8.stat(at.abs).catch(() => null);
        return { ...at, exists: Boolean(st2), dir: Boolean(st2?.isDirectory()), size: st2?.size ?? 0, mtime: st2?.mtimeMs ?? 0 };
      },
      async read(cwd, p) {
        const at = this.at(cwd, p);
        const st2 = await fs8.stat(at.abs);
        if (st2.isDirectory()) throw new Error(`${p} is a directory`);
        if (st2.size > 20 * 1024 * 1024) throw new Error(`the file is ${Math.round(st2.size / 1048576)} MB (at most 20 MB)`);
        return { ...at, size: st2.size, buf: await fs8.readFile(at.abs) };
      },
      async write(cwd, p, content) {
        const at = this.at(cwd, p);
        const existed = fssync3.existsSync(at.abs);
        await fs8.mkdir(path8.dirname(at.abs), { recursive: true });
        await fs8.writeFile(at.abs, content);
        return { ...at, existed };
      },
      async walk(cwd, p, limit2 = 2e3) {
        const at = this.at(cwd, p);
        const files = [];
        let seen = 0;
        const walk3 = async (dir, rel) => {
          if (seen > 5e4 || files.length >= limit2) return;
          let entries;
          try {
            entries = await fs8.readdir(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const e of entries) {
            seen++;
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) {
              if (!IGNORED.has(e.name)) await walk3(path8.join(dir, e.name), r);
            } else if (files.length < limit2) files.push([r, (await fs8.stat(path8.join(dir, e.name)).catch(() => null))?.mtimeMs || 0]);
          }
        };
        await walk3(at.abs, "");
        return { rel: at.rel, files };
      },
      async run(cwd, command2, { signal, timeoutMs, onData } = {}) {
        const r = await runCommand(command2, { cwd, signal, timeoutMs, onData });
        return { output: r.output, exitCode: r.exitCode };
      }
    };
    fail = (text) => ({ content: text, output: text, isError: true });
    q = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
  }
});

// server/adapters/claude-repo.js
import fs9 from "node:fs";
import path9 from "node:path";
function parseRepo(input) {
  const s = String(input || "").trim().replace(/^(?:https?:\/\/)?(?:www\.)?github\.com[/:]/i, "").replace(/^git@github\.com:/i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  return FULL.test(s) && !s.split("/").some((p) => p === "." || p === "..") ? s : null;
}
async function clone(host, workspaces, { full, branch }) {
  fs9.mkdirSync(workspaces, { recursive: true });
  const base = `${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}-${full.split("/")[1].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo"}`;
  let dir = path9.join(workspaces, base);
  for (let i = 2; fs9.existsSync(dir); i++) dir = path9.join(workspaces, `${base}-${i}`);
  const script = [
    "set -e",
    `git clone --origin origin -- ${q2(`${GITHUB}/${full}.git`)} ${q2(dir)}`,
    `cd ${q2(dir)}`,
    `if git ls-remote --exit-code --heads origin ${q2(branch)} >/dev/null 2>&1; then git checkout -q -B ${q2(branch)} ${q2(`origin/${branch}`)}; else git checkout -q -b ${q2(branch)}; fi`,
    `git config ${q2(`branch.${branch}.remote`)} origin`,
    `git config ${q2(`branch.${branch}.merge`)} ${q2(`refs/heads/${branch}`)}`
  ].join("\n");
  const r = await host.run(workspaces, script, { timeoutMs: 6e5 });
  if (r.exitCode !== 0) {
    fs9.rmSync(dir, { recursive: true, force: true });
    const out = String(r.output || "");
    const tail = out.trim().split("\n").slice(-3).join(" ").slice(0, 400);
    const why = /could not read Username|Authentication failed|Repository not found|not found|does not exist/i.test(out) ? `\u627E\u4E0D\u5230 ${full}\uFF0C\u6216\u9019\u53F0\u96FB\u8166\u6C92\u6709\u6B0A\u9650\u8B80\u5B83\u3002\u79C1\u4EBA repo \u8981\u5148\u5728\u300C\u22EF\u300D\u2192\u300CGitHub\u2026\u300D\u5E6B\u9019\u53F0\u96FB\u8166\u767B\u5165\u3002` : `\u6C92\u8FA6\u6CD5 clone ${full}\u3002`;
    throw Object.assign(new Error(`${why}\uFF08${tail}\uFF09`), { status: 400 });
  }
  return dir;
}
async function useBranch(host, cwd, { branch }) {
  const script = [
    "set -e",
    "git fetch -q origin 2>/dev/null || true",
    `if [ "$(git symbolic-ref --short -q HEAD || true)" != ${q2(branch)} ]; then`,
    `  if git show-ref -q --verify ${q2(`refs/heads/${branch}`)}; then git checkout -q ${q2(branch)};`,
    `  elif git show-ref -q --verify ${q2(`refs/remotes/origin/${branch}`)}; then git checkout -q -b ${q2(branch)} ${q2(`origin/${branch}`)};`,
    `  else git checkout -q -b ${q2(branch)}; fi`,
    "fi",
    `git config ${q2(`branch.${branch}.remote`)} origin`,
    `git config ${q2(`branch.${branch}.merge`)} ${q2(`refs/heads/${branch}`)}`
  ].join("\n");
  const r = await host.run(cwd, script, { timeoutMs: 12e4 });
  if (r.exitCode !== 0) throw Object.assign(new Error(`\u6C92\u8FA6\u6CD5\u5207\u5230\u5206\u652F ${branch}\uFF1A${String(r.output || "").trim().split("\n").slice(-3).join(" ").slice(0, 400)}`), { status: 409 });
}
function promptSection({ full, branch }) {
  return [
    "# GitHub repository (bound to this conversation)",
    `This conversation is bound to the GitHub repository ${full}, cloned in the working directory, on the branch \`${branch}\` (remote \`origin\`). This does not change for the rest of the conversation: everything you make for the user goes into this repository, on this branch. Work with high discipline:`,
    `- Work only in this clone and only on \`${branch}\`. Do not switch to or create other branches, do not change the remote, and do not delete branches.`,
    `- Commit as you go, in small logical commits with clear messages that say what changed and why, and push them with \`git push -u origin ${branch}\`. A piece of work is not done until it is committed and pushed. Agent Hub checks at the end of every turn and reminds you of anything left uncommitted or unpushed; if you still leave it, Agent Hub commits and pushes it with a generic message, which is worse than yours.`,
    "- Before each commit, look at `git status` and `git diff --staged` and commit only what belongs to the task. Never commit secrets (keys, tokens, passwords, .env files), large generated files, dependencies or build output; add them to .gitignore instead.",
    "- Run the project's tests, linters or build before you push when it has them, and fix what fails.",
    "- Never force-push and never rewrite history that was pushed (no rebase, amend, reset or filter of pushed commits). Agent Hub refuses such commands.",
    `- If a push is rejected because the remote branch moved, run \`git pull --no-rebase origin ${branch}\`, resolve conflicts carefully (keep both sides' intent), run the checks again and push. If it fails for another reason, retry a couple of times, then tell the user exactly what failed.`,
    "- When you finish, tell the user which commits you pushed (short hash and message)."
  ].join("\n");
}
async function check2(host, cwd, { branch }) {
  const script = [
    'echo "branch=$(git symbolic-ref --short -q HEAD || echo detached-HEAD)"',
    `echo "dirty=$(git status --porcelain | wc -l | tr -d ' ')"`,
    'echo "ahead=$(git rev-list --count HEAD --not --remotes=origin 2>/dev/null || echo 0)"'
  ].join("\n");
  const r = await host.run(cwd, script, { timeoutMs: 3e4 }).catch(() => null);
  const out = String(r?.output || "");
  const get = (k) => out.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim();
  if (!get("branch")) return null;
  const s = { branch: get("branch"), dirty: Number(get("dirty")) || 0, ahead: Number(get("ahead")) || 0 };
  if (s.branch === branch && !s.dirty && !s.ahead) return null;
  const zh = [];
  const en = [];
  if (s.branch !== branch) {
    zh.push(`\u505C\u5728\u5206\u652F ${s.branch}\uFF0C\u4E0D\u662F\u7D81\u5B9A\u7684 ${branch}`);
    en.push(`you are on ${s.branch}, not on \`${branch}\`, the branch this conversation is bound to: bring the work over to \`${branch}\` (git checkout ${branch}, then merge or cherry-pick it)`);
  }
  if (s.dirty) {
    zh.push(`${s.dirty} \u500B\u6A94\u6848\u7684\u8B8A\u66F4\u9084\u6C92 commit`);
    en.push(`${s.dirty} changed or new file(s) are not committed`);
  }
  if (s.ahead) {
    zh.push(`${s.ahead} \u500B commit \u9084\u6C92 push`);
    en.push(`${s.ahead} commit(s) are not pushed`);
  }
  return {
    ...s,
    zh: zh.join("\u3001"),
    en: `Agent Hub check at the end of your turn: ${en.join("; ")}. This conversation is bound to ${"`"}${branch}${"`"}: commit the work that belongs to the task with a clear message (leave out anything that must not be committed and add it to .gitignore), push it with \`git push -u origin ${branch}\`, then finish your answer.`
  };
}
async function autoSave(host, cwd, { branch }, left) {
  if (left.branch !== branch) return { ok: false, text: `\u6C92\u8FA6\u6CD5\u81EA\u52D5\u4E0A\u50B3\uFF1AClaude \u505C\u5728\u5206\u652F ${left.branch}\uFF0C\u4E0D\u662F\u7D81\u5B9A\u7684 ${branch}\u3002\u8ACB\u53EB Claude \u5207\u56DE ${branch} \u4E26\u628A\u5DE5\u4F5C\u5E36\u904E\u53BB\u3002` };
  const script = [
    "set -e",
    "git add -A",
    "if ! git diff --cached --quiet; then if git config user.email >/dev/null; then git commit -q -m 'Agent Hub auto-save: work left uncommitted at the end of a turn'; else git -c user.name='Agent Hub' -c user.email='agent-hub@localhost' commit -q -m 'Agent Hub auto-save: work left uncommitted at the end of a turn'; fi; fi",
    `git push -q -u origin ${q2(branch)} 2>&1`,
    "git log -1 --format=%h"
  ].join("\n");
  const r = await host.run(cwd, script, { timeoutMs: 18e4 });
  const out = String(r.output || "").trim();
  if (r.exitCode !== 0) return { ok: false, text: `\u81EA\u52D5 commit\uFF0Fpush \u5931\u6557\uFF1A${out.split("\n").slice(-3).join(" ").slice(0, 400)}` };
  return { ok: true, text: `Claude \u7559\u4E0B\u4E86\u6C92\u4E0A\u50B3\u7684\u5DE5\u4F5C\uFF08${left.zh}\uFF09\uFF0CAgent Hub \u5DF2\u81EA\u52D5 commit \u4E26 push \u5230 ${branch}\uFF08${out.split("\n").at(-1)}\uFF09\u3002` };
}
function guard(command2, { branch }) {
  for (const part of String(command2 || "").split(/&&|\|\||[;|\n]/)) {
    const words = part.trim().split(/\s+/).map((w) => w.replace(/^["']|["']$/g, ""));
    let i = words.findIndex((w) => !/^\w+=/.test(w));
    if (words[i] !== "git") continue;
    for (i++; i < words.length && words[i].startsWith("-"); i++) if (["-C", "-c", "--git-dir", "--work-tree"].includes(words[i])) i++;
    const sub = words[i];
    const args = words.slice(i + 1);
    if (sub === "remote" && ["add", "set-url", "remove", "rm", "rename", "set-head"].includes(args[0])) return `the remote of this repository is fixed (origin), so \`git remote ${args[0]}\` is not allowed`;
    if (sub !== "push") continue;
    const opts = args.filter((a) => a.startsWith("-"));
    const bad = opts.find((o) => /^(-f|--force|--force-with-lease|--force-if-includes|--mirror|--all|--branches|--delete|-d|--prune)(=|$)/.test(o) || /^-[a-z]*f/.test(o));
    if (bad) return `\`git push ${bad}\` could overwrite or delete what is on the remote`;
    const positional = args.filter((a) => !a.startsWith("-"));
    if (positional.length && positional[0] !== "origin") return "pushing goes to origin only";
    for (const ref of positional.slice(1)) {
      if (ref.startsWith("+")) return `\`${ref}\` is a forced push`;
      const [src, dst] = ref.includes(":") ? ref.split(":") : [ref, ref];
      const to = (dst || "").replace(/^refs\/heads\//, "");
      const okSrc = ["HEAD", branch, `refs/heads/${branch}`].includes(src);
      if (!src || !okSrc || to !== branch && !(to === "HEAD" && !ref.includes(":"))) return `this conversation pushes to \`${branch}\` only (got \`${ref}\`)`;
    }
  }
  return null;
}
var FULL, GITHUB, q2;
var init_claude_repo = __esm({
  "server/adapters/claude-repo.js"() {
    FULL = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
    GITHUB = process.env.AGENT_HUB_GITHUB_TEST_URL || "https://github.com";
    q2 = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  }
});

// server/adapters/claude.js
var claude_exports = {};
__export(claude_exports, {
  AGENT: () => AGENT,
  available: () => available,
  bindRepo: () => bindRepo,
  cancelQueued: () => cancelQueued,
  cannotSend: () => cannotSend,
  command: () => command,
  configure: () => configure,
  dispose: () => dispose,
  getChanges: () => getChanges,
  hostFor: () => hostFor,
  init: () => init,
  interrupt: () => interrupt,
  isRunning: () => isRunning,
  listFiles: () => listFiles,
  live: () => live,
  readFile: () => readFile2,
  respond: () => respond,
  restore: () => restore,
  send: () => send,
  setup: () => setup,
  steerQueued: () => steerQueued,
  view: () => view
});
import os2 from "node:os";
import crypto6 from "node:crypto";
function init(makeContext) {
  liveContext = makeContext;
}
function halt(run, why) {
  run.halted ??= why;
  run.ac.abort();
  for (const resolve2 of [...run.waits.values()]) resolve2(null);
}
function available() {
  return apiKey() ? { ok: true } : { ok: false, reason: "\u9084\u6C92\u6709\u8A2D\u5B9A Claude API key" };
}
function cannotSend(session) {
  if (!apiKey()) return "\u9084\u6C92\u6709\u8A2D\u5B9A Claude API key\uFF1A\u5728\u5DE6\u4E0B\u89D2\u300C\u22EF\u300D\u2192\u300CClaude API\u2026\u300D\u8CBC\u4E0A Claude Console \u7684 API key\uFF08sk-ant-\u2026\uFF09\u3002";
  const m = session?.machineId && getMachine(session.machineId);
  if (session?.machineId && !m?.online) return `\u300C${m?.name || "\u90A3\u53F0\u96FB\u8166"}\u300D\u76EE\u524D\u96E2\u7DDA\u3002\u5728\u90A3\u53F0\u96FB\u8166\u4E0A\u57F7\u884C\u9023\u63A5\u5668\u5F8C\u518D\u8A66\u3002`;
  return null;
}
function st(session) {
  session.state.claude ??= { messages: [], turns: [], usage: emptyUsage() };
  return session.state.claude;
}
async function setup(session, config = {}) {
  const { defaults: d, webTools: webTools2 } = settings();
  const c = st(session);
  const host = hostFor(session);
  const platform = session.machineId ? getMachine(session.machineId)?.platform || "unknown" : `${os2.platform()} ${os2.release()}`;
  const repo = config.repo ? { full: config.repo.full, branch: config.repo.branch } : null;
  if (repo) session.cwd = await clone(host, WORKSPACES_DIR, repo);
  const [notes, git] = await Promise.all([projectNotes(host, session.cwd), host.stat(session.cwd, ".git").then((x) => x.exists, () => false)]);
  const computer = config.computer || machineName(session);
  c.system = systemPrompt(session.cwd, { platform, notes, git, computer, repo });
  c.subSystem = subSystemPrompt(session.cwd, platform, repo);
  c.web = webTools2;
  const model = typeof config.model === "string" && config.model ? config.model : d.model;
  session.meta = {
    ...session.meta || {},
    agent: "claude",
    machineName: computer,
    model,
    effort: typeof config.effort === "string" && config.effort ? config.effort : d.effort,
    permission: PERMISSIONS2.includes(config.permission) ? config.permission : d.permission,
    planMode: typeof config.planMode === "boolean" ? config.planMode : d.planMode,
    queue: [],
    todos: [],
    ...repo ? { repo: { ...repo, url: `https://github.com/${repo.full}/tree/${repo.branch}` } } : {}
  };
  saveSession(session);
  refreshModels(session, true);
}
async function projectNotes(host, cwd) {
  for (const file of ["CLAUDE.md", "AGENTS.md"]) {
    try {
      const text = (await host.read(cwd, file)).buf.toString("utf8").trim();
      if (text) return { file, text: text.length > 4e4 ? `${text.slice(0, 4e4)}
\u2026 (cut; Read the file for the rest)` : text };
    } catch {
    }
  }
  return null;
}
function systemPrompt(cwd, { platform, notes, git, computer, repo, started = Date.now() }) {
  return [
    "You are Claude, working as a coding agent for the user through Agent Hub, a control center they open in a browser or on their phone. You act on their computer only through your tools, which run in the working directory below.",
    "",
    "# Environment",
    `- Working directory: ${cwd}`,
    `- Computer: ${computer} (${platform}); shell: bash`,
    `- This conversation started on ${new Date(started).toISOString().slice(0, 10)}.`,
    git ? "- The working directory is a git repository." : "- The working directory is not a git repository.",
    "",
    "# How to work",
    "- Look before you change anything: Read files before editing them, and find your way with Grep and Glob rather than guessing paths.",
    "- Change existing files with Edit; use Write for new files or full rewrites. Keep changes to what was asked.",
    "- Use Bash for builds, tests, git and package managers, and run the relevant checks after changing code.",
    "- For work with several steps, keep a todo list with TodoWrite and update it as you go.",
    "- Hand self-contained research or independent parts of the work to subagents with Task; run several at once when they do not depend on each other.",
    "- When you need a decision that is the user's to make, ask with AskUserQuestion instead of guessing.",
    "- Some tool calls wait for the user's approval. If one is rejected, do not retry it unchanged: read their feedback in the result, then adjust or ask.",
    "- HTML files you write are shown to the user live in a side panel, so a page is a good way to present a report, a dashboard or a prototype.",
    "- For GitHub (cloning, branches, pushing, pull requests, issues, Actions), use git and the GitHub CLI (gh) through Bash. The user signs this computer in to GitHub from Agent Hub (\u22EF \u2192 GitHub\u2026); if `gh auth status` shows it is not signed in or gh is missing, ask them to do that there. Never ask for a token in the chat, run `gh auth login`, or print a token. Unless the user asked for it, ask before anything that changes GitHub (push, opening, merging or closing a pull request or issue, commenting); work on a new branch rather than the default one, and never force-push unless told to.",
    "- Write to the user in the language they write to you in. Be concise and use Markdown. When you finish, say what you changed and what they should check.",
    "",
    "# Plan mode",
    "When a note says plan mode is on, change nothing: read and research only (Write, Edit and Bash are refused), then call ExitPlanMode with your plan. Once the user approves it, plan mode is off and you carry it out.",
    repo ? `
${promptSection(repo)}` : "",
    notes ? `
# Project instructions
The working directory has instructions for agents in ${notes.file}. Follow them:

${notes.text}` : ""
  ].join("\n").trim();
}
function subSystemPrompt(cwd, platform = os2.platform(), repo = null) {
  return [
    `You are a subagent of Claude, doing one self-contained task in the working directory ${cwd} (${platform}, bash).`,
    "The main agent gave you a brief and sees only your final message, so end with a complete report of what you found or did: paths, names, commands, results.",
    "You can read and search files, run commands with Bash and edit files; some calls wait for the user's approval, and a rejected call should not be retried unchanged. Do only what the brief asks.",
    repo ? `The working directory is a clone of the GitHub repository ${repo.full} on the branch ${repo.branch}. Do not commit, push or switch branches: the main agent does that.` : ""
  ].filter(Boolean).join("\n");
}
async function refreshModels(session, force = false) {
  if (!force && Date.now() - (modelsAt.get(session.id) || 0) < 5 * 6e4) return;
  modelsAt.set(session.id, Date.now());
  try {
    const list = (await models()).map(({ id, name, efforts, defaultEffort, image, context }) => ({ id, name, efforts, defaultEffort, image, context }));
    if (getSession(session.id) !== session) return;
    const meta = session.meta || {};
    const fields = {};
    if (JSON.stringify(meta.models) !== JSON.stringify(list)) fields.models = list;
    if (meta.defaultModel !== DEFAULT_MODEL) fields.defaultModel = DEFAULT_MODEL;
    const size = list.find((m) => m.id === meta.model)?.context;
    if (size && meta.context && meta.context.size !== size) fields.context = { ...meta.context, size };
    if (Object.keys(fields).length) liveContext(session).setMeta(fields);
  } catch {
  }
}
function view(session) {
  refreshModels(session);
}
async function send(session, text, { images = [], note, steer } = {}) {
  const why = cannotSend(session);
  if (why) throw Object.assign(new Error(why), { status: 409 });
  const promptId = `p_${crypto6.randomBytes(6).toString("hex")}`;
  const thumbs = images.map((i) => i.thumb || `data:${i.mimeType};base64,${i.data}`);
  if (runs.has(session.id)) {
    if (images.length) queuedImages.set(session, promptId, images);
    liveContext(session).setMeta({ queue: [...queue(session), { promptId, text, images: thumbs, ...note ? { note } : {}, ...steer ? { steered: true } : {} }] });
    return { ok: true, promptId, queued: true };
  }
  startTurn(session, { text, images, thumbs, note, promptId });
  return { ok: true, promptId };
}
function startTurn(session, prompt) {
  const run = new Run(session);
  runs.set(session.id, run);
  run.done = turn(run, prompt).catch((err) => console.error(`[claude] ${session.id}:`, err)).finally(() => {
    runs.delete(session.id);
    next(session);
  });
  return run;
}
function next(session) {
  if (runs.has(session.id) || getSession(session.id) !== session) return;
  const q3 = queue(session)[0];
  if (!q3) return;
  liveContext(session).setMeta({ queue: queue(session).slice(1) });
  const images = queuedImages.get(session, q3.promptId) || [];
  queuedImages.delete(session, q3.promptId);
  startTurn(session, { text: q3.text, images, thumbs: q3.images, note: q3.note, promptId: q3.promptId });
}
async function turn(run, { text, images = [], thumbs, note, promptId, resume }) {
  const { session, ctx } = run;
  const c = st(session);
  repair(c);
  const userEv = resume ? ctx.emit({ type: "info", text: "\u4E2D\u63A7\u53F0\u91CD\u65B0\u555F\u52D5\u4E86\uFF1AClaude \u63A5\u8457\u525B\u624D\u88AB\u4E2D\u65B7\u7684\u5DE5\u4F5C\u7E7C\u7E8C" }) : ctx.emit({ type: "user", text, images: thumbs || [], promptId, source: "hub", ...note ? { note } : {} });
  c.turns = [...c.turns, { msg: c.messages.length, event: userEv.id, toldPlan: c.toldPlan ?? null }].slice(-50);
  if (!session.titled && !resume) ctx.setTitle(text.replace(/\s+/g, " ").trim().slice(0, 80) || "\u65B0\u5C0D\u8A71");
  c.active = { since: Date.now() };
  ctx.setStatus("running");
  saveSession(session, { immediate: true });
  const model = session.meta?.model || DEFAULT_MODEL;
  const effort = session.meta?.effort || "";
  ctx.setMeta({ turnModel: model, turnEffort: effort });
  refreshModels(session);
  const content = resume ? [] : [...images.map(imageBlock), { type: "text", text: text || "\uFF08\u5716\u7247\uFF09" }];
  if (c.restarted) {
    content.unshift({ type: "text", text: `<system-reminder>${RESTART_NOTE}</system-reminder>` });
    c.restarted = false;
  }
  if (c.bindNote) {
    content.unshift({ type: "text", text: `<system-reminder>${c.bindNote}</system-reminder>` });
    c.bindNote = null;
  }
  if (!content.length) content.push({ type: "text", text: "Continue." });
  const note2 = planNote(session, c);
  const sysNote = note2 && supportsSystemMessages(model) ? { role: "system", content: note2 } : null;
  if (note2 && !sysNote) content.push({ type: "text", text: `<system-reminder>${note2}</system-reminder>` });
  c.messages.push({ role: "user", content });
  if (sysNote) c.messages.push(sysNote);
  let error = null;
  try {
    const opts = { messages: c.messages, model, effort, main: true, system: c.system, tools: mainTools(session, model) };
    let r = await loop(run, opts);
    const repo = session.meta?.repo;
    const finished = (x) => !x.aborted && !x.halted && !x.budget && !run.aborted && !run.halted && !session.meta?.planMode;
    if (repo && finished(r)) {
      let left = await check2(hostFor(session), session.cwd, repo);
      for (let i = 0; left && i < 2 && finished(r); i++) {
        ctx.emit({ type: "info", text: `Agent Hub \u6AA2\u67E5\uFF1A${left.zh}\uFF0C\u63D0\u9192 Claude commit \u4E26 push \u5230 ${repo.branch}` });
        c.messages.push({ role: "user", content: [{ type: "text", text: `<system-reminder>${left.en}</system-reminder>` }] });
        r = await loop(run, opts);
        left = finished(r) ? await check2(hostFor(session), session.cwd, repo) : null;
      }
      if (left && finished(r)) {
        const saved2 = await autoSave(hostFor(session), session.cwd, repo, left);
        ctx.emit({ type: saved2.ok ? "info" : "error", text: saved2.text });
      }
    }
    error = run.halted || null;
  } catch (err) {
    if (run.halted) error = run.halted;
    else if (!run.aborted) {
      error = explain(err);
      ctx.emit({ type: "error", text: error });
    }
  } finally {
    finishTurn(run, error);
  }
}
function planNote(session, c) {
  const plan = Boolean(session.meta?.planMode);
  const told = c.toldPlan ?? false;
  if (plan === told) return null;
  c.toldPlan = plan;
  return plan ? "Plan mode is on: change nothing. Research with the read-only tools, then present your plan with ExitPlanMode and wait for the user's approval." : "Plan mode is off: you may change files and run commands again (the user's permission mode still applies).";
}
function repair(c) {
  while (c.messages.at(-1)?.role === "system") c.toldPlan = !/^Plan mode is on/.test(c.messages.pop().content);
  const last = c.messages.at(-1);
  if (last?.role === "assistant" && Array.isArray(last.content)) {
    const ids = last.content.filter((b) => b.type === "tool_use").map((b) => b.id);
    if (ids.length) c.messages.push({ role: "user", content: ids.map((id) => ({ type: "tool_result", tool_use_id: id, is_error: true, content: "Not run: the turn ended before this tool call was answered." })) });
  }
}
function finishTurn(run, error) {
  const { session, ctx } = run;
  st(session).active = null;
  for (const ev of session.events.slice(run.firstEvent)) {
    if (ev.permission && !ev.permission.chosen) ctx.patch(ev, { permission: { ...ev.permission, chosen: "cancelled" } });
    if (ev.type === "tool_use" && ["pending", "running", "awaiting"].includes(ev.status)) ctx.patch(ev, { status: run.aborted || ev.status === "awaiting" ? "interrupted" : "ended" });
    if (ev.subagent?.status === "running") ctx.patch(ev, { subagent: { ...ev.subagent, status: run.aborted ? "cancelled" : "error" } });
  }
  const models2 = [...run.models || /* @__PURE__ */ new Map()].map(([id, name]) => ({ id, name }));
  ctx.emit({ type: "turn_end", durationMs: Date.now() - run.started, usage: { ...run.usage }, models: models2, interrupted: run.aborted && !run.halted, error: Boolean(error) });
  ctx.setMeta({ turnModel: null, turnEffort: null });
  ctx.setStatus(error ? "error" : "idle");
  saveSession(session, { immediate: true });
}
async function loop(run, opts) {
  const { session, ctx } = run;
  const { messages, main, scope = {} } = opts;
  const where = scope.parent ? { parent: scope.parent, agentId: scope.agentId } : {};
  let finalText = "";
  for (let step = 0; step < (main ? MAX_STEPS : SUB_STEPS); step++) {
    if (run.aborted) return { finalText, aborted: true };
    const budget = session.meta?.budget;
    if (budget && (session.usage?.costUsd || 0) >= budget) {
      if (!run.budgetSaid) ctx.emit({ type: "info", text: `\u5DF2\u9054\u9019\u500B\u5C0D\u8A71\u7684\u82B1\u8CBB\u4E0A\u9650 US$${budget}\uFF08\u76EE\u524D\u7D04 US$${fmtUsd(session.usage.costUsd)}\uFF09\uFF0C\u5148\u505C\u5728\u9019\u88E1\u3002\u8981\u7E7C\u7E8C\uFF0C\u5728\u300C\u22EF\u300D\u2192\u300C\u82B1\u8CBB\u4E0A\u9650\u2026\u300D\u8ABF\u9AD8\u6216\u95DC\u9589\uFF0C\u518D\u9001\u51FA\u300C\u7E7C\u7E8C\u300D\u3002` });
      run.budgetSaid = true;
      return { finalText, budget: true };
    }
    const r = await ask(run, opts);
    if (r.aborted) {
      if (r.partial) messages.push(r.partial);
      return { finalText, aborted: true };
    }
    const msg = r.message;
    count(run, opts, r);
    const served = msg.model || opts.model;
    noteServed(run, opts, served);
    const swapped = !served.startsWith(opts.model);
    if (swapped || msg.stop_reason === "refusal") {
      const d = msg.stop_details || {};
      for (const ev of r.byId.values()) ctx.patch(ev, { status: "ended" });
      const who = opts.main ? "" : "\u5B50\u4EE3\u7406\uFF1A";
      const text2 = swapped ? `${who}\u9019\u4E00\u6B65\u662F\u7531 ${modelName(served)}\uFF08${served}\uFF09\u56DE\u8986\u7684\uFF0C\u4E0D\u662F\u4F60\u9078\u7684 ${modelName(opts.model)}\u2014\u2014\u53EF\u80FD\u88AB Anthropic \u964D\u7D1A\u6216\u6539\u7531\u5176\u4ED6\u6A21\u578B\u63A5\u624B\u3002\u70BA\u4E86\u4E0D\u5728\u4F60\u4E0D\u77E5\u9053\u7684\u60C5\u6CC1\u4E0B\u7528\u5225\u7684\u6A21\u578B\u7E7C\u7E8C\uFF0C\u5DF2\u505C\u6B62\u9019\u4E00\u8F2A\uFF0C\u5B83\u8981\u6C42\u7684\u5DE5\u5177\u90FD\u6C92\u6709\u57F7\u884C\u3002\u8981\u7E7C\u7E8C\u8ACB\u518D\u9001\u51FA\u8A0A\u606F\uFF08\u6216\u5148\u63DB\u6A21\u578B\uFF09\u3002` : `${who}${modelName(opts.model)} \u62D2\u7D55\u4E86\u9019\u500B\u8ACB\u6C42${d.category ? `\uFF08\u5B89\u5168\u5206\u985E\uFF1A${d.category}\uFF09` : ""}\uFF0C\u5DF2\u505C\u6B62\u9019\u4E00\u8F2A\u3002${d.explanation || ""}`.trim();
      ctx.emit({ type: "error", text: text2, model: served, ...where });
      halt(run, text2);
      return { finalText, halted: true };
    }
    messages.push({ role: "assistant", content: msg.content });
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    if (text.trim()) finalText = text;
    if (msg.stop_reason === "pause_turn") continue;
    const uses = msg.content.filter((b) => b.type === "tool_use");
    if (!uses.length) {
      if (msg.stop_reason === "max_tokens") ctx.emit({ type: "info", text: "\u56DE\u8986\u5230\u9054\u9577\u5EA6\u4E0A\u9650\uFF0C\u88AB\u622A\u65B7\u4E86", ...where });
      if (msg.stop_reason === "model_context_window_exceeded") ctx.emit({ type: "info", text: "\u5C0D\u8A71\u5DF2\u7D93\u585E\u6EFF\u6A21\u578B\u7684 context\u3002\u7528 /compact \u58D3\u7E2E\u5C0D\u8A71\u5F8C\u518D\u7E7C\u7E8C\u3002", ...where });
      return { finalText };
    }
    let results;
    if (msg.stop_reason === "max_tokens") {
      const why = "Your response hit the output limit, so this tool call was cut off and was not run. Do the work in smaller pieces (for a big file, Write a first part and add the rest with Edit).";
      results = uses.map((u) => {
        const ev = r.byId.get(u.id);
        if (ev) ctx.patch(ev, { status: "error", isError: true, output: "\u8F38\u51FA\u5230\u9054\u9577\u5EA6\u4E0A\u9650\uFF0C\u9019\u500B\u5DE5\u5177\u547C\u53EB\u88AB\u622A\u65B7\uFF0C\u6C92\u6709\u57F7\u884C" });
        return { type: "tool_result", tool_use_id: u.id, is_error: true, content: why };
      });
    } else results = await runTools(run, uses, r.byId, opts);
    const content = [...results];
    if (main && !run.aborted) content.push(...takeSteered(run));
    messages.push({ role: "user", content });
  }
  ctx.emit({ type: "info", text: `\u5DF2\u9054\u55AE\u6B21\u56DE\u5408 ${main ? MAX_STEPS : SUB_STEPS} \u6B65\u4E0A\u9650\uFF0C\u5148\u505C\u5728\u9019\u88E1`, ...where });
  return { finalText };
}
function takeSteered(run) {
  const { session, ctx } = run;
  const items = queue(session).filter((q3) => q3.steered);
  if (!items.length) return [];
  ctx.setMeta({ queue: queue(session).filter((q3) => !q3.steered) });
  const blocks = [];
  for (const q3 of items) {
    ctx.emit({ type: "user", text: q3.text, images: q3.images || [], promptId: q3.promptId, source: "hub", steered: true, ...q3.note ? { note: q3.note } : {} });
    const images = queuedImages.get(session, q3.promptId) || [];
    queuedImages.delete(session, q3.promptId);
    blocks.push(...images.map(imageBlock), { type: "text", text: `The user sent this while you were working:
${q3.text || "(images)"}` });
  }
  return blocks;
}
function noteServed(run, opts, served) {
  const name = modelName(served);
  (run.models ??= /* @__PURE__ */ new Map()).set(served, name);
  if (opts.quiet) return;
  if (opts.main) return run.ctx.setMeta({ servedModel: { id: served, name, asked: opts.model, at: Date.now() } });
  const card = opts.scope?.parent && run.session.events.find((e) => e.id === opts.scope.parent);
  if (card?.subagent) run.ctx.patch(card, { subagent: { ...card.subagent, served, servedAt: Date.now() } });
}
function count(run, opts, r) {
  const { session, ctx } = run;
  const c = st(session);
  const msg = r.message;
  const u = msg.usage || {};
  const price = costOf(msg.model || opts.model, u);
  const cost = price ?? 0;
  const prompt = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const out = u.output_tokens || 0;
  c.usage = { ...emptyUsage(), ...c.usage };
  c.usage.input += u.input_tokens || 0;
  c.usage.cacheWrite += u.cache_creation_input_tokens || 0;
  c.usage.cacheRead += u.cache_read_input_tokens || 0;
  c.usage.output += out;
  c.usage.searches += u.server_tool_use?.web_search_requests || 0;
  c.usage.requests += 1;
  c.usage.cost += cost;
  if (price === null) c.usage.unpriced = true;
  session.usage.inputTokens += prompt;
  session.usage.outputTokens += out;
  session.usage.costUsd += cost;
  run.usage.inputTokens += prompt;
  run.usage.outputTokens += out;
  run.usage.costUsd += cost;
  const fields = { claudeUsage: { ...c.usage } };
  if (opts.main && !opts.quiet) {
    fields.context = { used: prompt + out, size: modelInfo(opts.model).context };
    if (r.firstAt && out > 0) {
      c.rates = [...c.rates || [], { tokens: out, ms: Math.max(1, r.endAt - r.firstAt) }].slice(-10);
      const tokens = c.rates.reduce((a, x) => a + x.tokens, 0);
      const ms = c.rates.reduce((a, x) => a + x.ms, 0);
      if (ms >= 100) fields.tps = Math.round(tokens / ms * 1e3);
    }
  }
  const limits = rateLimits(r.headers);
  if (limits) fields.rateLimits = limits;
  ctx.setMeta(fields);
}
async function ask(run, { messages, model, effort, system, tools, scope = {}, quiet = false, toolChoice }) {
  const { session, ctx } = run;
  const c = st(session);
  const where = scope.parent ? { parent: scope.parent, agentId: scope.agentId } : {};
  const body = {
    model,
    max_tokens: Math.min(64e3, modelInfo(model).maxOut || 64e3),
    // The fixed prefix (tools + system) and, automatically, the history so far.
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    tools,
    messages,
    cache_control: { type: "ephemeral" },
    ...thinkingFor(model, effort)
  };
  if (toolChoice) body.tool_choice = toolChoice;
  const betas = [];
  const client2 = client();
  for (let attempt = 0; ; attempt++) {
    const evs = /* @__PURE__ */ new Map();
    const byId = /* @__PURE__ */ new Map();
    let firstAt = 0;
    const emit = (fields) => quiet ? { ...fields, id: "" } : ctx.emit({ ...fields, ...where });
    try {
      const params = betas.length ? { ...body, betas } : body;
      const stream2 = betas.length ? client2.beta.messages.stream(params, { signal: run.ac.signal }) : client2.messages.stream(params, { signal: run.ac.signal });
      for await (const e of stream2) {
        if (e.type === "content_block_start") {
          const b = e.content_block;
          if (b.type === "tool_use") {
            const ev = emit({ type: "tool_use", name: b.name, toolCallId: b.id, title: "", status: "pending", argsText: "" });
            evs.set(e.index, ev);
            byId.set(b.id, ev);
          } else if (b.type === "server_tool_use") {
            evs.set(e.index, emit({ type: "tool_use", name: SERVER_TOOLS[b.name] || b.name, toolCallId: b.id, server: true, title: "", status: "running", argsText: "" }));
          } else if (b.type === "text" || b.type === "thinking") {
            evs.set(e.index, { lazy: b.type, text: b.text || b.thinking || "" });
          } else if (/tool_result$/.test(b.type) && b.tool_use_id && !quiet) {
            serverResult(run, b);
          }
        } else if (e.type === "content_block_delta") {
          const d = e.delta;
          let ev = evs.get(e.index);
          if (!ev) continue;
          if (d.type === "text_delta" || d.type === "thinking_delta") {
            const t = d.type === "text_delta" ? d.text : d.thinking;
            if (!t) continue;
            firstAt ||= Date.now();
            if (quiet) continue;
            if (ev.lazy) {
              const real = ctx.emit({ type: ev.lazy, text: ev.text, ...where });
              evs.set(e.index, real);
              ev = real;
            }
            ctx.delta(ev, t);
          } else if (d.type === "input_json_delta" && d.partial_json && !ev.lazy) {
            firstAt ||= Date.now();
            if (!quiet) ctx.delta(ev, d.partial_json, "argsText");
          }
        }
      }
      const message = await stream2.finalMessage();
      if (!quiet) {
        message.content.forEach((b, i) => {
          const ev = evs.get(i);
          if (!ev || ev.lazy) return;
          if (b.type === "tool_use" || b.type === "server_tool_use") ctx.patch(ev, { input: b.input, title: titleOf(ev.name, b.input, session.cwd), argsText: "" });
        });
      }
      return { message, byId, headers: stream2.response?.headers, firstAt, endAt: Date.now() };
    } catch (err) {
      if (run.aborted) return { aborted: true, partial: partialOf(evs) };
      const msg = String(err?.error?.error?.message || err?.message || "");
      if (!quiet) for (const ev of byId.values()) ctx.patch(ev, { status: "ended" });
      if (attempt === 0 && err?.status === 400 && /signature|thinking/i.test(msg) && stripThinking(messages)) continue;
      throw err;
    }
  }
}
function partialOf(evs) {
  const text = [...evs.entries()].sort(([a], [b]) => a - b).map(([, ev]) => ev.type === "text" ? ev.text : "").join("").trimEnd();
  return text ? { role: "assistant", content: [{ type: "text", text }] } : null;
}
function stripThinking(messages) {
  let n = 0;
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const kept = m.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
    n += m.content.length - kept.length;
    m.content = kept.length ? kept : [{ type: "text", text: "\u2026" }];
  }
  return n > 0;
}
function modelName(id) {
  return modelInfo(id || "").name || id || "Claude";
}
function findTool(session, toolUseId) {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const ev = session.events[i];
    if (ev.type === "tool_use" && ev.toolCallId === toolUseId) return ev;
  }
  return null;
}
function serverResult(run, b) {
  const ev = findTool(run.session, b.tool_use_id);
  if (!ev) return;
  const x = b.content;
  let output = "";
  let isError = false;
  if (Array.isArray(x)) {
    output = x.filter((r) => r.type === "web_search_result").map((r) => `${r.title || r.url}
  ${r.url}`).join("\n") || "\u6C92\u6709\u7D50\u679C";
  } else if (x && /error/.test(x.type || "")) {
    isError = true;
    output = `\u5931\u6557\uFF1A${x.error_code || "unknown"}`;
  } else if (x?.type === "web_fetch_result") {
    output = [x.content?.title, x.url].filter(Boolean).join("\n");
  } else if (x && typeof x === "object") {
    output = [x.stdout, x.stderr].filter(Boolean).join("\n") || (x.return_code != null ? `exit ${x.return_code}` : "");
  }
  run.ctx.patch(ev, { status: isError ? "error" : "done", isError, output });
}
async function runTools(run, uses, byId, opts) {
  const results = /* @__PURE__ */ new Map();
  const one = async (u) => results.set(u.id, await runTool(run, u, byId.get(u.id), opts));
  const tasks = uses.filter((u) => u.name === "Task");
  const parallel = Promise.all(tasks.map(one));
  for (const u of uses) if (u.name !== "Task") await one(u);
  await parallel;
  return uses.map((u) => {
    const r = results.get(u.id);
    const content = typeof r.content === "string" ? r.content || "(no output)" : r.content;
    return { type: "tool_result", tool_use_id: u.id, content, ...r.isError ? { is_error: true } : {} };
  });
}
function needsPermission(session, name, kind) {
  if (kind !== "edit" && kind !== "exec") return false;
  if (session.allowedTools?.includes(name)) return false;
  const mode = session.meta?.permission || "manual";
  if (mode === "auto") return false;
  if (mode === "edits" && kind === "edit") return false;
  return true;
}
async function runTool(run, u, ev, opts) {
  const { session, ctx } = run;
  ev ??= ctx.emit({ type: "tool_use", name: u.name, toolCallId: u.id, input: u.input, title: titleOf(u.name, u.input, session.cwd), status: "pending" });
  if (run.aborted) return interrupted(run, ev);
  const invalid = validate(u.name, u.input);
  if (invalid) {
    const text = `Invalid input: ${invalid}. Received: ${JSON.stringify(u.input).slice(0, 400)}`;
    ctx.patch(ev, { status: "error", isError: true, output: text });
    return { content: text, isError: true };
  }
  const kind = toolKind(u.name);
  if (kind === "todo") {
    const todos = u.input.todos.map((t) => ({ title: t.status === "in_progress" && t.activeForm ? t.activeForm : t.content, content: t.content, status: t.status }));
    ctx.patch(ev, { todos, status: "done" });
    if (opts.main) ctx.setMeta({ todos });
    return { content: "Todo list updated. Keep it current as you work.", isError: false };
  }
  if (kind === "ask") return askQuestions(run, ev, u.input);
  if (kind === "plan") return planReview(run, ev, u.input);
  if (kind === "agent") return subagent(run, ev, u.input, opts);
  if ((kind === "edit" || kind === "exec") && session.meta?.planMode) {
    st(session).toldPlan = true;
    ctx.patch(ev, { status: "denied", output: "\u8A08\u756B\u6A21\u5F0F\u4E2D\uFF1A\u9084\u4E0D\u80FD\u4FEE\u6539\u6216\u57F7\u884C" });
    return { content: "Plan mode is on, so nothing can be changed or run yet. Keep researching with Read, Grep and Glob, then present your plan with ExitPlanMode.", isError: true };
  }
  const repo = session.meta?.repo;
  const refused = repo && u.name === "Bash" && guard(u.input.command, repo);
  if (refused) {
    ctx.patch(ev, { status: "denied", output: `Agent Hub \u62D2\u7D55\uFF1A\u9019\u500B\u5C0D\u8A71\u7D81\u5B9A ${repo.full} \u7684 ${repo.branch}` });
    return { content: `Refused by Agent Hub: ${refused}. This conversation is bound to ${repo.full}, branch ${repo.branch}; push your commits there with \`git push -u origin ${repo.branch}\`, and never force-push.`, isError: true };
  }
  if (needsPermission(session, u.name, kind)) {
    const a = await askUser(run, ev, { kind: "approval", options: APPROVAL_OPTIONS });
    if (!a) return interrupted(run, ev);
    if (a.optionId === "rejected") {
      ctx.patch(ev, { status: "denied" });
      return { content: `The user rejected this ${u.name} call.${a.feedback ? ` What they said: ${a.feedback}` : " Do not retry it unchanged; ask them how to proceed if it is unclear."}`, isError: true };
    }
    if (a.optionId === "approved_session" && !session.allowedTools.includes(u.name)) session.allowedTools.push(u.name);
  }
  ctx.patch(ev, { status: "running", output: "" });
  let pending = "";
  let timer = null;
  const r = await execute(u.name, u.input, {
    host: hostFor(session),
    cwd: session.cwd,
    signal: run.ac.signal,
    onData: (chunk) => {
      pending += chunk;
      timer ??= setTimeout(() => {
        ctx.delta(ev, pending, "output");
        pending = "";
        timer = null;
      }, 150);
    }
  });
  clearTimeout(timer);
  ctx.patch(ev, { status: run.aborted ? "interrupted" : r.isError ? "error" : "done", output: r.output, isError: r.isError });
  return { content: r.content, isError: r.isError };
}
function askUser(run, ev, permission) {
  const { ctx } = run;
  ctx.patch(ev, { status: "awaiting", permission: { ...permission, chosen: null } });
  ctx.setStatus("awaiting_permission");
  return new Promise((resolve2) => {
    if (run.aborted) return resolve2(null);
    run.waits.set(ev.id, resolve2);
  }).then((answer) => {
    run.waits.delete(ev.id);
    if (!run.waits.size && !run.aborted) ctx.setStatus("running");
    return answer;
  });
}
async function respond(session, eventId, optionId, { answers, feedback } = {}) {
  const run = runs.get(session.id);
  const resolve2 = run?.waits.get(eventId);
  const ev = session.events.find((e) => e.id === eventId);
  if (!resolve2 || !ev?.permission || ev.permission.chosen) return false;
  const note = String(feedback || "").trim();
  run.ctx.patch(ev, { permission: { ...ev.permission, chosen: optionId === "answer" ? "answered" : optionId, ...note ? { feedback: note } : {} }, ...answers ? { answers } : {} });
  resolve2({ optionId, answers, feedback: note });
  return true;
}
async function askQuestions(run, ev, input) {
  const questions = input.questions.slice(0, 4).map((q3, i) => ({
    id: `q${i}`,
    question: q3.question,
    header: q3.header || "",
    multi_select: Boolean(q3.multiSelect),
    allow_other: true,
    other_label: "\u5176\u4ED6\u7B54\u6848",
    options: (q3.options || []).map((o, j) => ({ id: `o${j}`, label: o.label, description: o.description || "" }))
  }));
  run.ctx.patch(ev, { title: questions[0]?.question || "Claude \u6709\u554F\u984C\u8981\u554F\u4F60" });
  const a = await askUser(run, ev, { kind: "question", questions });
  if (!a) return interrupted(run, ev);
  if (a.optionId === "__dismiss") {
    run.ctx.patch(ev, { status: "done" });
    return { content: "The user skipped the questions without answering. Go on with your best judgment, or ask again in plain words if you cannot.", isError: false };
  }
  const label = (q3, id) => q3.options.find((o) => o.id === id)?.label || id;
  const lines = questions.map((q3) => {
    const x = a.answers?.[q3.id];
    let t = "(skipped)";
    if (x?.kind === "single") t = label(q3, x.option_id);
    else if (x?.kind === "multi") t = x.option_ids.map((id) => label(q3, id)).join(", ");
    else if (x?.kind === "other") t = x.text;
    else if (x?.kind === "multi_with_other") t = [...x.option_ids.map((id) => label(q3, id)), x.other_text].join(", ");
    return `- ${q3.question} \u2192 ${t}`;
  });
  run.ctx.patch(ev, { status: "done", output: lines.join("\n") });
  return { content: `The user answered:
${lines.join("\n")}`, isError: false };
}
async function planReview(run, ev, input) {
  const { session, ctx } = run;
  if (!session.meta?.planMode) {
    ctx.patch(ev, { status: "done" });
    return { content: "Plan mode is not on, so there is nothing to approve: go ahead with the work.", isError: false };
  }
  const a = await askUser(run, ev, { kind: "plan", plan: input.plan, options: PLAN_OPTIONS });
  if (!a) return interrupted(run, ev);
  if (a.optionId === "rejected") {
    ctx.patch(ev, { status: "denied" });
    return { content: `The user did not approve the plan.${a.feedback ? ` Their feedback: ${a.feedback}` : ""} You are still in plan mode: revise the plan and call ExitPlanMode again, or ask what they want changed.`, isError: false };
  }
  const permission = a.optionId === "plan:edits" ? "edits" : "manual";
  ctx.setMeta({ planMode: false, permission });
  st(session).toldPlan = false;
  ctx.patch(ev, { status: "done" });
  return { content: `The user approved the plan. Plan mode is off now${permission === "edits" ? ", and file edits no longer need their approval (commands still do)" : ""}. Carry out the plan.`, isError: false };
}
async function subagent(run, ev, input, { model, effort }) {
  const { session, ctx } = run;
  const id = `sub-${++run.subs}-${crypto6.randomBytes(3).toString("hex")}`;
  const sub = { id, name: "subagent", description: input.description, status: "running", model, effort };
  ctx.patch(ev, { status: "running", title: input.description, subagent: sub });
  const c = st(session);
  let out;
  try {
    out = await loop(run, {
      messages: [{ role: "user", content: input.prompt }],
      model,
      effort,
      main: false,
      scope: { parent: ev.id, agentId: id },
      system: c.subSystem || subSystemPrompt(session.cwd),
      tools: subTools(session, model)
    });
  } catch (err) {
    if (run.aborted) {
      ctx.patch(ev, { subagent: { ...ev.subagent, status: "cancelled" } });
      return interrupted(run, ev);
    }
    const text = explain(err);
    ctx.patch(ev, { status: "error", isError: true, output: text, subagent: { ...ev.subagent, status: "error", error: text } });
    return { content: `The subagent failed: ${text}`, isError: true };
  }
  if (out.halted) {
    ctx.patch(ev, { status: "error", subagent: { ...ev.subagent, status: "error", error: run.halted } });
    return { content: "Stopped.", isError: true };
  }
  if (out.aborted) {
    ctx.patch(ev, { subagent: { ...ev.subagent, status: "cancelled" } });
    return interrupted(run, ev);
  }
  const summary2 = out.finalText.trim();
  ctx.patch(ev, { status: "done", output: summary2, subagent: { ...ev.subagent, status: "done", summary: summary2 } });
  return { content: summary2 || "(The subagent finished without a report.)", isError: false };
}
async function interrupt(session) {
  const run = runs.get(session.id);
  if (!run) return;
  run.ac.abort();
  for (const resolve2 of [...run.waits.values()]) resolve2(null);
}
function steerQueued(session, promptId) {
  const q3 = queue(session).find((x) => x.promptId === promptId);
  if (!q3 || q3.steered) return;
  liveContext(session).setMeta({ queue: queue(session).map((x) => x.promptId === promptId ? { ...x, steered: true } : x) });
}
function cancelQueued(session, promptId) {
  queuedImages.delete(session, promptId);
  liveContext(session).setMeta({ queue: queue(session).filter((x) => x.promptId !== promptId) });
}
async function configure(session, { model, effort, permission, planMode }) {
  const f = {};
  if (typeof model === "string" && model) {
    f.model = model;
    const m = modelInfo(model);
    const e = session.meta?.effort;
    if (e && m.efforts.length && !m.efforts.includes(e)) f.effort = m.efforts.includes("high") ? "high" : m.defaultEffort || "";
  }
  if (typeof effort === "string" && effort) f.effort = effort;
  if (PERMISSIONS2.includes(permission)) f.permission = permission;
  if (typeof planMode === "boolean") f.planMode = planMode;
  if (!Object.keys(f).length) throw Object.assign(new Error("\u6C92\u6709\u8981\u8B8A\u66F4\u7684\u8A2D\u5B9A"), { status: 400 });
  liveContext(session).setMeta(f);
  return null;
}
async function command(session, name, args = "") {
  const ctx = liveContext(session);
  switch (name) {
    case "compact":
      await compact(session, args);
      return {};
    case "undo": {
      if (runs.has(session.id)) throw busyError();
      const c = st(session);
      const t = c.turns.at(-1);
      if (!t) throw Object.assign(new Error("\u6C92\u6709\u53EF\u4EE5\u64A4\u56DE\u7684\u5C0D\u8A71\uFF08\u58D3\u7E2E\u904E\u7684\u90E8\u5206\u4E0D\u80FD\u64A4\u56DE\uFF09"), { status: 400 });
      c.turns = c.turns.slice(0, -1);
      c.messages.length = Math.min(t.msg, c.messages.length);
      c.toldPlan = t.toldPlan ?? void 0;
      const i = session.events.findIndex((e) => e.id === t.event);
      if (i !== -1) ctx.replaceEvents(session.events.slice(0, i));
      saveSession(session, { immediate: true });
      return {};
    }
    case "fork": {
      const c = st(session);
      const copy = createSession({
        agentId: AGENT.id,
        cwd: session.cwd,
        ...session.machineId ? { machineId: session.machineId } : {},
        permissionMode: session.permissionMode,
        title: args || `${session.title}\uFF08\u8907\u88FD\uFF09`,
        titled: true,
        allowedTools: [...session.allowedTools || []],
        meta: { ...structuredClone(session.meta || {}), queue: [], turnModel: null, turnEffort: null, claudeUsage: null },
        state: { claude: { ...structuredClone(c), turns: [], usage: emptyUsage(), rates: [] } },
        events: structuredClone(session.events)
      });
      return { session: copy };
    }
    case "title":
      if (!args) throw Object.assign(new Error("\u5728 /title \u5F8C\u9762\u8F38\u5165\u65B0\u6A19\u984C"), { status: 400 });
      ctx.setTitle(args.slice(0, 120));
      return {};
    case "budget": {
      const a = String(args).trim().toLowerCase().replace(/^us\$|^\$/, "");
      if (["", "off", "\u95DC", "\u95DC\u9589", "0"].includes(a)) {
        ctx.setMeta({ budget: null });
        return {};
      }
      const n = Number(a);
      if (!Number.isFinite(n) || n <= 0 || n > 1e5) throw Object.assign(new Error("\u7528\u6CD5\uFF1A/budget 5\uFF08\u9019\u500B\u5C0D\u8A71\u6700\u591A\u82B1 US$5\uFF09\u3001/budget off"), { status: 400 });
      ctx.setMeta({ budget: Math.round(n * 100) / 100 });
      return {};
    }
    default:
      throw Object.assign(new Error(`\u6C92\u6709 /${name} \u9019\u500B\u6307\u4EE4`), { status: 400 });
  }
}
async function compact(session, instruction) {
  if (runs.has(session.id)) throw busyError();
  const why = cannotSend(session);
  if (why) throw Object.assign(new Error(why), { status: 409 });
  const c = st(session);
  repair(c);
  if (!c.messages.length) throw Object.assign(new Error("\u9084\u6C92\u6709\u5C0D\u8A71\u5167\u5BB9\u53EF\u4EE5\u58D3\u7E2E"), { status: 400 });
  const run = new Run(session);
  runs.set(session.id, run);
  const { ctx } = run;
  ctx.setStatus("running");
  const note = ctx.emit({ type: "info", text: "\u6B63\u5728\u58D3\u7E2E\u5C0D\u8A71\u5167\u5BB9\u2026" });
  const model = session.meta?.model || DEFAULT_MODEL;
  const opts = {
    messages: [...c.messages, { role: "user", content: COMPACT_PROMPT + (instruction ? `

Also: ${instruction}` : "") }],
    model,
    effort: session.meta?.effort || "",
    main: true,
    quiet: true,
    system: c.system,
    tools: mainTools(session, model),
    toolChoice: { type: "none" }
  };
  try {
    const r = await ask(run, opts);
    if (r.aborted) return ctx.patch(note, { text: "\u5DF2\u53D6\u6D88\u58D3\u7E2E" });
    count(run, opts, r);
    const summary2 = r.message.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    if (!summary2) throw new Error("Claude \u6C92\u6709\u5BEB\u51FA\u6458\u8981");
    const before = session.meta?.context?.used;
    c.messages = [{ role: "user", content: [{ type: "text", text: `${RESUME_PREFIX}

${summary2}` }] }];
    c.turns = [];
    c.toldPlan = void 0;
    const after = Math.round(summary2.length / 3);
    ctx.setMeta({ context: { used: after, size: modelInfo(model).context } });
    ctx.patch(note, { text: `\u5DF2\u58D3\u7E2E\u5C0D\u8A71${before ? `\uFF08context \u7D04 ${Math.round(before / 1e3)}k \u2192 ${Math.max(1, Math.round(after / 1e3))}k tokens\uFF09` : ""}\u3002\u4E0A\u9762\u7684\u5167\u5BB9\u4ECD\u7136\u770B\u5F97\u5230\uFF0CClaude \u4E4B\u5F8C\u53EA\u8A18\u5F97\u6458\u8981\u3002` });
  } catch (err) {
    ctx.patch(note, { text: "\u58D3\u7E2E\u5931\u6557" });
    throw Object.assign(new Error(explain(err)), { status: 502 });
  } finally {
    runs.delete(session.id);
    ctx.setStatus("idle");
    saveSession(session, { immediate: true });
    next(session);
  }
}
async function bindRepo(session, { full, branch }) {
  if (runs.has(session.id)) throw Object.assign(new Error("Claude \u6B63\u5728\u5DE5\u4F5C\uFF1A\u7B49\u9019\u4E00\u8F2A\u7D50\u675F\uFF08\u6216\u5148\u505C\u6B62\uFF09\u518D\u7D81\u5B9A"), { status: 409 });
  if (session.meta?.repo) throw Object.assign(new Error(`\u9019\u500B\u5C0D\u8A71\u5DF2\u7D93\u7D81\u5B9A ${session.meta.repo.full} \u7684 ${session.meta.repo.branch}\uFF0C\u4E0D\u80FD\u518D\u63DB`), { status: 409 });
  const host = hostFor(session);
  const c = st(session);
  const old = session.cwd;
  const origin = await host.run(old, "git config --get remote.origin.url", { timeoutMs: 15e3 }).catch(() => null);
  const same = origin?.exitCode === 0 && parseRepo(origin.output.trim())?.toLowerCase() === full.toLowerCase();
  if (same) await useBranch(host, old, { full, branch });
  else session.cwd = await clone(host, WORKSPACES_DIR, { full, branch });
  const repo = { full, branch };
  const platform = session.machineId ? getMachine(session.machineId)?.platform || "unknown" : `${os2.platform()} ${os2.release()}`;
  const notes = await projectNotes(host, session.cwd);
  const computer = session.meta?.machineName || machineName(session);
  c.system = systemPrompt(session.cwd, { platform, notes, git: true, computer, repo, started: session.createdAt });
  c.subSystem = subSystemPrompt(session.cwd, platform, repo);
  c.bindNote = same ? `The user has bound this conversation to the GitHub repository ${full}, branch \`${branch}\`, from now on. The working directory ${old} is already a clone of it and is now on \`${branch}\`. Follow the rules in the system prompt: commit what you have done so far that belongs to the task, push it to \`${branch}\`, and keep doing so.` : `The user has bound this conversation to the GitHub repository ${full}, branch \`${branch}\`, from now on. It was cloned into ${session.cwd}, which is your working directory from now on (it was ${old}, which is unchanged; your earlier work is still there). First bring over into the repository what belongs to the user's task from ${old} (code, docs, configs; not secrets, data dumps, build output or tool caches), commit it with a clear message and push it to \`${branch}\`; tell the user briefly what you brought over and what you left out. Then follow the rules in the system prompt.`;
  liveContext(session).setMeta({ repo: { ...repo, url: `https://github.com/${full}/tree/${branch}` } });
  liveContext(session).emit({
    type: "info",
    text: same ? `\u5DF2\u7D81\u5B9A ${full} \u7684 ${branch}\uFF1A\u8CC7\u6599\u593E\u672C\u4F86\u5C31\u662F\u9019\u500B repo\uFF0C\u5DF2\u5207\u5230 ${branch}\u3002\u4E4B\u5F8C\u7684\u7A0B\u5F0F\u78BC\u90FD\u6703 commit \u4E26 push \u5230\u90A3\u88E1\u3002` : `\u5DF2\u7D81\u5B9A ${full} \u7684 ${branch}\uFF1Arepo clone \u5230 ${session.cwd}\uFF0C\u9019\u500B\u5C0D\u8A71\u4E4B\u5F8C\u5728\u90A3\u88E1\u5DE5\u4F5C\uFF08\u539F\u672C\u7684\u8CC7\u6599\u593E ${old} \u4FDD\u6301\u4E0D\u52D5\uFF09\u3002\u4E0B\u4E00\u8F2A Claude \u6703\u5148\u628A\u5C6C\u65BC\u9019\u500B\u5C08\u6848\u7684\u6A94\u6848\u642C\u9032 repo\uFF0Ccommit \u4E26 push\u3002`
  });
  saveSession(session, { immediate: true });
  return { cwd: session.cwd, moved: !same };
}
async function listFiles(session, rel = ".") {
  const host = hostFor(session);
  const { files } = await host.walk(session.cwd, rel, 2e3);
  const base = rel === "." ? "" : `${rel.replace(/\/$/, "")}/`;
  const seen = /* @__PURE__ */ new Map();
  for (const [r] of files) {
    const [first, ...more] = r.split("/");
    if (!seen.has(first)) seen.set(first, { name: first, path: `${base}${first}`, dir: more.length > 0 });
  }
  return [...seen.values()].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}
async function readFile2(session, rel) {
  const f = await hostFor(session).read(session.cwd, rel);
  if (f.size > 2 * 1024 * 1024) return { path: rel, size: f.size, tooLarge: true };
  const binary = f.buf.subarray(0, 8e3).includes(0);
  return { path: rel, size: f.size, binary, content: binary ? "" : f.buf.toString("utf8") };
}
async function getChanges(session, summarize) {
  const host = hostFor(session);
  const r = await host.run(
    session.cwd,
    "git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo __NOGIT__; exit 0; }; git diff HEAD --no-color --no-ext-diff 2>/dev/null; git ls-files --others --exclude-standard -z | head -z -n 100 | xargs -0 -r -I{} git diff --no-color --no-index -- /dev/null {}; exit 0",
    { timeoutMs: 6e4 }
  );
  if (r.output.includes("__NOGIT__")) return { git: false, files: [], diff: "" };
  const diff = r.output === "(no output)" ? "" : `${r.output.replace(/\n\[[^\]]*\]$/, "")}
`;
  return { git: true, files: summarize(diff), diff };
}
function restore(session) {
  let changed = false;
  for (const ev of session.events) {
    if (ev.permission && !ev.permission.chosen) {
      ev.permission = { ...ev.permission, chosen: "cancelled" };
      changed = true;
    }
    if (ev.type === "tool_use" && ["pending", "running", "awaiting"].includes(ev.status)) {
      ev.status = "interrupted";
      changed = true;
    }
    if (ev.subagent?.status === "running") {
      ev.subagent = { ...ev.subagent, status: "cancelled" };
      changed = true;
    }
  }
  const meta = session.meta || {};
  if (meta.turnModel || meta.turnEffort) {
    meta.turnModel = null;
    meta.turnEffort = null;
    changed = true;
  }
  const c = st(session);
  const wasWorking = Boolean(c.active);
  if (wasWorking) {
    c.active = null;
    c.restarted = true;
    session.events.push({ id: newId("e_"), ts: Date.now(), type: "turn_end", durationMs: 0, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, interrupted: true, restarted: true });
    changed = true;
  }
  if (changed) saveSession(session);
  if (wasWorking || meta.queue?.length) resumeLater(session, wasWorking);
}
function resumeLater(session, wasWorking, tries = 0) {
  const t = setTimeout(() => {
    if (getSession(session.id) !== session || runs.has(session.id)) return;
    if (cannotSend(session)) {
      if (tries < 120) resumeLater(session, wasWorking, tries + 1);
      else if (queue(session).length) liveContext(session).emit({ type: "info", text: "\u4E2D\u63A7\u53F0\u91CD\u65B0\u555F\u52D5\u5F8C\u4E00\u76F4\u6C92\u8FA6\u6CD5\u63A5\u8457\u505A\uFF08\u96FB\u8166\u96E2\u7DDA\u6216\u6C92\u6709 API key\uFF09\uFF0C\u6392\u968A\u4E2D\u7684\u8A0A\u606F\u9084\u5728\uFF0C\u53EF\u4EE5\u81EA\u5DF1\u9001\u51FA\u300C\u7E7C\u7E8C\u300D" });
      return;
    }
    if (wasWorking && st(session).restarted) startTurn(session, { resume: true });
    else next(session);
  }, tries ? 5e3 : 1500);
  t.unref?.();
}
function dispose(session) {
  for (const q3 of queue(session)) queuedImages.delete(session, q3.promptId);
  interrupt(session);
  modelsAt.delete(session.id);
}
var live, AGENT, PERMISSIONS2, MAX_STEPS, SUB_STEPS, SUB_TOOLS, SERVER_TOOLS, APPROVAL_OPTIONS, PLAN_OPTIONS, COMPACT_PROMPT, RESUME_PREFIX, liveContext, runs, queuedImages, RESTART_NOTE, hostFor, machineName, emptyUsage, queue, fmtUsd, modelsAt, Run, imageBlock, mainTools, subTools, interrupted, busyError, isRunning;
var init_claude = __esm({
  "server/adapters/claude.js"() {
    init_store();
    init_machines();
    init_claude_account();
    init_claude_tools();
    init_claude_repo();
    live = true;
    AGENT = { id: "claude", name: "Claude", type: "claude", enabled: true };
    PERMISSIONS2 = ["manual", "edits", "auto"];
    MAX_STEPS = 200;
    SUB_STEPS = 100;
    SUB_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep"];
    SERVER_TOOLS = { web_search: "WebSearch", web_fetch: "WebFetch", code_execution: "CodeExecution", bash_code_execution: "CodeExecution", text_editor_code_execution: "CodeExecution" };
    APPROVAL_OPTIONS = [
      { optionId: "approved", name: "\u5141\u8A31", kind: "allow_once" },
      { optionId: "approved_session", name: "\u9019\u500B\u5C0D\u8A71\u90FD\u5141\u8A31", kind: "allow_always" },
      { optionId: "rejected", name: "\u62D2\u7D55", kind: "reject_once" }
    ];
    PLAN_OPTIONS = [
      { optionId: "plan:edits", name: "\u540C\u610F\uFF0C\u81EA\u52D5\u63A5\u53D7\u7DE8\u8F2F", label: "\u540C\u610F\uFF0C\u81EA\u52D5\u63A5\u53D7\u7DE8\u8F2F", description: "\u958B\u59CB\u5BE6\u4F5C\uFF1A\u4FEE\u6539\u6A94\u6848\u4E0D\u518D\u8A62\u554F\uFF0C\u57F7\u884C\u6307\u4EE4\u524D\u4ECD\u6703\u554F\u4F60" },
      { optionId: "plan:manual", name: "\u540C\u610F\uFF0C\u6BCF\u6B21\u8A62\u554F", label: "\u540C\u610F\uFF0C\u6BCF\u6B21\u8A62\u554F", description: "\u958B\u59CB\u5BE6\u4F5C\uFF1A\u6BCF\u500B\u4FEE\u6539\u8207\u6307\u4EE4\u90FD\u5148\u554F\u4F60" }
    ];
    COMPACT_PROMPT = "Write a summary of our conversation so far, so the work can continue in a fresh context from it alone. Cover: what the user asked for and their goals and preferences; decisions made and why; what has been done (files created or changed, commands run, their results); the current state; open problems; and the next steps. Keep exact file paths, names, commands and error messages that matter. Write it in the language the user writes in. Reply with the summary only.";
    RESUME_PREFIX = "This conversation continues from an earlier part that was summarized to save context. The summary:";
    liveContext = null;
    runs = /* @__PURE__ */ new Map();
    queuedImages = {
      get: (session, id) => st(session).queuedImages?.[id],
      set: (session, id, images) => st(session).queuedImages = { ...st(session).queuedImages || {}, [id]: images },
      delete: (session, id) => {
        if (st(session).queuedImages) delete st(session).queuedImages[id];
      }
    };
    RESTART_NOTE = "Agent Hub restarted while you were working, so your last turn was cut off: a tool call that had not finished was not run (or its result was lost), and subagents that were running were stopped. Check where things stand (files, processes you started), then continue the task from there.";
    hostFor = (session) => session.machineId ? remoteHost(session.machineId) : localHost;
    machineName = (session) => session.machineId ? getMachine(session.machineId)?.name || "\u90A3\u53F0\u96FB\u8166" : os2.hostname();
    emptyUsage = () => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, searches: 0, requests: 0, cost: 0 });
    queue = (session) => session.meta?.queue || [];
    fmtUsd = (n) => n >= 1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(3) : n.toFixed(4);
    modelsAt = /* @__PURE__ */ new Map();
    Run = class {
      constructor(session) {
        this.session = session;
        this.ctx = liveContext(session);
        this.ac = new AbortController();
        this.waits = /* @__PURE__ */ new Map();
        this.usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
        this.started = Date.now();
        this.firstEvent = session.events.length;
        this.subs = 0;
      }
      get aborted() {
        return this.ac.signal.aborted;
      }
    };
    imageBlock = (i) => ({ type: "image", source: { type: "base64", media_type: i.mimeType, data: i.data } });
    mainTools = (session, model) => [...apiTools(), ...st(session).web ? webTools(model) : []];
    subTools = (session, model) => [...apiTools(SUB_TOOLS), ...st(session).web ? webTools(model) : []];
    interrupted = (run, ev) => {
      if (ev) run.ctx.patch(ev, { status: "interrupted" });
      return { content: "Interrupted by the user.", isError: true };
    };
    busyError = () => Object.assign(new Error("Claude \u6B63\u5728\u5DE5\u4F5C\uFF0C\u7B49\u9019\u4E00\u8F2A\u7D50\u675F\u518D\u8A66"), { status: 409 });
    isRunning = (session) => runs.has(session.id);
  }
});

// server/claude-daemon.js
import fs10 from "node:fs";
import path10 from "node:path";
import http from "node:http";
import crypto7 from "node:crypto";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var argv = process.argv.slice(2);
var DIR = path10.resolve(argv[argv.indexOf("--dir") + 1] || path10.join(process.env.HOME || ".", ".agent-hub", "claude"));
fs10.mkdirSync(DIR, { recursive: true, mode: 448 });
process.env.AGENT_HUB_DATA = DIR;
process.env.AGENT_HUB_WORKSPACES ||= path10.join(process.env.HOME || DIR, "agent-hub-workspaces");
var store = await Promise.resolve().then(() => (init_store(), store_exports));
var account = await Promise.resolve().then(() => (init_claude_account(), claude_account_exports));
var claude = await Promise.resolve().then(() => (init_claude(), claude_exports));
var SELF = fileURLToPath2(import.meta.url);
var VERSION2 = crypto7.createHash("sha1").update(fs10.readFileSync(SELF)).update(process.env.AGENT_HUB_DAEMON_VERSION || "").digest("hex").slice(0, 12);
var clients = /* @__PURE__ */ new Set();
function publish(msg) {
  const line = `data: ${JSON.stringify(msg)}

`;
  for (const res of clients) res.write(line);
}
var summary = (s) => ({
  id: s.id,
  title: s.title,
  titled: s.titled,
  status: s.status,
  cwd: s.cwd,
  meta: s.meta,
  usage: s.usage,
  allowedTools: s.allowedTools,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt
});
var snapshot = (s) => ({ ...summary(s), seq: s.seq || 0, events: s.events });
function touch(s) {
  s.seq = (s.seq || 0) + 1;
  store.saveSession(s);
  return s.seq;
}
function liveContext2(session) {
  const changed = () => {
    store.saveSession(session);
    publish({ t: "session", sid: session.id, seq: session.seq || 0, session: summary(session) });
  };
  return {
    session,
    emit(fields) {
      const ev = { id: store.newId("e_"), ts: Date.now(), ...fields };
      session.events.push(ev);
      publish({ t: "event", sid: session.id, seq: touch(session), ev });
      return ev;
    },
    patch(ev, fields) {
      Object.assign(ev, fields);
      if (!ev.id) return;
      publish({ t: "patch", sid: session.id, seq: touch(session), id: ev.id, fields });
    },
    delta(ev, text, field = "text") {
      if (!text) return;
      ev[field] = (ev[field] || "") + text;
      publish({ t: "delta", sid: session.id, seq: touch(session), id: ev.id, field, text });
    },
    setStatus(status) {
      if (session.status === status) return;
      session.status = status;
      changed();
    },
    setMeta(fields) {
      session.meta = { ...session.meta || {}, ...fields };
      changed();
    },
    setTitle(title) {
      if (!title || title === session.title) return;
      session.title = title;
      session.titled = true;
      changed();
    },
    replaceEvents(events) {
      session.events = events;
      publish({ t: "reset", sid: session.id, seq: touch(session) });
    }
  };
}
claude.init(liveContext2);
store.loadSessions();
for (const s of store.listSessions()) claude.restore(s);
var must = (id) => {
  const s = store.getSession(String(id || ""));
  if (!s) throw Object.assign(new Error("\u627E\u4E0D\u5230\u9019\u500B Claude \u5C0D\u8A71"), { status: 404 });
  return s;
};
function applyAuth(auth) {
  if (!auth) return;
  if (auth.apiKey && auth.apiKey !== account.apiKey()) account.setKey(auth.apiKey);
  if (auth.settings) account.setSettings(auth.settings);
}
var OPS = {
  async create({ id, cwd, title, config, permissionMode }) {
    if (store.getSession(id)) return snapshot(store.getSession(id));
    if (!config?.repo && !fs10.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw Object.assign(new Error(`\u8CC7\u6599\u593E\u4E0D\u5B58\u5728\uFF1A${cwd}`), { status: 400 });
    const s = store.createSession({ id, agentId: "claude", cwd: cwd || "", permissionMode: permissionMode || "ask", title: title || "\u65B0\u5C0D\u8A71" });
    try {
      await claude.setup(s, config || {});
    } catch (err) {
      store.deleteSession(s.id);
      throw err;
    }
    publish({ t: "session", sid: s.id, seq: s.seq || 0, session: summary(s) });
    return snapshot(s);
  },
  // A conversation the hub ran itself before there was a daemon.
  import({ session }) {
    if (store.getSession(session.id)) return snapshot(store.getSession(session.id));
    const { machineId, ...rest } = session;
    const s = store.createSession({ ...rest, agentId: "claude" });
    claude.restore(s);
    return snapshot(s);
  },
  snapshot: ({ id }) => snapshot(must(id)),
  list: () => store.listSessions().map(summary),
  // With the conversation's state right after: the hub shows it at once,
  // unless its stream has already brought something newer.
  async send({ id, text, images, note, steer }) {
    const s = must(id);
    const r = await claude.send(s, String(text ?? ""), { images: images || [], note, steer });
    return { ...r, status: s.status, seq: s.seq || 0 };
  },
  interrupt: ({ id }) => claude.interrupt(must(id)),
  respond: ({ id, eventId, optionId, extra }) => claude.respond(must(id), eventId, String(optionId ?? ""), extra || {}),
  configure: ({ id, change }) => claude.configure(must(id), change || {}),
  async command({ id, name, args }) {
    const r = await claude.command(must(id), String(name || ""), String(args ?? "")) || {};
    if (r.session) {
      publish({ t: "session", sid: r.session.id, seq: r.session.seq || 0, session: summary(r.session) });
      return { session: snapshot(r.session) };
    }
    return {};
  },
  // Bound to a GitHub repository from now on (see claude.bindRepo).
  async bindRepo({ id, repo }) {
    const s = must(id);
    const r = await claude.bindRepo(s, { full: String(repo?.full || ""), branch: String(repo?.branch || "") });
    publish({ t: "session", sid: s.id, seq: s.seq || 0, session: summary(s) });
    return r;
  },
  steerQueued: ({ id, promptId }) => claude.steerQueued(must(id), promptId),
  cancelQueued: ({ id, promptId }) => claude.cancelQueued(must(id), promptId),
  title({ id, title }) {
    liveContext2(must(id)).setTitle(String(title || "").slice(0, 120));
  },
  delete({ id }) {
    const s = store.getSession(String(id || ""));
    if (!s) return;
    claude.dispose(s);
    store.deleteSession(s.id);
    publish({ t: "deleted", sid: s.id });
  },
  models: () => account.models(),
  test: () => account.models({ fresh: true })
};
var TOKEN = crypto7.randomBytes(24).toString("hex");
var running = () => store.listSessions().filter((s) => claude.isRunning(s)).map((s) => s.id);
var server = http.createServer(async (req, res) => {
  const send2 = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const token = req.headers["x-daemon-token"] || "";
  if (token.length !== TOKEN.length || !crypto7.timingSafeEqual(Buffer.from(token), Buffer.from(TOKEN))) return send2(401, { ok: false, error: "bad token" });
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname === "/health") return send2(200, { ok: true, version: VERSION2, pid: process.pid, running: running() });
  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(": hello\n\n");
    clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 2e4);
    req.on("close", () => (clearInterval(ping), clients.delete(res)));
    return;
  }
  if (req.method === "POST" && url.pathname === "/rpc") {
    let raw = "";
    req.on("data", (d) => raw += d);
    req.on("end", async () => {
      try {
        const { op, args = {} } = JSON.parse(raw || "{}");
        if (!Object.hasOwn(OPS, op)) return send2(404, { ok: false, error: `Claude \u80CC\u666F\u7A0B\u5F0F\u4E0D\u8A8D\u5F97\u9019\u500B\u64CD\u4F5C\uFF1A${op}`, status: 400 });
        applyAuth(args.auth);
        send2(200, { ok: true, data: await OPS[op](args) ?? null });
      } catch (err) {
        send2(200, { ok: false, error: err.message || String(err), status: err.status || 500 });
      }
    });
    return;
  }
  send2(404, { ok: false, error: "not found" });
});
server.listen(0, "127.0.0.1", () => {
  const file = path10.join(DIR, "daemon.json");
  const tmp = `${file}.${process.pid}.tmp`;
  fs10.writeFileSync(tmp, JSON.stringify({ port: server.address().port, token: TOKEN, pid: process.pid, version: VERSION2 }), { mode: 384 });
  fs10.renameSync(tmp, file);
  console.log(`[claude-daemon] ${VERSION2} listening on 127.0.0.1:${server.address().port} (${DIR})`);
});
function shutdown() {
  store.flushAll();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
export {
  VERSION2 as VERSION
};
