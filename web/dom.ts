// Minimal DOM builder and form fields. The app re-renders from state on every
// change, so these only build elements; they never patch.

export type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, any>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'checked' || k === 'selected' || k === 'disabled' || k === 'value') (el as any)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

/** Links to documentation always open in a new tab. */
export function extLink(href: string, text: Child): HTMLAnchorElement {
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
}

// Field ids restart on each render, so the same field keeps its id and focus
// can be restored after a re-render.
let uid = 0;
const nextId = () => `f${++uid}`;
export function resetIds() { uid = 0; }

export interface Option<T extends string = string> { value: T; label: string; disabled?: boolean; group?: string; }

export function select<T extends string>(label: string, value: T | '', options: Option<T>[], onChange: (v: T) => void, hint?: Child): HTMLElement {
  const id = nextId();
  const groups = new Map<string, Option<T>[]>();
  for (const o of options) groups.set(o.group ?? '', [...(groups.get(o.group ?? '') ?? []), o]);
  const opt = (o: Option<T>) => h('option', { value: o.value, selected: o.value === value, disabled: o.disabled }, o.label);
  return h('div', { class: 'field' },
    h('label', { class: 'label', for: id }, label),
    h('select', { id, onChange: (e: Event) => onChange((e.target as HTMLSelectElement).value as T) },
      [...groups].map(([g, os]) => (g ? h('optgroup', { label: g }, os.map(opt)) : os.map(opt)))),
    hint ? h('div', { class: 'hint' }, hint) : null);
}

export function segmented<T extends string>(legend: string, value: T, options: Option<T>[], onChange: (v: T) => void, hint?: Child): HTMLElement {
  const name = nextId();
  return h('fieldset', { class: 'field' },
    h('legend', { class: 'label' }, legend),
    h('div', { class: 'seg' }, options.map((o) =>
      h('label', { class: o.disabled ? 'off' : o.value === value ? 'on' : '' },
        h('input', { type: 'radio', name, value: o.value, checked: o.value === value, disabled: o.disabled, onChange: () => onChange(o.value) }),
        o.label))),
    hint ? h('div', { class: 'hint' }, hint) : null);
}

export function numberField(label: string, value: number | undefined, onChange: (v: number | undefined) => void,
  opts: { min?: number; max?: number; step?: number; placeholder?: string; hint?: Child } = {}): HTMLElement {
  const id = nextId();
  return h('div', { class: 'field' },
    h('label', { class: 'label', for: id }, label),
    h('input', {
      id, type: 'number', inputmode: 'decimal', min: opts.min, max: opts.max, step: opts.step ?? 'any',
      placeholder: opts.placeholder, value: value === undefined ? '' : String(value),
      onChange: (e: Event) => {
        const raw = (e.target as HTMLInputElement).value.trim();
        const n = Number(raw);
        onChange(raw === '' || !Number.isFinite(n) ? undefined : n);
      },
    }),
    opts.hint ? h('div', { class: 'hint' }, opts.hint) : null);
}

export function checkbox(label: Child, checked: boolean, onChange: (v: boolean) => void, hint?: Child, disabled = false): HTMLElement {
  return h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked, disabled, onChange: (e: Event) => onChange((e.target as HTMLInputElement).checked) }),
    h('span', null, h('span', null, label), hint ? h('span', { class: 'hint' }, hint) : null));
}

export function pill(text: string, tone: 'ok' | 'warn' | 'bad' | 'info'): HTMLElement {
  return h('span', { class: `pill ${tone}` }, text);
}

/** Offer a Blob as a download. */
export function download(name: string, data: Blob) {
  const url = URL.createObjectURL(data);
  const a = h('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
