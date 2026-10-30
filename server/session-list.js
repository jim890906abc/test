// The conversations as the sidebar lists them. A summary (runner.summarize) is
// what the open conversation needs; the sidebar needs a row's worth of it. The
// computer's model list and skill list, the message queue and the to-do list
// sit in a summary's `meta` and are most of its bytes (the VPS Hub's list was
// 612 KB for 90 conversations, 11 KB for the biggest one); they are taken out
// of what is listed and arrive with the snapshot when the conversation is opened.
//
// And the workers of a cluster are not listed as conversations: a cluster opens
// a dozen of them and nobody scrolls the sidebar to find them. They come as a
// few fields each (a stub: enough for the sidebar to count them, to find one by
// name in a search and to say when one needs you), and the whole summary only
// when one is opened. Taking them out of the list loses none of them - they
// are as openable by address as ever.
import * as store from './store.js';
import * as runner from './runner.js';
import { OMITTED_FROM_LIST, isClusterWorker, listForm, workerStub } from '../public/js/list-form.js';

export { OMITTED_FROM_LIST, isClusterWorker, listForm, workerStub };

const byRecency = (a, b) => b.updatedAt - a.updatedAt;

// GET /api/sessions?for=sidebar: one array like the plain list - the leaf of every
// conversation in listed form, and each cluster worker as a stub (`stub: true`).
export function sidebarSessions() {
  const out = [];
  const stubs = [];
  for (const s of store.listLeaves()) {
    const summary = runner.summarize(s);
    if (isClusterWorker(s)) stubs.push(workerStub(summary));
    else out.push(listForm(summary));
  }
  return [...out.sort(byRecency), ...stubs.sort(byRecency)];
}
