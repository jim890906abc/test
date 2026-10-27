// A change of colours (look, light/dark) as one picture fading into the next.
//
// The browser keeps a picture of the page as it is, the change is made, and the
// old picture fades out over the new page (the View Transitions API; the fade
// itself is the ::view-transition rules in app.css, run by the compositor).
// Nothing is transitioned element by element: a colour transition on every
// element makes the browser work out every element's style again on every
// frame, which on a long conversation took half a second of style work per
// change and stuttered the whole fade. Here the cost does not grow with the page.
//
// Without the API, with prefers-reduced-motion, or in a hidden tab, the change
// is simply made at once. (While a fade runs, about --dur-base, the browser
// takes no pointer input for the page — its rule for view transitions; the
// keyboard is not affected, and a click in that moment is not delivered.)

const root = document.documentElement;
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// While a fade is running the page carries `data-color-fade` (tests and probes
// wait for it to go). A change made during a fade starts its own: the browser
// ends the running one on the spot, so fades never pile up.
let latest = null;

// Make `change()` (it sets the colours) and fade from the look the page has to
// the one it gets. `change` runs exactly once, now or on the next frame; the
// returned promise settles when the new colours are in the page (not when the
// fade is over), and rejects if `change` throws.
export function fadeColors(change) {
  let done = false;
  const apply = () => {
    if (done) return;
    done = true;
    change();
  };
  if (typeof document.startViewTransition !== 'function' || reduced() || document.hidden) {
    apply();
    return Promise.resolve();
  }
  let transition;
  try {
    transition = document.startViewTransition(apply);
  } catch {
    apply();
    return Promise.resolve();
  }
  latest = transition;
  root.dataset.colorFade = '';
  const over = () => {
    if (latest !== transition) return;
    latest = null;
    delete root.dataset.colorFade;
  };
  // A fade ended early by the next change reports that as a rejection of `ready`.
  transition.ready.catch(() => {});
  transition.finished.then(over, over);
  return transition.updateCallbackDone;
}
