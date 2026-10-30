// The 耗時 tab in the side panel of a Kimi or DeepSeek conversation: where the
// time of the whole conversation went (GET /api/sessions/:id/timing), drawn with
// the same function as the worker cards of a cluster (timing-box.js), so that a
// conversation and a cluster can be timed side by side.
//
// The rule (the user's, 2026-10-21): only what the Hub sent. Nothing here is
// added up, estimated or filled in; what the Hub did not measure says 量不到
// and why (timing-box.js), and what is copied is the Hub's answer as it came.
//
// When it reads: once when the tab opens, then every 10 seconds while the
// conversation works, and once more when a turn ends (`refresh()`), so the last
// seconds of the turn are in. Idle, it does not read. Closing the tab, the panel
// or the conversation (`destroy()`) stops it.
import { h, fill, copyText } from './dom.js';
import { get } from './api.js';
import { timingBox } from './timing-box.js';

export const TIMING_REFRESH_MS = 10_000;

// Only a Kimi or a DeepSeek conversation has Kimi's events to measure.
export const hasTiming = (provider) => provider === 'kimi' || provider === 'deepseek';

export class TimingPane {
  // ctx: { id, title(): string, busy(): boolean, toast(text) }
  constructor(ctx) {
    this.ctx = ctx;
    this.raw = null; // the Hub's last answer, as it came
    this.rawText = ''; // ... and as text, to see whether a read brought anything new
    this.error = null; // the last read that failed
    this.sig = ''; // what the pane was last drawn from
    this.asked = 0; // a read's number: an answer to an older read is not shown
    this.dead = false;
    this.slot = h('div', { class: 'timing-slot' });
    this.copy = h('button', { class: 'om-btn om-btn--sm', type: 'button', dataset: { action: 'copy-timing' }, disabled: true, title: '把中控台回的耗時原文，加上對話標題與 id，複製起來', onclick: () => this.copyNumbers() }, '複製數字');
    this.el = h(
      'div',
      { class: 'panel-body timing-pane' },
      this.slot,
      h('div', { class: 'timing-actions' }, this.copy, h('span', { class: 'timing-note muted' }, '對話進行中會定時重讀，閒置時不重讀。')),
    );
    this.draw();
    this.refresh();
    this.timer = setInterval(() => document.visibilityState === 'visible' && this.ctx.busy() && this.refresh(), TIMING_REFRESH_MS);
  }

  destroy() {
    this.dead = true;
    clearInterval(this.timer);
  }

  async refresh() {
    if (this.dead) return;
    const n = ++this.asked;
    let raw = null;
    let error = null;
    try {
      raw = await get(`/sessions/${this.ctx.id}/timing`);
    } catch (err) {
      error = err;
    }
    if (this.dead || n !== this.asked) return;
    // A read that failed leaves the last answer where it is; one that brought
    // the same figures redraws nothing (a selection in the pane is kept).
    if (raw !== null) {
      this.raw = raw;
      this.rawText = JSON.stringify(raw);
    }
    this.error = error;
    const sig = `${this.rawText}\n${error ? error.message || String(error) : ''}`;
    if (sig === this.sig) return;
    this.sig = sig;
    this.draw();
  }

  // Which key the conversation is on, in the Hub's words: the gateway and the key's
  // last four characters of its latest request, never the key. Only for a
  // conversation that goes through the key pool (the answer says nothing of a
  // key otherwise, and nothing is said for it).
  keyLine() {
    const t = this.raw;
    if (!t) return null;
    const k = t.currentKey;
    if (!k) return t.requests === 0 ? h('p', { class: 'timing-key muted', dataset: { part: 'current-key' } }, '用的 key：這個對話還沒有請求紀錄，看不出來。') : null;
    const name = k.removed ? `${k.gatewayLabel || k.gateway || '某一家'} 的一把 key（已不在清單裡）` : `${k.gatewayLabel || k.gateway} …${k.hint}`;
    const how = k.distribution === 'sticky' ? '平均分配：這個對話固定用這一把，它用完或被拒絕才換' : '接力：所有對話共用使用中的那一把，它用完才換下一把';
    return h(
      'p',
      { class: 'timing-key', dataset: { part: 'current-key', distribution: k.distribution || '' } },
      h('span', { class: 'timing-label' }, '用的 key'),
      ' ',
      h('strong', { class: 'timing-key-name' }, name),
      h('span', { class: 'timing-key-how muted' }, `（${how}）`),
    );
  }

  // The last answer in full, and - if the read after it failed - a line that says so.
  draw() {
    const got = this.raw ? { timing: this.raw } : this.error ? { error: this.error } : null;
    fill(
      this.slot,
      this.keyLine(),
      timingBox(got, { detail: true }),
      this.raw && this.error ? h('p', { class: 'timing-stale', role: 'status' }, `重新讀取失敗：${this.error.message || String(this.error)}。上面是上一次讀到的數字。`) : null,
    );
    this.copy.disabled = !this.raw;
  }

  // The Hub's answer, whole and as it came, with the title and the id of the
  // conversation so whoever gets it knows which one it is. Nothing else: the
  // answer has no key or token in it, and nothing of the page is added.
  async copyNumbers() {
    if (!this.raw) return;
    const text = JSON.stringify({ title: this.ctx.title(), id: this.ctx.id, timing: this.raw }, null, 2);
    this.ctx.toast((await copyText(text)) ? '已複製耗時數字' : '複製失敗：瀏覽器不讓這個頁面寫剪貼簿');
  }
}
