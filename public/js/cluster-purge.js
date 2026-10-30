// 完全清除 (full purge) on the screen: the confirmation, the result, and the
// list of recent purges with the backups still kept. What is decided (what each
// box would take, how the outcome reads) is in cluster-model.js; this file only
// draws it. Used by the cluster's own page (one cluster) and the page of every
// cluster (a batch).
import { h, fill, icon, copyText } from './dom.js';
import { purgePlanView, purgeResultView, purgeOptions, fmtBytes, fmtStamp, PURGE_DAYS } from './cluster-model.js';

const li = (text, attrs = {}) => h('li', attrs, text);

// The confirmation. `entries`: [{ id, name, plan }] (the dry runs, GET /clusters/:id/purge/plan).
// Resolves to the options the person chose ({ discardDirty, deleteUnmerged, deleteMerged, noBackup }), or null.
export function confirmPurge(ctx, entries) {
  const many = entries.length > 1;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      d.close();
      resolve(v);
    };
    const opts = purgeOptions({});
    const box = (key, label, hint) => {
      const input = h('input', { class: 'om-switch', type: 'checkbox', dataset: { box: key }, onchange: () => ((opts[key] = input.checked), draw()) });
      const text = h('span', null, h('span', { class: 'om-field__label' }, label), h('span', { class: 'om-field__help', dataset: { hint: key } }, hint));
      return { input, text, el: h('label', { class: 'settings-switch cluster-purge-box', dataset: { boxrow: key } }, input, text) };
    };
    const dirty = box('discardDirty', '', '');
    const unmerged = box('deleteUnmerged', '', '');
    const merged = box('deleteMerged', '', '');
    const nobackup = box('noBackup', '不留備份（立即永久刪除）', '');
    nobackup.el.classList.add('danger');
    const summary = h('ul', { class: 'cluster-purge-summary', dataset: { field: 'purge-summary' } });
    const lists = h('div', { class: 'cluster-purge-clusters' });
    const backupNote = h('p', { class: 'om-field__help cluster-purge-note', dataset: { field: 'backup-note' } });
    const notes = h('div', { class: 'cluster-purge-warns' });
    const confirmBtn = h('button', { class: 'om-btn om-btn--destructive', type: 'button', dataset: { action: 'purge-confirm' }, onclick: () => finish({ ...opts }) }, '完全清除');

    const views = () => entries.map((e) => ({ e, v: purgePlanView(e.plan, opts) }));
    function setBox(b, { label, hint, count }) {
      b.text.firstChild.textContent = label;
      b.text.lastChild.textContent = hint;
      b.input.disabled = count === 0;
      if (count === 0) {
        b.input.checked = false;
        opts[b.input.dataset.box] = false;
      }
      b.el.classList.toggle('none', count === 0);
    }
    function draw() {
      const vs = views();
      const sum = (f) => vs.reduce((a, x) => a + f(x.v), 0);
      const dirtyN = sum((v) => v.boxes.dirty);
      const unmergedN = sum((v) => v.boxes.unmerged);
      const mergedN = vs.filter((x) => x.v.boxes.merged).length;
      setBox(dirty, { label: `也丟掉未提交的修改（有 ${dirtyN} 個 worktree 有未提交修改）`, hint: dirtyN ? '連同那個 worktree 與它的分支一起移除；修改會先備份成 patch。不勾就保留這些 worktree。' : '沒有 worktree 有未提交的修改。', count: dirtyN });
      setBox(unmerged, { label: `也刪除沒合併進去的分支（有 ${unmergedN} 個）`, hint: unmergedN ? '這些分支上有 commit 不在合併分支、也不在主對話的 HEAD 上；會先備份成 git bundle。不勾就保留這些分支。' : '沒有分支帶著沒合併的 commit。', count: unmergedN });
      setBox(merged, { label: `也刪除合併分支${many ? `（${mergedN} 個叢集有）` : mergedN ? ` ${vs[0].v.merged.branch}` : ''}`, hint: mergedN ? '合併的成果就在這個分支上；刪掉前會先備份。不勾就保留。' : '這個叢集沒有合併過，沒有合併分支。', count: mergedN });
      const conv = sum((v) => v.totals.conversations);
      const kimi = sum((v) => v.totals.kimiSessions);
      const subs = sum((v) => v.totals.kimiSubagents);
      const wt = sum((v) => v.totals.worktrees);
      const disc = sum((v) => v.totals.discarded);
      const br = sum((v) => v.totals.branches);
      const kept = sum((v) => v.totals.kept);
      const canDelete = entries.every((e) => e.plan.connector?.canDeleteKimi !== false);
      fill(
        summary,
        li(`${conv} 個工作者對話：Hub 紀錄${kimi ? `＋Kimi 紀錄 ${kimi} 筆${subs ? `（含子代理 ${subs} 個）` : ''}${canDelete ? '' : '，只能封存、不能刪除'}` : ''}`, { dataset: { item: 'conversations' } }),
        li(`${wt} 個 worktree${disc ? `（其中 ${disc} 個連同未提交的修改）` : ''}`, { dataset: { item: 'worktrees' } }),
        li(`${br} 個工作者分支`, { dataset: { item: 'branches' } }),
        li('叢集記憶檔與資料夾', { dataset: { item: 'memory' } }),
        li(many ? `${entries.length} 個叢集紀錄本身（從總覽移除）` : '叢集紀錄本身（從總覽移除）', { dataset: { item: 'cluster' } }),
        kept ? li(`保留 ${kept} 項（沒勾對應的選項，原因寫在下面）`, { class: 'keep', dataset: { item: 'kept' } }) : null,
      );
      fill(
        lists,
        vs.map(({ e, v }) =>
          h(
            'details',
            { class: 'cluster-fold cluster-purge-cluster', open: !many, dataset: { cluster: e.id } },
            h('summary', null, h('span', { class: 'cf-title' }, e.name), h('span', { class: 'muted' }, `${v.totals.conversations} 個對話 · ${v.totals.worktrees} 個 worktree · ${v.totals.branches} 個分支`)),
            h('div', { class: 'cf-body' },
              h('ul', { class: 'cluster-cleanup-list cluster-purge-list' },
                v.rows.map((r) =>
                  h('li', { dataset: { session: r.sessionId, keeps: String(r.keeps) } },
                    h('div', { class: 'cluster-merge-row' }, h('span', { class: 'cluster-merge-name' }, r.title), h('span', { class: `om-badge ${r.keeps ? 'om-badge--warning' : 'om-badge--success'}` }, r.keeps ? '有保留' : '清除')),
                    r.will.length ? h('div', { class: 'om-field__help' }, `會刪：${r.will.join('、')}`) : null,
                    r.keeps ? [r.worktreePath ? h('code', null, r.worktreePath) : null, h('ul', { class: 'cluster-cleanup-reasons om-field__help' }, r.reasons.map((x) => li(x)))] : null,
                  ),
                ),
              ),
              v.merged.exists ? h('p', { class: 'om-field__help', dataset: { field: 'merged-line' } }, v.merged.state === 'delete' ? `合併分支 ${v.merged.branch} 會刪除。` : `合併分支 ${v.merged.branch}：保留（${v.merged.reason}）。`) : null,
            ),
          ),
        ),
      );
      const where = [...new Set(entries.map((e) => e.plan.connector?.trashDir).filter(Boolean))];
      backupNote.textContent = opts.noBackup
        ? '不留備份：刪掉就是刪掉了，救不回來。'
        : `刪之前先備份：電腦上 ${where.length ? where.map((p) => `${p}/cluster-…tar.gz`).join('、') : '連接器的 trash 資料夾'}（工作者的 Kimi 對話資料夾與記憶檔），Hub 的 data/trash/（Hub 端的對話與叢集紀錄）；${PURGE_DAYS} 天後自動刪除。備份失敗就一樣都不刪。`;
      backupNote.classList.toggle('danger', opts.noBackup);
      const warns = entries.map((e) => e.plan.connector).filter((c) => c && c.canDeleteKimi === false);
      fill(notes, warns.length ? h('div', { class: 'callout small cluster-warn' }, icon('warn'), h('div', { class: 'callout-text' }, [...new Set(warns.map((c) => c.note))].join(' '))) : null);
    }
    draw();
    const d = ctx.dialog(
      h(
        'div',
        { class: 'alert cluster-purge-dialog' },
        h('div', { class: 'om-alert__title' }, many ? `要完全清除這 ${entries.length} 個叢集嗎？` : `要完全清除「${entries[0].name}」嗎？`),
        h('p', { class: 'cluster-cleanup-summary' }, '把叢集整個清掉：下面這些東西都會刪。主對話與其他對話完全不動。和「清理」不同，這不是收起，是刪除。'),
        summary,
        lists,
        h('div', { class: 'cluster-purge-boxes' }, dirty.el, unmerged.el, merged.el),
        notes,
        h('div', { class: 'cluster-purge-boxes' }, nobackup.el),
        backupNote,
        h('div', { class: 'dialog-actions' }, h('button', { class: 'om-btn', type: 'button', onclick: () => finish(null) }, '取消'), confirmBtn),
      ),
      { wide: true, onClose: () => finish(null) },
    );
  });
}

const money = (n) => fmtBytes(n);

// The result of one purge. `name`: the cluster's name.
export function purgeResultEl(result, { name = '', ctx } = {}) {
  const v = purgeResultView(result);
  if (!v) return h('div');
  const section = (title, items, cls = '') => (items.length ? h('div', { class: `cluster-purge-section ${cls}` }, h('div', { class: 'cluster-cleanup-kept-title' }, title), h('ul', { class: 'cluster-purge-lines' }, items.map((x) => li(x)))) : null);
  const b = v.backup;
  const backup =
    b && b.enabled
      ? h('div', { class: 'cluster-purge-section backup', dataset: { field: 'backup' } },
          h('div', { class: 'cluster-cleanup-kept-title' }, `備份（${b.days} 天後自動刪除${b.expiresAt ? `，${fmtStamp(b.expiresAt)}` : ''}）`),
          h('ul', { class: 'cluster-purge-lines' },
            b.machine ? h('li', null, `${b.machine.name || '電腦'}：`, h('code', { dataset: { field: 'backup-machine' } }, b.machine.path), ` (${money(b.machine.bytes)})`, h('button', { class: 'om-btn om-btn--toolbar om-btn--sm', type: 'button', title: '複製路徑', 'aria-label': '複製備份檔路徑', onclick: () => copyText(b.machine.path).then(() => ctx?.toast?.('已複製')) }, icon('copy'))) : null,
            b.hub ? h('li', null, 'Hub：', h('code', { dataset: { field: 'backup-hub' } }, `data/trash/${b.hub.file}`), ` (${money(b.hub.bytes)})`) : null,
            h('li', { class: 'om-field__help' }, '還原：解開那個 tar.gz（Kimi 對話資料夾與記憶檔是從 / 開始的相對路徑，未提交的修改與被刪的分支在 extras/）。'),
          ),
        )
      : b
        ? h('div', { class: 'cluster-purge-section backup' }, h('div', { class: 'cluster-cleanup-kept-title' }, '備份'), h('p', { class: 'om-field__help' }, '這次選了不留備份。'))
        : null;
  return h(
    'section',
    { class: `cluster-section cluster-purge-result tone-${v.tone}`, dataset: { view: 'purge-result', tone: v.tone } },
    h('div', { class: 'cluster-section-title' }, h('span', { dataset: { field: 'purge-title' } }, v.title), name ? h('span', { class: 'muted' }, name) : null),
    v.summary ? h('p', { class: 'om-field__help', dataset: { field: 'purge-summary-line' } }, v.summary) : null,
    section('刪了什麼', v.deleted, 'deleted'),
    section('保留了什麼（依你的選擇，原因在後面）', v.kept, 'kept'),
    section('沒清掉的（原因）', v.failed, 'failed'),
    v.connectorNote ? h('div', { class: 'callout small cluster-warn' }, icon('warn'), h('div', { class: 'callout-text' }, v.connectorNote)) : null,
    backup,
  );
}

// The list of recent purges whose backups are still kept (GET /clusters/trash).
export function purgedListEl(items, { days = PURGE_DAYS, ctx } = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return null;
  return h(
    'details',
    { class: 'cluster-fold cluster-purged', dataset: { view: 'purged-list' } },
    h('summary', null, h('span', { class: 'cf-title' }, '最近清除的叢集'), h('span', { class: 'muted' }, `${list.length} 筆 · 備份保留 ${days} 天`)),
    h('div', { class: 'cf-body' },
      h('ul', { class: 'cluster-purge-lines' },
        list.map((i) =>
          h('li', { dataset: { purged: i.clusterId } },
            h('div', { class: 'cluster-merge-row' }, h('span', { class: 'cluster-merge-name' }, i.name || i.clusterId), h('span', { class: `om-badge ${i.partial ? 'om-badge--warning' : ''}` }, i.partial ? '部分清除' : '已清除')),
            h('div', { class: 'om-field__help' }, `清除於 ${fmtStamp(i.purgedAt)} · 備份到 ${fmtStamp(i.expiresAt)}`),
            i.machine ? h('div', { class: 'om-field__help' }, `${i.machine.machineName || '電腦'}：`, h('code', null, i.machine.path), i.machine.removed ? '（已刪除）' : '', h('button', { class: 'om-btn om-btn--toolbar om-btn--sm', type: 'button', title: '複製路徑', 'aria-label': '複製備份檔路徑', onclick: () => copyText(i.machine.path).then(() => ctx?.toast?.('已複製')) }, icon('copy'))) : null,
            i.hub ? h('div', { class: 'om-field__help' }, 'Hub：', h('code', null, `data/trash/${i.hub.file}`), i.hub.removed ? '（已刪除）' : '') : null,
            i.kept?.length ? h('ul', { class: 'cluster-cleanup-reasons om-field__help' }, i.kept.map((k) => li(k))) : null,
          ),
        ),
      ),
    ),
  );
}

// The page of every cluster: one result line per cluster of a batch.
export function purgeBatchResultEl(items, ctx) {
  return h('div', { class: 'cluster-purge-batch' }, items.map(({ name, result, error }) => (error ? h('section', { class: 'cluster-section cluster-purge-result tone-aborted', dataset: { view: 'purge-result', tone: 'aborted' } }, h('div', { class: 'cluster-section-title' }, h('span', null, '沒有清除'), h('span', { class: 'muted' }, name)), h('p', { class: 'om-field__error' }, error)) : purgeResultEl(result, { name, ctx }))));
}
