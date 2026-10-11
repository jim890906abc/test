import * as acp from './acp.js';
import * as cli from './cli.js';
import * as openai from './openai.js';
import * as demo from './demo.js';
import * as kimiRemote from './kimi-remote.js';
import * as claude from './claude.js';

// type -> { available(agent), run(ctx, text, opts), test?(agent), configure?, dispose? }
export const ADAPTERS = { acp, cli, openai, demo, 'kimi-remote': kimiRemote, claude };

export const TYPE_LABELS = {
  acp: 'ACP Agent',
  cli: 'CLI',
  openai: 'OpenAI 相容 API',
  demo: 'Demo',
  'kimi-remote': 'Kimi · 遠端機器',
  claude: 'Claude API',
};
