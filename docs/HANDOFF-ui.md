# UI handoff: one conversation, many models, 配色 (public/* + README.md)

Branch `worktree-agent-a31570ae140777a1c` (based on 2f59206). Touches only `public/*`, `README.md`, this file.

## Done
- Home: the Kimi / Claude API / DeepSeek switch is gone. One composer: machine, folder, permission, model, effort, 子代理 pill.
  The title and hint follow the family of the chosen main model (要讓 Kimi / Claude / DeepSeek 做什麼？).
- Model menus (home + conversation) are grouped by source (Kimi 訂閱 / DeepSeek（gateway） / Claude API) with a billing tag; a source that is
  not set up is one 「設定…」 row (opens its key dialog). With a single source: no header, no tag, ids shown (as before).
- 子代理 pill + menu (home, conversation; hidden for old Claude-daemon conversations). Model only; a muted line under the menu says where the
  thinking comes from (思考強度跟主模型 / 思考強度：max（依模型設定，在「設定」改） / 思考強度由 Kimi 決定 / 子代理用模型自己的預設思考強度).
  No per-conversation subagent effort control anywhere.
- Conversation: model switch across families (config `{model}`), subagent change via config `{subagent:{model}}`; sidebar tags for
  DeepSeek and Claude (`row-tag ds` / `row-tag cl`); subagent cards and the subagent panel show 「模型 · 思考 強度」 + a 「跟主模型」 marker.
- 配色 (設定 → 配色): 3 cards with preview swatch; applied globally, kept in localStorage `hubLookChoice` (read by index.html before first paint)
  and in `PUT /api/settings {look, defaults}`. `data-agent` was renamed `data-look` (CSS token blocks kept). Nothing switches the look by
  mode or model any more. 淺色／深色／跟系統 only for the Kimi look (disabled with a note otherwise, in 設定 and in the ⋯ menu). theme-color per look.
- 設定: 配色, 模型來源 (Kimi / DeepSeek / Claude status + buttons), 新對話的預設 (model, effort, permission, plan, 子代理模型,
  「子代理思考強度（依模型，所有聊天室共用）」 list when scope is per-model). The Claude / DeepSeek key dialogs lost their own defaults sections.
- Guess-note removal: the composer note 「這個資料夾有終端機的 Kimi 開著…」, its unlock wording, `state.guess` and the badge title for `meta.guess`
  are removed. The exact-terminal case (`owner 'tui'`, read-only note with 「仍要從這裡操作」, and `controllable`) is unchanged.
- README: new section on the unified conversation, sources, subagent models, 配色; old Claude/DeepSeek sections reworded.

## Left / open
- `test/e2e-kimi-bridge.test.mjs` (lines ~358-370, ~678) still assert the bridge's `guess` flag: belongs to the bridge/server side (skipped without a real Kimi).
- Assumed (unconfirmed with the server): `billing` is a string (subscription|plan -> 訂閱, gateway -> 閘道計費, api|metered|usage -> 按量計費, anything else shown verbatim);
  old Claude-daemon conversations are `agentId === 'claude'`; `/api/models` has no default model, so the Kimi default comes from
  `GET /api/machines/:id/models` `defaultModel` (or `defaultModel` in /api/models if the server adds it); subagent default effort fallback is
  `model.subagentDefaultEffort ?? model.defaultEffort`.
- Pre-existing AA misses, not touched (dark theme / Claude look): white on accent for menu hover and primary buttons (3.9:1 dark, 3.1:1 Claude),
  focused `.composer-box` border (2.9 / 2.8:1), DeepSeek `.tab-count` (3.7:1). New UI uses a new `--edge` token for borders that must be 3:1.
- Mobile (390px): the chip row wraps onto 2-3 lines instead of scrolling sideways (no page scroll).

## API fields relied on (all read tolerantly)
- `GET /api/models?machineId=` -> `sources[{id,label,billing,ready,models[{id,name,efforts,defaultEffort,image,context,family,subagentDefaultEffort?}]}]`, `subagentEffortScope`.
  Falls back to `GET /api/machines/:id/models` (Kimi + DeepSeek models) when it is missing.
- `POST /api/sessions {machineId,cwd,prompt,model,effort,permission,planMode,subagent:{model},repo,branch,files,images}`, no `agent`.
- `POST /api/sessions/:id/config {model|effort|permission|planMode|subagent:{model}}`.
- Session summary: `family`, `subagent:{model}`, `meta.model/models/effort/...`, `mode==='deepseek'` and `agentId==='claude'` for old ones.
- Subagent event: `subagent.model`, `subagent.effort`, (optional `subagent.primary`).
- `/api/settings` `defaults.{model,effort,permission,planMode,subagentModel,subagentEfforts}`, top-level `look`.
- WS `claude` / `deepseek` account messages re-read the model lists.

## Tests / screenshots
- `npm run check` passes. `npm test` (run in a copy outside `.claude/`, where express can serve files): see the report. No unit test touches `public/*`.
- Playwright checks and screenshots live in the session scratchpad `ui/` (uni-behave.mjs 14 checks, uni-audit.mjs, uni-cmp.mjs + uni-diff.py, uni-shots.mjs -> `uni-ui-*.png`).
