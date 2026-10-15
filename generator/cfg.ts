// Minimal Klipper config writer. Keeps key order, supports per-key comments
// and multi-line values (indented continuation lines).

export type Value = string | number | boolean | Array<string | number> | null | undefined;

export class Section {
  name: string;
  comment?: string;
  entries: Array<[string, Value, string | undefined]> = [];

  constructor(name: string, comment?: string) {
    this.name = name;
    this.comment = comment;
  }

  set(key: string, value: Value, comment?: string): this {
    if (value !== undefined && value !== null) this.entries.push([key, value, comment]);
    return this;
  }

  render(): string {
    const out: string[] = [];
    out.push(this.comment ? `[${this.name}]  # ${this.comment}` : `[${this.name}]`);
    for (const [k, v, c] of this.entries) {
      const tail = c ? `   # ${c}` : '';
      if (Array.isArray(v)) {
        out.push(`${k}:${tail}`);
        for (const line of v) out.push(`    ${line}`);
      } else if (typeof v === 'string' && v.includes('\n')) {
        out.push(`${k}:${tail}`);
        for (const line of v.split('\n')) out.push(line ? `    ${line}` : '');
      } else {
        out.push(`${k}: ${fmt(v)}${tail}`);
      }
    }
    return out.join('\n');
  }
}

function fmt(v: Value): string {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(+v.toFixed(4));
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  return String(v);
}

export class CfgFile {
  header: string[];
  blocks: string[] = [];

  constructor(header: string[]) {
    this.header = header;
  }

  add(s: Section | string): this {
    this.blocks.push(typeof s === 'string' ? s : s.render());
    return this;
  }

  render(): string {
    const head = this.header.map((h) => `# ${h}`.trimEnd()).join('\n');
    return [head, ...this.blocks].join('\n\n') + '\n';
  }
}
