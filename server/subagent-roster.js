// The subagents of a conversation, one entry each.
//
// Why this exists: Kimi's AgentSwarm is ONE tool call, so the conversation
// holds ONE card for it, and that card's `subagent` object is overwritten by
// whichever member spoke last (a swarm of 6 reads, on the card, as "#6"). The
// card is right for a person reading the conversation and cannot say how many
// subagents there are or how each of them is doing. Kimi does say it: every
// member has its own `subagent.spawned` (id, description, swarmIndex, model,
// thinking), `subagent.started` and `subagent.completed|failed|cancelled`. This
// keeps what each of those said, per member, next to the conversation
// (`session.state.subagentRoster`), so that it survives a restart of the Hub.
//
// What an entry holds is only what was reported, with the Hub's own clock for
// the two moments it saw (`startedAt`: the member was spawned; `finishedAt`: it
// ended). Nothing is filled in: a model Kimi did not name stays null.
//
// The reading of an entry (is it really running?) is not done here: that is
// agent-state.js's job, the same one the card and the 子代理 panel use.

// More than this and the oldest entries are let go (and counted, so that the
// page says so instead of showing a smaller number as if it were the whole).
export const ROSTER_MAX = 1000;

const TERMINAL = ['done', 'error', 'cancelled'];

export function rosterOf(session) {
  const r = session?.state?.subagentRoster;
  return r && Array.isArray(r.list) ? r : { list: [], dropped: 0 };
}

function open(session) {
  session.state ||= {};
  const r = session.state.subagentRoster;
  if (!r || !Array.isArray(r.list)) session.state.subagentRoster = { list: [], dropped: 0 };
  return session.state.subagentRoster;
}

export function find(session, id) {
  return rosterOf(session).list.find((e) => e.id === id) || null;
}

const clip = (v, n) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

// A member was spawned (or seen again: a repeat updates what it says and keeps
// where it started). `m`: { id, parent (the card's event id), name, description,
// swarmIndex, background, model, effort, requested, at }.
export function noteSpawned(session, m) {
  if (!m?.id) return null;
  const r = open(session);
  let e = r.list.find((x) => x.id === m.id);
  if (!e) {
    e = { id: m.id, startedAt: m.at ?? null, finishedAt: null };
    r.list.push(e);
    while (r.list.length > ROSTER_MAX) {
      r.list.shift();
      r.dropped += 1;
    }
  }
  Object.assign(e, {
    parent: m.parent ?? e.parent ?? null,
    name: m.name || e.name || 'subagent',
    description: clip(m.description, 200) || e.description || '',
    ...(m.swarmIndex ? { swarmIndex: m.swarmIndex } : {}),
    background: Boolean(m.background),
    status: 'running',
    requested: m.requested === undefined ? e.requested ?? null : m.requested,
    // What Kimi said it runs on. A member whose spawn did not say stays null (its own
    // later status frames may), never the card's or the conversation's.
    model: m.model || e.model || null,
    effort: m.effort || e.effort || null,
  });
  e.finishedAt = null;
  return e;
}

// Kimi said what became of a member. `status`: running | done | error |
// cancelled | suspended. An id never spawned here (the Hub was restarted
// meanwhile, or the card was made by a replay) is added from `from` (the
// card it was found on), without a start time: that one was not seen.
export function noteStatus(session, id, status, { at = null, error, from } = {}) {
  if (!id || !status) return null;
  let e = find(session, id);
  if (!e) {
    if (!from) return null;
    e = noteSpawned(session, { id, parent: from.parent, name: from.name, description: from.description, background: from.background, model: from.model, effort: from.effort, requested: from.requested, at: null });
  }
  e.status = status;
  if (error !== undefined && error !== null && error !== '') e.error = clip(error, 500);
  e.finishedAt = TERMINAL.includes(status) ? at : null;
  return e;
}

// Kimi told the model and thinking one member runs on (agent.status.updated of that member).
export function noteModel(session, id, { model, effort } = {}) {
  const e = find(session, id);
  if (!e) return null;
  if (model) e.model = model;
  if (effort) e.effort = effort;
  return e;
}

export function noteBackground(session, id) {
  const e = find(session, id);
  if (e) e.background = true;
  return e;
}
