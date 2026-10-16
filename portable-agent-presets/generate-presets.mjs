// regenerate wiring.yml from ./agent-presets/<name>/{preset.yml, agent.cordis.yml}
//   usage: node generate-presets.mjs
//   This package stays regenerable: edit the preset source files under
//   ./agent-presets, then rerun this script and commit the new wiring.yml.
//   Legacy package aliases (packages that no longer exist in the installed dsh)
//   are rewritten defensively so stale preset files cannot silently break a
//   preset (registry marks such a preset `broken` and the UI hides it).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)));
const SRC = join(PKG_DIR, 'agent-presets');
const OUT = join(PKG_DIR, 'wiring.yml');

// Known packages that the bundled dsh cannot load -> correct replacement.
const LEGACY_ALIASES = new Map([
  ['@deepseek-ai/dsh-workflow-worker-thread', '@deepseek-ai/dsh-workflow-ptc'],
]);
const LEGACY_ROW_IDS = new Map([
  ['workflow-worker-thread', 'workflow-ptc'],
]);

const BEGIN_MARKER = '# === dsh portable agent presets: BEGIN (managed block) ===';
const END_MARKER = '# === dsh portable agent presets: END (managed block) ===';

function isPresetDir(entry) {
  return statSync(join(SRC, entry)).isDirectory();
}

function loadPreset(name) {
  const preset = {};
  for (const line of readFileSync(join(SRC, name, 'preset.yml'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z]+):\s*(.*)$/);
    if (m) preset[m[1]] = m[2];
  }
  const body = readFileSync(join(SRC, name, 'agent.cordis.yml'), 'utf8');
  // Defensive legacy rewrite (whole-line + row-id level).
  let fixed = body;
  for (const [from, to] of LEGACY_ALIASES) fixed = fixed.split(from).join(to);
  for (const [from, to] of LEGACY_ROW_IDS) fixed = fixed.replace(new RegExp(`^\\s*-\\s*id:\\s*${from}$`, 'gm'), `- id: ${to}`);
  return { name, preset, body: fixed };
}

const entries = readdirSync(SRC).filter(isPresetDir).sort().map(loadPreset);
if (entries.length === 0) {
  console.error('no preset directories under ' + SRC);
  process.exit(1);
}

const lines = [];
lines.push('# Wired from ./agent-presets/<name>/ by generate-presets.mjs — rerun to regerate.');
lines.push('# Append this block to ~/.dsh/profiles/web/cordis.patch.yml (install.sh does it for you).');
lines.push(BEGIN_MARKER);
lines.push('- insert:');
for (const e of entries) {
  const disp = e.preset.name ?? e.name;
  const desc = e.preset.description ?? '';
  const order = e.preset.order ?? '';
  lines.push(`    - id: preset-${e.name}`);
  lines.push("      name: '@deepseek-ai/dsh-agent-preset'");
  lines.push('      config:');
  lines.push(`        id: ${e.name}`);
  lines.push(`        name: ${disp}`);
  if (desc) {
    lines.push('        description: >-');
    lines.push('          ' + desc.replace(/\s+/g, ' ').trim());
  }
  if (order) lines.push(`        order: ${order}`);
  lines.push('        plugins:');
  for (const raw of e.body.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    lines.push(line.length ? '          ' + line : '');
  }
}
lines.push(END_MARKER);
lines.push('');
writeFileSync(OUT, lines.join('\n'));
console.log(`wrote ${OUT} (${entries.map((e) => e.name).join(', ')}) — ${lines.length} lines`);
