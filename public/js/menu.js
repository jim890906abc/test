// Popover menus (om-menu) anchored to a control, with keyboard navigation.
import { h, icon } from './dom.js';

let open = null;

export function closeMenu() {
  if (!open) return;
  const { el, onClose, anchor } = open;
  open = null;
  el.remove();
  anchor?.setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', outside, true);
  document.removeEventListener('keydown', keys, true);
  window.removeEventListener('resize', closeMenu);
  onClose?.();
}

function outside(e) {
  if (open && !open.el.contains(e.target) && !open.anchor?.contains(e.target)) closeMenu();
}

function items() {
  return [...open.el.querySelectorAll('.om-menu__item:not([aria-disabled="true"])')];
}

function keys(e) {
  if (!open) return;
  const list = items();
  const i = list.indexOf(document.activeElement);
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    const anchor = open.anchor;
    closeMenu();
    anchor?.focus();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
    list[i === -1 ? 0 : next]?.focus();
  } else if (e.key === 'Tab') closeMenu();
}

// entries: { label, hint, icon, checked, disabled, destructive, onSelect, keepOpen }
//          | { separator: true } | { section: 'Title' } | { node: Element }
// A point (right-click) to anchor a menu to, shaped like an element.
export function pointAnchor(x, y) {
  return { getBoundingClientRect: () => ({ left: x, right: x, top: y, bottom: y }), setAttribute() {}, contains: () => false, focus() {} };
}

export function openMenu(anchor, entries, { align = 'start', side = 'auto', width, onClose, className = '' } = {}) {
  const wasOpen = open?.anchor === anchor;
  closeMenu();
  if (wasOpen) return null;
  const el = h('div', { class: `om-menu popover ${className}`, role: 'menu', style: width ? { width: `${width}px` } : null });
  const hasChecks = entries.some((e) => 'checked' in e);
  for (const e of entries) {
    if (e.separator) el.append(h('div', { class: 'om-menu__sep', role: 'separator' }));
    else if (e.section) el.append(h('div', { class: 'menu-section' }, e.section));
    else if (e.node) el.append(e.node);
    else {
      const item = h(
        'div',
        {
          class: `om-menu__item${e.destructive ? ' om-menu__item--destructive' : ''}${e.description ? ' has-desc' : ''}`,
          role: hasChecks ? 'menuitemradio' : 'menuitem',
          tabindex: '-1',
          'aria-disabled': e.disabled ? 'true' : null,
          'aria-checked': hasChecks ? String(Boolean(e.checked)) : null,
          onclick: () => {
            if (e.disabled) return;
            if (!e.keepOpen) closeMenu();
            e.onSelect?.();
          },
          onkeydown: (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
              ev.preventDefault();
              item.click();
            }
          },
        },
        hasChecks ? h('span', { class: 'om-menu__check' }, e.checked ? '✓' : '') : null,
        e.icon ? icon(e.icon) : null,
        h('span', { class: 'menu-label' }, e.label, e.description ? h('span', { class: 'menu-desc' }, e.description) : null),
        e.hint ? h('span', { class: 'om-menu__shortcut' }, e.hint) : null,
      );
      el.append(item);
    }
  }
  document.body.append(el);
  place(el, anchor, { align, side });
  open = { el, anchor, onClose };
  anchor?.setAttribute('aria-expanded', 'true');
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', keys, true);
  window.addEventListener('resize', closeMenu);
  (el.querySelector('[aria-checked="true"]') || items()[0])?.focus({ preventScroll: true });
  return el;
}

export function place(el, anchor, { align = 'start', side = 'auto', gap = 6 } = {}) {
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const ht = el.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const below = side === 'below' || (side === 'auto' && vh - r.bottom >= ht + gap + 8) || (side === 'auto' && r.top < ht + gap + 8 && vh - r.bottom > r.top);
  let top = below ? r.bottom + gap : r.top - ht - gap;
  let left = align === 'end' ? r.right - w : r.left;
  left = Math.max(8, Math.min(left, vw - w - 8));
  top = Math.max(8, Math.min(top, vh - ht - 8));
  Object.assign(el.style, { left: `${left}px`, top: `${top}px` });
}

export const menuOpen = () => Boolean(open);
