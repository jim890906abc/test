// The clock of a working conversation counts from the person's message that
// started the turn. In a window that message may be before it: then the Hub
// names it, and only without either is it "now".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turnStartTs } from '../public/js/window-state.js';

const user = (ts, extra = {}) => ({ type: 'user', ts, ...extra });
const other = (ts, type = 'text') => ({ type, ts });

test('the newest message of the person in the window', () => {
  assert.equal(turnStartTs([user(100), other(150), user(200), other(250)], null, 999), 200);
});

test('a message inside a subagent is not the person\'s, so it does not start the clock', () => {
  assert.equal(turnStartTs([user(100), other(150), user(500, { parent: 'card' })], null, 999), 100);
});

test('a window with no message of the person: the one the Hub names, not now', () => {
  assert.equal(turnStartTs([other(150), other(250)], { question: { id: 'q', ts: 42, text: 'x' } }, 999), 42);
  assert.equal(turnStartTs([], { question: { ts: 7 } }, 999), 7);
});

test('the window\'s own message wins over the Hub\'s older one', () => {
  assert.equal(turnStartTs([user(300)], { question: { ts: 42 } }, 999), 300);
});

test('nothing to go on (or nonsense): now', () => {
  for (const outside of [null, undefined, {}, { question: {} }, { question: { ts: 'soon' } }, { question: { ts: NaN } }]) assert.equal(turnStartTs([other(1)], outside, 999), 999, JSON.stringify(outside));
  assert.equal(turnStartTs(undefined, undefined, 999), 999);
  assert.equal(turnStartTs([user(0)], null, 999), 999, 'a message with no time is not a start');
});
