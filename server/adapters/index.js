import * as acp from './acp.js';
import * as cli from './cli.js';
import * as openai from './openai.js';
import * as demo from './demo.js';

// type -> { available(agent), run(ctx, text, opts), test?(agent), configure?, dispose? }
export const ADAPTERS = { acp, cli, openai, demo };

export const TYPE_LABELS = {
  acp: 'ACP Agent',
  cli: 'CLI',
  openai: 'OpenAI 相容 API',
  demo: 'Demo',
};
