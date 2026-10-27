// The fixtures that start a Hub: stopping it must also end the Claude daemon it
// started (the daemon outlives its Hub on purpose), and say so loudly if anything
// of it is left. The Hub here is the real server/index.js on a scratch folder
// with a stored Claude conversation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { findDaemons } from '../scripts/proc-scan.mjs';
import { assertNoLeaks, snapshot } from './fixtures/leak-guard.mjs';
import { until } from './fixtures/leak-kit.mjs';
import { seedSession, startHub } from './browser-harness.mjs';

// ------------------------------------------------------------ the fixtures that start a Hub

test('a scratch Hub with a Claude conversation leaves no Claude daemon behind once it is stopped', async () => {
  const before = snapshot();
  const claude = seedSession({ id: 's_claude_leak', title: 'c', agentId: 'claude', provider: 'claude', cwd: os.tmpdir(), modelConfig: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' } });
  const hub = await startHub([claude]);
  const tmp = path.dirname(hub.data);
  // The Hub starts the daemon for the stored Claude conversation.
  await until(() => findDaemons(tmp).length > 0, 20000, 'the Hub to start its Claude daemon');
  hub.stop();
  assert.deepEqual(findDaemons(tmp).map((p) => p.pid), [], 'no daemon of this Hub is left');
  await assertNoLeaks(before, { dirs: [tmp] });
});
