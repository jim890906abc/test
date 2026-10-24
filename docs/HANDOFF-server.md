# Hub server handoff: one kind of conversation for every model

Branch `worktree-agent-a69cbfe8f8454c2ac` (worktree `/home/user/test/.claude/worktrees/agent-a69cbfe8f8454c2ac`), based on 2f59206. Server and server tests only; `bridge/*` and `public/*` untouched.

## Done

- `server/providers.js` (new): `familyOf(alias)`, `sessionFamily(session)`, `ensureProviders(machineId, {need, purge})`, `refreshAll`, `poolState`, `catalog`, `claudeKimiModel`. Provision order is always providers first, then `kimi.subagents.sync` (models + efforts), and the sync is re-sent after every provision. Cached by signature. Runs on bridge hello (if Kimi's server runs), on key/model/settings changes, before creating a conversation, and before a prompt is sent.
- Bridge gate: hello `bridgeVersion >= 0.9.0` uses `kimi.hub.provision|remove` and `kimi.subagents.sync`. Older bridges keep only `kimi.deepseek.provision|remove`: DeepSeek works, no pool, Claude refused with 409 saying the 連接器 must be re-run.
- Unified create/config/summarize/autopause/settings, hidden subagent note, subagent card truth, old sessions (see below).
- `server/deepseek-account.js` lost `ensureProvider/reprovision/removeProviders/forgetProvider` (moved to providers.js). `claude-account.js` is untouched on purpose: it is bundled into `bridge/claude-daemon.mjs`, which cannot be rebuilt here (no esbuild), so `kimiModel` for Claude lives in `providers.claudeKimiModel`.

## API (exact shapes)

`GET /api/models?machineId=<id>` (machineId optional)
```json
{ "sources": [
    { "id": "kimi", "label": "Kimi", "billing": "Kimi 訂閱", "ready": true, "note": "only when not ready", "defaultModel": "<kimi global default alias>",
      "models": [{ "id": "<alias>", "name": "K3-256k", "efforts": ["off","low","high"], "defaultEffort": null, "image": true, "context": 262144, "family": "kimi" }] },
    { "id": "deepseek", "label": "DeepSeek", "billing": "OpenCode Go 的 API key", "gateway": { "id": "opencode-go", "label": "OpenCode Go" }, "ready": true, "defaultModel": "agent-hub-deepseek/deepseek-v4.1-flash",
      "models": [{ "id": "agent-hub-deepseek/deepseek-v4-pro", "name": "DeepSeek V4 Pro", "efforts": ["low","high","max"], "defaultEffort": "max", "image": false, "context": 1000000, "family": "deepseek", "deepseek": true, "subagentEffort": "max" }] },
    { "id": "claude", "label": "Claude", "billing": "Claude Console 的 API key（按量計費）", "ready": false, "note": "「X」的連接器太舊，不支援 Claude 模型和子代理模型。在那台電腦重新執行連接指令（左下角「連接電腦…」）後再試。", "defaultModel": "agent-hub-claude/claude-opus-5-5",
      "models": [{ "id": "agent-hub-claude/claude-opus-5-5", "name": "Claude Opus 5.5", "efforts": ["low","medium","high","xhigh","max"], "defaultEffort": "medium", "image": true, "context": 1000000, "family": "claude", "subagentEffort": null }] }
  ],
  "subagentEffortScope": "per-model",
  "subagents": { "available": true, "reason": null, "synced": true, "pool": ["<alias>", "..."], "warning": null } }
```
`deepseek` / `claude` sources are present only when their key exists; `kimi` always. `subagentEffortScope` is `"per-model"` or `"none"` (never `"global"`); `none` and `subagents.available:false` mean old connector or the user's Kimi has `[secondary_model].force` (`reason` says which). Family of an alias: prefix `agent-hub-deepseek/` is deepseek, `agent-hub-claude/` is claude, anything else kimi. A WebSocket message `{ "t": "models", "machineId": "<id>" }` means: ask `/api/models` again.

`POST /api/sessions`
```json
{ "machineId": "m1", "cwd": "/path", "prompt": "…", "model": "<any alias>", "effort": "max", "permission": "manual", "planMode": false, "subagent": { "model": "<alias>" } }
```
`subagent.model` is an alias or `"primary"` (the main model); default is `settings.defaults.subagentModel`. No `agent` (or `"kimi"`) means a Kimi conversation. `agent:"deepseek"` still works (gateway's own model id accepted); `agent:"claude"` is still the old daemon. A DeepSeek/Claude model without a key is 409; Claude on an old bridge is 409 with the 連接器 text.

`POST /api/sessions/:id/config` accepts `{ model, effort, permission, planMode, subagent: { model } }`. Any model may be switched to; on a change of family an info event is emitted, e.g. `改用 DeepSeek V4.1 Flash：之後的回合算在 OpenCode Go 的 API key，不用 Kimi 訂閱` (to Kimi: `…算在 Kimi 訂閱`). A subagent change emits `子代理改用 X（下一則訊息起生效；算在 …）`.

Session summary adds: `"family": "kimi"|"deepseek"|"claude"|null`, `"subagent": { "model": "primary"|"<alias>" }|null` (null for non-Kimi agents; old Claude daemon sessions have family `claude`). `mode:"deepseek"` is kept (deprecated) while family is deepseek.

`PUT /api/settings`
```json
{ "defaults": { "model": "<any alias or ''>", "effort": "", "permission": "manual", "planMode": false, "subagentModel": "primary" }, "subagentEfforts": { "<deepseek/claude alias>": "low|medium|high|xhigh|max" } }
```
Returns the same shape with `subagentModel` defaulting to `primary` and `subagentEfforts` cleaned (Kimi aliases dropped). `subagentEfforts` are global per model alias (Kimi has no per-chat effort); DeepSeek models default to `max` when unset. `GET /api/config` returns the same under `settings`. A DeepSeek/Claude default main model is applied only to conversations made from the hub, never to Kimi's global default and never to a conversation opened from Kimi.

Subagent cards: `tool_use.subagent` gains `model` (alias), `effort`, `family`, `onMain` (true when it ran on the main model). Autopause routes refuse enabling/resume unless the current model's family is kimi (`enabled:false` is still allowed).

## Hidden subagent note

Sent in a `<system-reminder>` on the first hub prompt, and again when the conversation's subagent setting or its main model changes. It always names the model (`model: "primary"` or the alias), because once the pool exists an Agent call without `model` runs on the Kimi default. Not sent when the computer has no pool (old bridge, force). If the chosen alias is not in the computer's pool, it is never named: an info line `子代理模型 X 還沒在這台電腦的 Kimi 設定好，子代理先跟主模型一樣` is shown and the `primary` note is sent instead (a deliberate deviation from "send nothing", so subagents cannot silently fall to the subscription model; flip in `Mirror.subagentNote` if unwanted).

## Left / open

- Bridge 0.9.0 itself is the bridge agent's; the server was only tested against fakes of its contract (`kimi.hub.provision`, `kimi.hub.remove`, `kimi.subagents.sync`, `subagent.spawned.model/thinkingEffort`).
- Autopause ignores subagents that run on the Kimi subscription while the main model is DeepSeek/Claude (spec: gate by main model only).
- Warnings about missing subagent aliases are in-memory (repeat once after a hub restart).
- `docs/` and README still describe the three modes; `public/*` must stop using `agent:'deepseek'`/`mode`.
- If `claudeKimiModel` should live in `claude-account.js`, run `npm run build:daemon` and commit `bridge/claude-daemon.mjs` with it.

## Tests

`npm run check` passes. `npm test`: 202 tests, 176 pass, 3 fail, 23 skipped. The 3 failures (`e2e-claude`: daemon download 404) fail on the base commit too, because the worktree path contains `.claude` and express `sendFile` refuses dot-directories; they are not related to this work. New: `test/providers.test.mjs`, `test/e2e-models.test.mjs`; updated: `test/e2e-deepseek.test.mjs`, `test/deepseek-account.test.mjs`. Spot-checked: removing the hidden note, the sync-after-provision, the hello sync, the family gate on autopause, cross-source configure, the subagent card meta and the missing-alias guard each make tests fail.
