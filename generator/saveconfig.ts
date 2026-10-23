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

/** What a saved z_offset / Z position_endstop depends on: the probe, the Z homing method, and the
 *  nozzle(s) the offset was measured with (hotend and toolhead change the nozzle height). */
export function buildFingerprint(b: { probe?: string; homing: { z: string }; toolchanger?: any; hotend?: string; toolhead?: string }): string {
  const tools = (b.toolchanger?.tools ?? []).map((t: any) => t.hotend ?? b.hotend).join(',');
  return `probe=${b.toolchanger ? 'tool_probe' : b.probe ?? 'none'} z=${b.homing.z} hotend=${b.hotend ?? 'none'}${tools ? `,${tools}` : ''} toolhead=${b.toolhead ?? 'none'}`;
}
const readFingerprint = (cfg: string | undefined) => {
  const m = /^# build: (.*)$/m.exec(cfg ?? '');
  return m ? Object.fromEntries(m[1].trim().split(/\s+/).map((kv) => kv.split('=') as [string, string])) as Record<string, string> : undefined;
};

export interface CarryOver {
  printerCfg: string;
  kept: string[];
  dropped: Array<{ section: string; option?: string; why: string }>;
}

export function carryOverSaveConfig(files: Record<string, string>, oldPrinterCfg: string | undefined): CarryOver {
  let printerCfg = files['printer.cfg'];
  const saved = oldPrinterCfg ? readAutosave(oldPrinterCfg) : [];
  if (!saved.length) return { printerCfg, kept: [], dropped: [] };
  const sections = generatedSections(files);
  const zHomesWithProbe = /^\[stepper_z\][^[]*^endstop_pin:\s*probe:z_virtual_endstop/m.test(Object.values(files).join('\n'));
  // A Z offset or Z endstop position measured for another probe / homing method can crash the nozzle;
  // a config without the build line (hand-written, or older) can't show it is the same, so those go too.
  const was = readFingerprint(oldPrinterCfg);
  const now = readFingerprint(printerCfg);
  const sameProbe = !!was && !!now && ['probe', 'hotend', 'toolhead'].every((k) => was[k] !== undefined && was[k] === now[k]);
  const sameZ = !!was && !!now && was.z === now.z;
  const PROBE_SECTION = /^(probe|bltouch|tool_probe .+|probe_eddy_current .+|beacon|cartographer)$/;
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
      if (s.name === 'stepper_z' && k === 'position_endstop' && !sameZ) {
        dropped.push({ section: s.name, option: k, why: 'Z homing changed (or the old config does not say how it homed): run Z_ENDSTOP_CALIBRATE again' });
        return false;
      }
      if (PROBE_SECTION.test(s.name) && /^(z_offset|tap_z_offset)$/.test(k) && !sameProbe) {
        dropped.push({ section: s.name, option: k, why: 'the probe, hotend or toolhead changed (or the old config does not say): run PROBE_CALIBRATE again' });
        return false;
      }
      return true;
    });
    if (options.length) kept.push({ name: s.name, options });
  }
  if (!kept.length) return { printerCfg, kept: [], dropped };
  // Klipper ignores a saved value when printer.cfg itself sets the same option (configfile.py
  // _strip_duplicates), so comment those lines out, as Klipper's own SAVE_CONFIG does.
  const savedKeys = new Set(kept.flatMap((s) => s.options.map(([k]) => `${s.name}\u0000${k.toLowerCase()}`)));
  let section = '';
  let inDup = false;
  const bodyLines = printerCfg.split('\n').map((line) => {
    const h = /^\[([^\]]+)\]/.exec(line);
    if (h) { section = h[1].trim(); inDup = false; return line; }
    if (/^\s/.test(line) && line.trim()) return inDup ? `#${line}` : line;   // continuation of a multi-line value
    const k = /^([A-Za-z0-9_]+)\s*[:=]/.exec(line);
    inDup = !!k && savedKeys.has(`${section}\u0000${k[1].toLowerCase()}`);
    return inDup ? `#${line}` : line;
  });
  printerCfg = bodyLines.join('\n');
  const body = kept.map((s) => [`#*# [${s.name}]`, ...s.options.map(([k, v]) => `#*# ${k} = ${v.split('\n').join('\n#*# ')}`)].join('\n')).join('\n#*#\n');
  return {
    printerCfg: printerCfg.replace(/\s*$/, '\n') + AUTOSAVE_HEADER + body + '\n',
    kept: kept.map((s) => s.name),
    dropped,
  };
}
