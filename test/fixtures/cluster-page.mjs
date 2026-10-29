// Driving the cluster screens (叢集) in a real browser the way a person does:
// keys and clicks, nothing intercepted. Shared by the end-to-end screen tests
// (test/e2e-cluster-ui.test.mjs against a fake machine, and
// test/e2e-cluster-ui-kimi.test.mjs against the real Kimi).
//
//   const page = clusterPage({ b, base: 'http://127.0.0.1:PORT/', cluster: (cid) => api GET /clusters/:cid })
export function clusterPage({ b, base, cluster }) {
  const page = {
    // Load a #/ route from scratch and wait until the app has drawn it.
    async open(hash) {
      await b.goto(`${base}${hash}`, 400);
      await b.waitFor(`document.querySelector('.sidebar') && document.querySelector('.view')?.children.length`, { timeout: 15000 });
    },
    async press(key, code = key) {
      const vk = { Enter: 13, Escape: 27, Tab: 9 }[key] || 0;
      await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(key === 'Enter' ? { text: '\r' } : {}) });
      await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    },
    // Type like a person: focus the box, select what is in it, insert the text, so the page sees real input events.
    async typeInto(selector, text) {
      await b.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.focus(); if (e.select) e.select(); })()`);
      await b.send('Input.insertText', { text });
    },
    async fillTask(i, title, prompt) {
      const sel = (n) => `.cluster-task:nth-of-type(${i + 1}) ${n}`;
      await page.typeInto(sel('input[name="task-title"]'), title);
      await page.typeInto(sel('textarea[name="task-prompt"]'), prompt);
    },
    // The worker cards as drawn.
    cards: () =>
      b.eval(`[...document.querySelectorAll('.cluster-worker')].map((c) => {
        const t = (s) => c.querySelector(s)?.innerText.trim() ?? null;
        return { session: c.dataset.session, title: t('.cluster-worker-title'), task: t('.cluster-worker-task'), state: t('.cluster-worker-state'), branch: t('[data-field="branch"]'), worktree: t('[data-field="worktree"]'), swarm: t('[data-native-swarm]'), progress: t('.cluster-worker-progress'), timing: t('.cluster-timing'), open: c.querySelector('[data-action="open-worker"]')?.getAttribute('href') ?? null };
      })`),
    // The last button of the open dialog (its "go on" button).
    async confirm() {
      await b.waitFor(`document.querySelector('.dialog .dialog-actions .om-btn:last-child')`);
      await b.click('.dialog .dialog-actions .om-btn:last-child');
    },
    // Open the dispatch dialog the way a person does: type /cluster in the box and press Enter.
    async openDialog(sessionId) {
      await page.open(`#/s/${sessionId}`);
      await b.waitFor(`document.querySelector('.composer-input')`);
      await page.typeInto('.composer-input', '/cluster');
      await b.waitFor(`document.querySelector('.slash-menu .slash-item')`);
      await page.press('Enter');
      await b.waitFor(`document.querySelector('.cluster-dialog')`);
      await b.sleep(500); // the dialog's own fade-in
    },
    submitDialog: () => b.click('.cluster-dialog button[type="submit"]'),
    // Dispatch `tasks` ([{ title, prompt }], a title may be '') from `parent` through the screen; returns the cluster as the Hub has it.
    async dispatch(parent, tasks, { note, fork = false, isolate = true } = {}) {
      await page.openDialog(parent.id);
      for (let i = 1; i < tasks.length; i++) await b.click('[data-action="add-task"]');
      for (const [i, t] of tasks.entries()) await page.fillTask(i, t.title, t.prompt);
      if (note) await page.typeInto('textarea[name="note"]', note);
      if (fork) await b.eval(`[...document.querySelectorAll('[data-field="mode"] button')].find((x) => x.innerText.includes('完整分叉')).click()`);
      if (!isolate) await b.click('input[name="isolate"]');
      await page.submitDialog();
      await b.waitFor(`/^#\\/cluster\\//.test(location.hash)`, { timeout: 30000 });
      const cid = await b.eval('location.hash.slice(10)');
      await b.waitFor(`document.querySelectorAll('.cluster-worker').length === ${tasks.length}`);
      return cluster(cid);
    },
  };
  return page;
}
