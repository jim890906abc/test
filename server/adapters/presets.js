// Agent presets. Vendor-neutral ways to plug an agent into the hub:
//   acp    — any agent that speaks the Agent Client Protocol over stdio
//            (Kimi Code CLI, Gemini CLI, Qwen Code, Goose, OpenCode, …). The
//            agent keeps its own login (subscription accounts work), its own
//            tools and its own permission prompts; the hub relays everything
//            to the browser as it streams.
//   cli    — any other coding-agent CLI; the hub spawns it per turn and parses
//            JSON-lines or plain-text output.
//   openai — any OpenAI-compatible Chat Completions endpoint (API key based);
//            the hub supplies the agent loop and workspace tools.
// Every field is editable in the UI; model names are only defaults.

const acp = (id, name, command, args, color, extra = {}) => ({
  id, name, type: 'acp', command, args, env: {}, color, enabled: true, ...extra,
});

const api = (id, name, baseUrl, model, apiKeyEnv, color, extra = {}) => ({
  id, name, type: 'openai', baseUrl, model, apiKeyEnv, apiKey: '', color, enabled: false, ...extra,
});

const cli = (id, name, command, cliKind, args, color, extra = {}) => ({
  id, name, type: 'cli', command, cliKind, args, model: '', color, enabled: false, ...extra,
});

export const TEMPLATES = [
  acp('kimi', 'Kimi Code', 'kimi', 'acp', '#1a73e8', {
    description:
      'Moonshot AI 的 Kimi Code CLI，透過 `kimi acp` 連線。使用你在終端機 `kimi login` 登入的 Kimi 帳號（訂閱制可用，不需要 API key）。',
    install: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash   或   npm i -g @moonshot-ai/kimi-code',
    login: 'kimi login',
  }),
  acp('gemini-cli', 'Gemini CLI', 'gemini', '--experimental-acp', '#4285f4', {
    description: 'Google Gemini CLI 的 ACP 模式，沿用 Google 帳號登入。',
    install: 'npm i -g @google/gemini-cli',
    login: 'gemini',
  }),
  acp('qwen-code', 'Qwen Code', 'qwen', '--experimental-acp', '#615ced', {
    description: '阿里 Qwen Code（Gemini CLI 分支）的 ACP 模式，沿用 Qwen 帳號登入。',
    install: 'npm i -g @qwen-code/qwen-code',
    login: 'qwen',
    enabled: false,
  }),
  acp('goose', 'Goose', 'goose', 'acp', '#3f3f46', {
    description: 'Block 的 Goose，`goose acp`。',
    install: 'https://block.github.io/goose/',
    enabled: false,
  }),
  acp('opencode', 'OpenCode', 'opencode', 'acp', '#f59e0b', {
    description: 'SST OpenCode，`opencode acp`。',
    install: 'npm i -g opencode-ai',
    enabled: false,
  }),
  acp('codex-acp', 'OpenAI Codex (ACP)', 'npx', '-y @zed-industries/codex-acp', '#0f0f0f', {
    description: 'Zed 維護的 Codex ACP 轉接器，沿用 ChatGPT 帳號登入（codex login）。',
    login: 'codex login',
    enabled: false,
  }),
  acp('custom-acp', '自訂 ACP Agent', 'my-agent', '--acp', '#71717a', {
    description: '任何支援 Agent Client Protocol 的 agent：填入啟動指令與參數即可。',
    enabled: false,
  }),
  cli('aider', 'Aider', 'aider', 'aider', '', '#14a37f', {
    description: 'pip install aider-chat — 每回合以 `aider --message` 執行，輸出純文字。',
  }),
  cli('custom-cli', '自訂 CLI', 'my-agent', 'plain', '{prompt}', '#71717a', {
    description: '任意指令；{prompt} 會被替換成提示詞，沒有 {prompt} 時改從 stdin 傳入。JSON lines 會自動解析。',
  }),
  api('moonshot-api', 'Kimi API（按量計費）', 'https://api.moonshot.ai/v1', 'kimi-k2-0905-preview', 'MOONSHOT_API_KEY', '#1a73e8', {
    description: 'Moonshot 開放平台 API（需 API key，按 token 計費；訂閱制請改用上面的 Kimi Code）。',
  }),
  api('openai', 'OpenAI API', 'https://api.openai.com/v1', 'gpt-5', 'OPENAI_API_KEY', '#10a37f'),
  api('deepseek', 'DeepSeek API', 'https://api.deepseek.com/v1', 'deepseek-chat', 'DEEPSEEK_API_KEY', '#4d6bfe'),
  api('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1', 'moonshotai/kimi-k2', 'OPENROUTER_API_KEY', '#6467f2'),
  api('ollama', 'Ollama（本機）', 'http://localhost:11434/v1', 'qwen2.5-coder:7b', '', '#8a8a8a'),
  {
    id: 'demo', name: 'Demo Agent', type: 'demo', color: '#d97757', enabled: true,
    description: '不需要任何帳號的模擬 agent，會真的在工作區建立檔案、執行指令並請求權限，用來體驗介面。',
  },
];

export const DEFAULT_AGENTS = TEMPLATES.filter((t) => !t.id.startsWith('custom-')).map((t) => ({ ...t, builtin: true }));
