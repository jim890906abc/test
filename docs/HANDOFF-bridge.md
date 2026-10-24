# Bridge layer handoff (bridge 0.9.0)

Scope done: `bridge/agent-hub-bridge.mjs`, `test/bridge-hub-models.test.mjs`,
`test/fixtures/fake-kimi-config.mjs`, small edits in `test/bridge-deepseek.test.mjs` and
`test/e2e-kimi-bridge.test.mjs`. Nothing under `server/` or `public/` was touched.
Commit: `389a773` (bridge + tests). The README is not updated (hub/UI side).

## Done and verified

Verified on a REAL Kimi 2.1.1 server (npm package, temp `KIMI_CODE_HOME`, scripted
OpenAI-compatible gateway, fake Anthropic API, the real bridge behind a fake hub socket;
scripts in the session scratchpad `uni/rp1.mjs`, `rp3.mjs`, `rp-lib.mjs`):

- `kimi.hub.provision` for DeepSeek and for Claude; `kimi.hub.remove`; both providers coexist.
- The pool: Agent AND AgentSwarm get a `model` argument; the Agent description lists
  "Available models" with our descriptions and `primary`.
- A subagent on a DeepSeek alias really hits the gateway (`/opencode-go/v1/chat/completions`,
  model `deepseek-v4.1-flash`, `reasoning_effort: max`, the key, the session header).
- A subagent on a Claude alias sends a well-formed `POST /v1/messages?beta=true`: x-api-key,
  anthropic-version 2023-06-01, `anthropic-beta: context-management-2025-06-27`, adaptive
  thinking (summarized), `output_config.effort` from default_effort, max_tokens 128000,
  stream true, cache_control (ephemeral) on the system prompt, the last tool and the last
  message block (prompt caching works), plus Kimi's `context_management` clear_thinking edit.
- Wire: `subagent.spawned` payload has `model` (alias) and `thinkingEffort`.
- Merge with a user pool, removal of only the hub's entries, whole-section removal when the
  hub made it, `force` left alone, legacy single `model` pool, restore when Kimi does not
  re-read the file (`[watch] enabled = false`), a stale user entry tolerated.
  config.toml tables are identical to the original after everything is removed
  (Kimi itself regroups tables and adds blank lines whenever it writes; the guard compares
  tables line by line, order- and blank-insensitive).
- e2e with the real Kimi (`KIMI_BIN` = a wrapper that execs `node .../dist/main.mjs`):
  `test/e2e-kimi-bridge.test.mjs` 22/22 (incl. the guess-lock removal and a stale `/steer`
  assertion fixed).

Faked only: Anthropic and the gateways (no real keys), the subscription (a plain provider
named `managed:kimi-code` pointing at the fake gateway; no OAuth login).

## Effort finding (Kimi 2.1.1)

A subagent's thinking is per MODEL or global, never per call or per session
(`planSpawn`: `thinking = resolveSubagentThinking(config, model, binding.thinking)`).
- `primary` (also "no pool" and `fork`): the main agent's current thinking.
- a pool alias: `[secondary_model].default_effort` (GLOBAL for the whole pool; Kimi requires
  every pool model to support it, so it is unusable with a mixed pool; the bridge only
  respects it: models that do not take it are not added, with a warning).
- else the model entry's `default_effort` (`[models."<alias>"].default_effort`, honored only
  if in `support_efforts`); else Kimi's usual default (`[thinking].effort`, else the middle of
  `support_efforts`; DeepSeek [low,high,max] would think at "high", not "max").
- The provider REST API cannot carry `default_effort`; the bridge writes it with
  `POST /api/v1/config {models: {alias: {default_effort}}}`. `PUT /providers` (re-provision)
  loses it: always re-send `kimi.subagents.sync` after `kimi.hub.provision`.
- With a pool in place, an Agent call that names NO `model` uses the pool's `default_model`
  (Kimi's global default = the subscription), not the main model. The hidden per-chat note must
  always say `model: "primary"` or `model: "<alias>"`.
So the honest UI: subagent model "same as main" -> effort follows the chat; an
`agent-hub-*` alias -> that model's subagent effort (shared by all chats and computers);
Kimi subscription models -> Kimi decides; no per-chat subagent effort control.

## The contract

Hub gates the generic ops on the bridge's hello `bridgeVersion >= 0.9.0`.

- `kimi.hub.provision {provider: 'deepseek'|'claude', gateway? (deepseek only: opencode-go |
  opencode | commandcode), apiKey, models: [{model, max_context_size, max_output_size?,
  display_name?, capabilities?, support_efforts?, adaptive_thinking?}]}`
  -> `{ok, created, models: [alias], sessionHeader? (deepseek), warning?, secondaryModel?}`.
  Provider ids are fixed: `agent-hub-deepseek`, `agent-hub-claude`; aliases are
  `<provider id>/<model id>`. Claude: type `anthropic`, base `https://api.anthropic.com` fixed
  in the bridge (no /v1), key must match `sk-ant-` and not `-oat/-ort/-admin`.
  capabilities: `thinking`, `always_thinking`, `tool_use`, `image_in`.
  efforts: `low medium high xhigh max` (never `off`/`on`: a model without `always_thinking`
  gets an "off" choice in Kimi). 1 to 40 models.
  Same guard as before: empty default pinned to the subscription first, default / default_provider /
  [thinking] / [secondary_model] re-read after the write and restored, other tables compared.
- `kimi.hub.remove {provider}` -> `{ok, removed, poolRemoved?}` (takes the provider's models out of
  the pool first; refuses while a hub model is Kimi's default).
- `kimi.deepseek.provision` / `.remove`: aliases of the above (provider 'deepseek').
- `kimi.subagents.sync {models: {alias: description (<=400 chars, one line)}, efforts?: {alias: effort}}`
  -> `{ok, pool: {defaultModel, models: [alias]} | null, merged, efforts: {alias: effort written},
  added[], removed[], unchanged?, warning?}`; `skipped: 'force'` (pool null, warning) when the user's
  Kimi has `[secondary_model] force`. `{models: {}}` removes only the hub's entries (and the whole
  section if the hub created it). Aliases Kimi does not have are left out with a `warning`
  (provision first, then sync). `efforts`: only `agent-hub-*` aliases, only levels in the model's
  `support_efforts`; other aliases are passed over. Errors: `子代理模型沒有設定，已還原：…`
  (config.toml is back as it was). The pool's `default_model` = Kimi's global default (a user's own
  default is kept). Never `force`. Bridge state `STATE.pools[KIMI_HOME] = {owned[], defaultWritten}`
  in `~/.agent-hub/bridge.json`.
- Terminal lock: a conversation a terminal Kimi only MIGHT have open is no longer reported as
  `owner: 'tui'` / `guess` (now `owner: null`); the hub drives it through the Kimi server. Only an
  exact match (the terminal Kimi wrote it) keeps the terminal path. The hub/UI should drop the
  "guess" note (`meta.guess` is never set now).
- Test hooks (loopback only): `AGENT_HUB_DEEPSEEK_TEST_URL` (gateway base = `<url>/<gateway>/v1`),
  `AGENT_HUB_CLAUDE_TEST_URL`.

## Left / not done

- Hub (`server/*`) and UI (`public/*`) are the other agents' work; README not updated.
- Not verified: a real Anthropic key / real Kimi subscription login. Kimi sends the
  `context-management-2025-06-27` beta and a `clear_thinking_20251015` edit on every Anthropic
  request; if Anthropic rejects that for some model, it is Kimi's behaviour and cannot be changed
  from the bridge.
- The pool op never creates a probe session; Kimi 2.1.1 does not reject a pool with a stale alias
  at session start (checked), the bridge validates the pool itself before writing.

## Test status

- `node --test test/bridge-hub-models.test.mjs`: 22 pass. `bridge-deepseek` + `bridge-journal` +
  `bridge-quota`: 20 pass.
- Mutation spot-check (each caught by exactly the expected tests): ignoring the user's pool
  entries, no restore on failure, provider removal not cleaning the pool, ignoring `force`,
  always writing the default.
- Full `npm test` on this tree: 196 tests, 172 pass, 1 fail, 23 skipped. The one failure was
  `e2e-claude` "the sidebar has every Claude conversation ..." (Claude daemon adoption after a hub
  restart; nothing the bridge does is involved). It passed on the baseline commit once, failed
  twice here (once in the full run, once in a file run) and then passed on a later file run:
  treat it as flaky until shown otherwise. `npm run check` passes.
