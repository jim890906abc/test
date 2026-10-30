// What a worker's subagents are doing, for the cluster page's small squares.
//
// It is read from the worker conversation's own record and judged by the same
// rules the conversation's cards and 子代理 panel use (agent-state.js: a stored
// "running" is only a claim, and needs evidence), so a square never says what a
// card in the conversation would not:
//   - one entry per subagent: a member of an AgentSwarm has its own (the
//     conversation holds one card for the whole call; see subagent-roster.js),
//     a plain Agent call is one; a card that has no roster entry (a replayed
//     history, a subagent the Hub's own broker ran) is read from the card;
//   - steps and the last action are the member's own events (`agentId`);
//   - what was not reported is null: no model is borrowed from the conversation,
//     no end time is guessed.
import { agentLife, subagentModelView } from '../public/js/agent-state.js';
import { agentDescription, activityOf, countSteps } from '../public/js/agent-activity.js';
import { UNVERIFIED, actualOf } from './subagent-policy.js';
import * as roster from './subagent-roster.js';

// A swarm may send up to 128 at once; a long worker may have used several. The
// page is sent the newest this many; the counts are over all of them.
export const LISTED_MAX = 160;

const COUNT_KEYS = ['running', 'awaiting', 'done', 'failed', 'cancelled', 'unknown'];
export const emptyCounts = () => ({ total: 0, ...Object.fromEntries(COUNT_KEYS.map((k) => [k, 0])) });

const clip = (v, n) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

// One pass over the events (cached while the conversation has not moved):
// each subagent's own steps, its newest shown event, whether it waits for an
// approval, and its newest sign of life; and the subagent cards.
const indexes = new WeakMap();
function indexOf(session) {
  const events = session.events || [];
  const key = `${session.seq ?? ''}|${events.length}|${events.at(-1)?.id ?? ''}`;
  const hit = indexes.get(session);
  if (hit?.key === key) return hit;
  const byAgent = new Map();
  const byParent = new Map();
  const cards = new Map();
  const take = (map, k, ev) => {
    let a = map.get(k);
    if (!a) map.set(k, (a = { steps: 0, last: null, awaiting: false, ts: 0 }));
    if (ev.type === 'tool_use') {
      a.steps += 1;
      // `awaiting`: the newest call of this subagent is the one asking, so a question answered since is not still pending.
      a.awaiting = ev.status === 'awaiting';
    }
    if (ev.type === 'tool_use' || (ev.type === 'text' && ev.text?.trim())) a.last = ev;
    if (ev.ts > a.ts) a.ts = ev.ts;
  };
  for (const ev of events) {
    if (ev.type === 'tool_use' && ev.subagent) cards.set(ev.id, ev);
    if (ev.agentId && ev.agentId !== 'main') take(byAgent, ev.agentId, ev);
    if (ev.parent) take(byParent, ev.parent, ev);
  }
  const built = { key, byAgent, byParent, cards, steps: countSteps(events) };
  indexes.set(session, built);
  return built;
}

// How many steps (tool calls, the main agent's and every subagent's - the very
// count the conversation's subagent cards show) one conversation node holds.
// Counted over its events, not over the listed subagents: the list is cut to the
// newest 160, the events are all there.
export const stepsOfNode = (session) => (session ? indexOf(session).steps : 0);

// → { list, counts, older }.  `childStatus(id)`: the status of a Hub-run
// subagent's own conversation, when the Hub has it.
export function subagentsOf(session, { now = Date.now(), childStatus } = {}) {
  const counts = emptyCounts();
  if (!session) return { list: [], counts, older: 0 };
  const idx = indexOf(session);
  const { list: members, dropped } = roster.rosterOf(session);
  const entries = [];
  const own = new Set();

  const build = ({ id, card, sub, startedAt, finishedAt, own: a }) => {
    const claim = { ...sub };
    const pseudo = { type: 'tool_use', status: card?.status || '', ts: startedAt ?? card?.ts ?? now, childSessionId: card?.childSessionId, input: card?.input, subagent: claim };
    const life = agentLife(pseudo, { sessionStatus: session.status, childStatus, lastActivity: Math.max(a?.ts || 0, startedAt || 0) || undefined, now });
    const view = subagentModelView(pseudo, life, { now });
    const status = life.running ? (a?.awaiting ? 'awaiting' : 'running') : life.failed ? 'failed' : life.stopped ? 'cancelled' : life.unknown ? 'unknown' : 'done';
    counts.total += 1;
    counts[status] += 1;
    const model = view.actual?.model || null;
    return {
      id,
      title: clip(agentDescription(card || {}, claim), 120) || null,
      name: claim.name && !/^(subagent)$/i.test(claim.name) ? claim.name : null,
      status,
      // Why a subagent reads unknown or stopped, in the conversation card's own words.
      reason: life.reasonText || null,
      provider: view.actual?.provider || null,
      model,
      effort: view.actual?.effort || null,
      modelReason: model ? null : view.reason || (view.waiting ? '還在等這個子代理回報它用的模型' : null),
      steps: a?.steps ?? 0,
      lastAction: activityOf(a?.last, 100) || null,
      startedAt: startedAt ?? null,
      finishedAt: finishedAt ?? null,
      background: Boolean(claim.background),
      eventId: card?.id ?? null,
      at: startedAt ?? card?.ts ?? 0,
    };
  };

  for (const e of members) {
    own.add(e.id);
    own.add(e.parent);
    const card = idx.cards.get(e.parent) || null;
    const actual = actualOf(e.model, e.effort);
    entries.push(
      build({
        id: e.id,
        card,
        sub: { id: e.id, name: e.name, description: e.description, status: e.status, background: e.background, model: e.model, effort: e.effort, requested: e.requested ?? null, actual, unverifiedReason: actual ? undefined : UNVERIFIED.noModel, error: e.error },
        startedAt: e.startedAt,
        finishedAt: e.finishedAt,
        own: idx.byAgent.get(e.id),
      }),
    );
  }
  // Cards nobody on the roster belongs to: only those whose subagent really exists
  // (it has an id: a call that was refused, or has not started, is not one) and is not a /btw.
  for (const card of idx.cards.values()) {
    const sub = card.subagent;
    if (card.parent || !sub.id || own.has(card.id) || own.has(sub.id) || sub.name === 'btw') continue;
    entries.push(build({ id: sub.id, card, sub, startedAt: Number.isFinite(card.ts) ? card.ts : null, finishedAt: null, own: idx.byParent.get(card.id) }));
  }
  entries.sort((x, y) => x.at - y.at);
  const list = entries.slice(-LISTED_MAX).map(({ at, ...e }) => e);
  return { list, counts, older: dropped || 0 };
}
