// Where one conversation's time went, drawn: the total, a bar of the four parts
// (model, tools, waiting for a rate limit, compaction), the legend, and the
// reasons for what the Hub did not measure. The one function that draws it, for
// the worker cards on the cluster page and for the 耗時 tab of a conversation's
// panel (timing-panel.js), so the two always look - and read - the same.
//
// The rule that shapes it (the user's, 2026-10-21): only what the Hub sent. A
// figure it did not measure says 量不到 and why; nothing is worked out from
// the rest. How the figures are laid out is decided in cluster-model.js
// (timingView); this file only puts them on the screen.
import { h } from './dom.js';
import { timingView, fmtMs, fmtStamp } from './cluster-model.js';

// `got`: { timing } (the Hub's answer), { error } (the call failed), or null
// (not asked yet). `detail`: the panel's view, which adds every count (also the
// ones that are 量不到), from when the data covers, and the notes; the cluster
// card keeps to the bar and one line of counts.
export function timingBox(got, { detail = false } = {}) {
  if (!got) return h('div', { class: 'cluster-timing-loading muted' }, '耗時讀取中…');
  const v = timingView(got.timing, got.error);
  if (v.failed) return h('div', { class: 'cluster-timing' }, h('div', { class: 'cluster-timing-failed' }, `耗時量不到：${v.failed}`));
  const total = v.total.ms === null ? `量不到` : fmtMs(v.total.ms);
  const note = (n) => h('p', { class: 'cluster-reason', dataset: { part: 'note' } }, n);
  return h(
    'div',
    { class: `cluster-timing${detail ? ' timing-detail' : ''}` },
    h('div', { class: 'cluster-timing-head' }, h('span', null, '耗時'), h('span', { class: 'cluster-timing-total' }, `總時間 ${total}`)),
    h(
      'div',
      { class: 'cluster-bar', role: 'img', 'aria-label': `耗時拆解：${v.segments.map((s) => `${s.label} ${fmtMs(s.ms) || '量不到'}`).join('、')}` },
      v.segments.filter((s) => s.share).map((s) => h('span', { class: `cluster-seg part-${s.key}`, dataset: { seg: s.key }, style: { width: `${(s.share * 100).toFixed(1)}%` } })),
    ),
    h(
      'ul',
      { class: 'cluster-legend' },
      v.segments.map((s) => h('li', { dataset: { part: s.key }, class: s.ms === null ? 'unmeasured' : '' }, h('span', { class: `cluster-swatch part-${s.key}` }), h('span', { class: 'cluster-legend-label' }, s.label), h('span', { class: 'cluster-legend-value' }, s.ms === null ? '量不到' : fmtMs(s.ms)))),
    ),
    ...v.segments.filter((s) => s.ms === null).map((s) => h('p', { class: 'cluster-reason', dataset: { part: s.key } }, `${s.label}：${s.reason}`)),
    ...(v.total.ms === null ? [h('p', { class: 'cluster-reason', dataset: { part: 'wallMs' } }, `總時間：${v.total.reason}`)] : []),
    ...(detail ? [] : v.notes.map(note)),
    detail ? null : v.facts.length ? h('p', { class: 'cluster-timing-facts' }, v.facts.map(([k, n]) => `${k} ${n}`).join(' · ')) : null,
    ...(detail ? detailRows(v, note) : []),
  );
}

// A row of the panel's lists: the name, and the Hub's value or 量不到.
const row = (kind, key, label, value, measured) =>
  h('li', { class: measured ? '' : 'unmeasured', dataset: { [kind]: key } }, h('span', { class: 'timing-label' }, label), h('span', { class: 'timing-value' }, value));

function detailRows(v, note) {
  return [
    h('div', { class: 'timing-section-title' }, '次數'),
    h('ul', { class: 'timing-counts' }, v.counts.map((c) => row('count', c.key, c.label, c.n === null ? '量不到' : String(c.n), c.n !== null))),
    h('div', { class: 'timing-section-title' }, '資料涵蓋'),
    h(
      'ul',
      { class: 'timing-coverage' },
      v.coverage.map((c) => row('coverage', c.key, c.label, c.ms === null ? '量不到' : h('time', { datetime: new Date(c.ms).toISOString(), dataset: { ms: String(c.ms) } }, fmtStamp(c.ms)), c.ms !== null)),
    ),
    h('p', { class: 'timing-help' }, '上面的數字只涵蓋「起算時間」之後；請求紀錄有自己的起算時間。'),
    ...(v.notes.length ? [h('div', { class: 'timing-section-title' }, '說明'), ...v.notes.map(note)] : []),
  ];
}
