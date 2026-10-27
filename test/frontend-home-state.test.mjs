// The choices behind the home screen and 設定 (public/js/home-state.js), tested
// directly in node: the three-state subagent choice, what the screen says about
// it, the one reader for new-conversation defaults, and the rollback helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SUBAGENT, modeIn, subagentPayload, effectiveSubagent, subagentModeText, providerDefaultsFor, runWithRollback } from '../public/js/home-state.js';

// ---------------------------------------------------- subagent choice

test('the home subagent has three states and they are three different requests', () => {
  assert.equal(subagentPayload({}), undefined, 'nothing chosen: nothing sent');
  assert.equal(subagentPayload({ subagent: null }), null, 'native rules chosen on purpose: null is sent');
  assert.deepEqual(subagentPayload({ subagent: { provider: 'claude', model: 'm', effort: 'low' } }), { provider: 'claude', model: 'm', effort: 'low' });
  assert.equal(subagentPayload({ subagent: undefined }), undefined);
  assert.equal(subagentPayload({ subagent: { provider: 'nope', model: 'x' } }), undefined, 'a broken stored value is "nothing chosen", not a request');
  // And they survive the localStorage round trip the home state goes through.
  const round = (o) => JSON.parse(JSON.stringify(o));
  assert.equal(modeIn(round({ subagent: null })), 'follow');
  assert.equal(modeIn(round({})), 'default');
});

test('what the screen says is what the server will do', () => {
  assert.deepEqual(effectiveSubagent('default'), DEFAULT_SUBAGENT);
  assert.equal(effectiveSubagent('follow'), null);
  // (the id's own tail starts with the provider's name: said once)
  assert.match(subagentModeText('default', null), /^deepseek-v4\.1-flash · 思考 max（預設）$/);
  assert.equal(subagentModeText('follow', null), '跟隨主模型');
});

// ------------------------------------------------- defaults, one reader

test('byProvider is the one source for a provider\'s new-conversation defaults', () => {
  const server = { model: 'k', byProvider: { claude: { model: 'sonnet', effort: 'low', permission: 'edits', planMode: true } } };
  const account = { model: 'old-opus', effort: 'high', permission: 'manual' };
  assert.deepEqual(providerDefaultsFor('claude', server, account), { model: 'sonnet', effort: 'low', permission: 'edits', planMode: true });
  // The account is only the fallback for a server that has no entry.
  assert.equal(providerDefaultsFor('claude', { model: 'k' }, account).model, 'old-opus');
  // An empty string saved on purpose is a value, not "absent".
  assert.equal(providerDefaultsFor('claude', { byProvider: { claude: { model: '' } } }, account).model, '');
});

test('runWithRollback undoes what was done, newest first, when a later step fails', async () => {
  const log = [];
  const step = (name, fail) => ({ name, run: async () => (log.push(`do ${name}`), fail && Promise.reject(new Error(`${name} refused`))), undo: async () => void log.push(`undo ${name}`) });
  await assert.rejects(runWithRollback([step('a'), null, step('b'), step('c', true), step('d')]), (err) => err.message === 'c refused' && err.failedStep === 'c');
  assert.deepEqual(log, ['do a', 'do b', 'do c', 'undo b', 'undo a']);
  // Nothing failed: nothing undone.
  log.length = 0;
  await runWithRollback([step('a'), step('b')]);
  assert.deepEqual(log, ['do a', 'do b']);
});

