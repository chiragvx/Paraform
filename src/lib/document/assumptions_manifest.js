/**
 * Assumptions manifest export (spec 09).
 *
 * Produces a human-readable markdown report grouped by source, then a
 * table of detail / default / acknowledged status. Pure function over an
 * array of AssumptionRecord — no DOM, no store imports, so it can be
 * exercised under node:assert directly.
 */

const SOURCE_LABELS = {
  extractor:        'Extractor (spec text)',
  invariant:        'Engineering invariants',
  'standard-parts': 'Standard parts catalog',
  kernel:           'Kernel',
  user:             'User',
};

function escapeCell(v) {
  if (v == null) return '—';
  return String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/**
 * Build a markdown report.
 * @param {object[]} assumptions
 * @param {{ title?: string, generatedAt?: number|string }} [opts]
 * @returns {string}
 */
export function exportAssumptionsManifest(assumptions = [], { title = 'Assumptions manifest', generatedAt = Date.now() } = {}) {
  const list = Array.isArray(assumptions) ? assumptions.filter(Boolean) : [];
  const when = (typeof generatedAt === 'number')
    ? new Date(generatedAt).toISOString()
    : String(generatedAt);

  const total = list.length;
  const ack   = list.filter(a => a.acknowledged).length;
  const warn  = list.filter(a => a.severity === 'warning').length;

  const lines = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`_Generated ${when}_`);
  lines.push('');
  lines.push(`**Total:** ${total} · **Acknowledged:** ${ack} / ${total} · **Warnings:** ${warn}`);
  lines.push('');

  if (total === 0) {
    lines.push('_No assumptions recorded. Every value in this document was either supplied explicitly or derived from a parametric input._');
    lines.push('');
    return lines.join('\n');
  }

  // Group by source.
  const bySource = new Map();
  for (const a of list) {
    const src = a.source || 'user';
    if (!bySource.has(src)) bySource.set(src, []);
    bySource.get(src).push(a);
  }
  const sourceOrder = ['extractor', 'standard-parts', 'invariant', 'kernel', 'user'];
  const ordered = sourceOrder
    .filter(s => bySource.has(s))
    .concat([...bySource.keys()].filter(s => !sourceOrder.includes(s)));

  for (const src of ordered) {
    const rows = bySource.get(src) || [];
    lines.push(`## ${SOURCE_LABELS[src] || src} (${rows.length})`);
    lines.push('');
    lines.push('| Kind | Detail | Default | Severity | Acknowledged |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const a of rows) {
      lines.push(
        `| ${escapeCell(a.kind)} | ${escapeCell(a.detail)} | ${escapeCell(a.defaultUsed)} | ${escapeCell(a.severity)} | ${a.acknowledged ? 'yes' : 'no'} |`
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Filename for a markdown download.
 */
export function defaultManifestFilename(docName = 'document') {
  const safe = String(docName).replace(/[\\/:*?"<>|]+/g, '_') || 'document';
  return `${safe}-assumptions.md`;
}

export const ASSUMPTION_SOURCES = Object.freeze(['extractor', 'invariant', 'standard-parts', 'kernel', 'user']);
