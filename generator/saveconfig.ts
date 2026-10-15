// Carry the SAVE_CONFIG block (PID values, probe z_offset, meshes, input
// shaper, toolchanger dock params...) from an existing printer.cfg into a newly
// generated one. Klipper loads every saved section as a config section, so a
// saved section for hardware the new config lacks (e.g. [bltouch] z_offset)
// stops Klipper with "Option ... must be specified": those are dropped and
// reported. Saved options are exempt from Klipper's unused-option check
// (configfile.py check_unused), so options are kept except known-dead ones.
// Format: Klipper klippy/configfile.py (AUTOSAVE_HEADER, _find_autosave_data).

export const AUTOSAVE_HEADER = `
#*# <---------------------- SAVE_CONFIG ---------------------->
#*# DO NOT EDIT THIS BLOCK OR BELOW. The contents are auto-generated.
#*#
`;

export interface SavedSection {
  name: string;
  options: Array<[string, string]>;   // key, value (value may span lines; kept as written)
}

/** Parse the SAVE_CONFIG block of a printer.cfg; [] when there is none. */
export function readAutosave(text: string): SavedSection[] {
  const pos = text.indexOf(AUTOSAVE_HEADER);
  if (pos < 0) return [];
  const sections: SavedSection[] = [];
  let cur: SavedSection | undefined;
  for (const raw of text.slice(pos + AUTOSAVE_HEADER.length).split('\n')) {
    if (!raw.startsWith('#*#')) continue;
    const line = raw.slice(4);
    const head = /^\[([^\]]+)\]\s*$/.exec(line);
    if (head) { cur = { name: head[1].trim(), options: [] }; sections.push(cur); continue; }
    if (!cur || !line.trim()) continue;
    const kv = /^([A-Za-z0-9_]+)\s*[:=]\s?(.*)$/.exec(line);
    if (kv) cur.options.push([kv[1], kv[2]]);
    else if (cur.options.length) cur.options[cur.options.length - 1][1] += '\n' + line;   // multi-line value (bed mesh points)
  }
  return sections;
}

const SECTION_RE = /^\[([^\]]+)\]/gm;

/** Section names defined in the generated .cfg files (includes excluded). */
export function generatedSections(files: Record<string, string>): Set<string> {
  const out = new Set<string>();
  for (const [name, text] of Object.entries(files)) {
    if (!name.endsWith('.cfg')) continue;
    for (const m of text.matchAll(SECTION_RE)) if (!m[1].startsWith('include ')) out.add(m[1].trim());
  }
  return out;
}

export interface CarryOver {
  printerCfg: string;
  kept: string[];
  dropped: Array<{ section: string; option?: string; why: string }>;
}

export function carryOverSaveConfig(files: Record<string, string>, oldPrinterCfg: string | undefined): CarryOver {
  const printerCfg = files['printer.cfg'];
  const saved = oldPrinterCfg ? readAutosave(oldPrinterCfg) : [];
  if (!saved.length) return { printerCfg, kept: [], dropped: [] };
  const sections = generatedSections(files);
  const zHomesWithProbe = /^\[stepper_z\][^[]*^endstop_pin:\s*probe:z_virtual_endstop/m.test(Object.values(files).join('\n'));
  const kept: SavedSection[] = [];
  const dropped: CarryOver['dropped'] = [];
  for (const s of saved) {
    // SAVE_CONFIG creates [input_shaper] and bed mesh profiles itself; everything
    // else must exist in the new config or Klipper refuses to start.
    const creatable = s.name === 'input_shaper' || (s.name.startsWith('bed_mesh ') && sections.has('bed_mesh'));
    if (!sections.has(s.name) && !creatable) {
      dropped.push({ section: s.name, why: 'not in the new config' });
      continue;
    }
    const options = s.options.filter(([k]) => {
      if (s.name === 'stepper_z' && k === 'position_endstop' && zHomesWithProbe) {
        dropped.push({ section: s.name, option: k, why: 'unused now that Z homes with the probe' });
        return false;
      }
      return true;
    });
    if (options.length) kept.push({ name: s.name, options });
  }
  if (!kept.length) return { printerCfg, kept: [], dropped };
  const body = kept.map((s) => [`#*# [${s.name}]`, ...s.options.map(([k, v]) => `#*# ${k} = ${v.split('\n').join('\n#*# ')}`)].join('\n')).join('\n#*#\n');
  return {
    printerCfg: printerCfg.replace(/\s*$/, '\n') + AUTOSAVE_HEADER + body + '\n',
    kept: kept.map((s) => s.name),
    dropped,
  };
}
