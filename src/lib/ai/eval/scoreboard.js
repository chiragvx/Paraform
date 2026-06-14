/**
 * Scoreboard — render an array of TaskScores (from ../scorer.js) into a
 * markdown report the project currently lacks: a per-task pass/fail table, an
 * aggregate pass-rate, and a literature-comparable metrics block.
 *
 *   formatScoreboard(scores, opts?) → markdown string
 *   aggregate(scores)              → { tasks, passed, passRate, checks, checksPassed, checkRate }
 *
 * Pure + deterministic — no Date.now (the caller may stamp a date into `opts`),
 * no Math.random, stable column order, scores rendered in the order given.
 *
 * The "single-part metrics" row carries placeholders — chamferDistance, IoU,
 * invalidityRatio — that are the de-facto text-to-CAD literature metrics. They
 * are NOT computed here (they need the reference solid + the kernel); the
 * column exists so that when a runner later measures them, results drop into a
 * table that is already shaped to sit next to published numbers.
 */

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const tick = (b) => (b ? '✅' : '❌');

/**
 * Aggregate a scoreboard: task pass-rate AND check pass-rate (the finer signal
 * — a task can fail on 1 of 9 checks and that 8/9 is worth seeing).
 *
 * @param {Array} scores  — TaskScore[]
 */
export function aggregate(scores) {
    const rows = Array.isArray(scores) ? scores : [];
    const tasks = rows.length;
    const passed = rows.filter((s) => s && s.passed).length;
    let checks = 0;
    let checksPassed = 0;
    for (const s of rows) {
        checks += Number(s && s.total) || 0;
        checksPassed += Number(s && s.passedCount) || 0;
    }
    return {
        tasks,
        passed,
        passRate: tasks ? passed / tasks : 0,
        checks,
        checksPassed,
        checkRate: checks ? checksPassed / checks : 0,
    };
}

/** Escape a value for a one-line markdown table cell. */
function cell(v) {
    if (v === null || v === undefined) return '—';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/**
 * Render the markdown scoreboard.
 *
 * @param {Array} scores — TaskScore[] from scoreSuite / scoreTask
 * @param {object} [opts]
 * @param {string} [opts.title]   — heading text
 * @param {string} [opts.stamp]   — optional run label (model id, commit, date) —
 *                                  caller-supplied so this stays deterministic.
 * @param {Record<string, {chamferDistance?:number, iou?:number, invalidityRatio?:number}>} [opts.metrics]
 *        — optional per-taskId single-part metrics to fill the placeholder row.
 * @returns {string} markdown
 */
export function formatScoreboard(scores, opts = {}) {
    const rows = Array.isArray(scores) ? scores : [];
    const agg = aggregate(rows);
    const title = opts.title || 'CAD eval scoreboard';
    const metrics = opts.metrics || {};

    const lines = [];
    lines.push(`# ${title}`);
    lines.push('');
    if (opts.stamp) lines.push(`_${opts.stamp}_`, '');
    lines.push(
        `**Tasks passed:** ${agg.passed} / ${agg.tasks} (${pct(agg.passRate)})  •  ` +
        `**Checks passed:** ${agg.checksPassed} / ${agg.checks} (${pct(agg.checkRate)})`,
    );
    lines.push('');

    // ── per-task result table ────────────────────────────────────────────────
    lines.push('## Tasks');
    lines.push('');
    lines.push('| Task | Result | Checks | Score | First failure |');
    lines.push('| --- | :---: | :---: | :---: | --- |');
    for (const s of rows) {
        const first = (s.failures && s.failures[0]) || null;
        const failTxt = first
            ? `\`${cell(first.check && first.check.kind)}\`: expected ${cell(first.expected)}, got ${cell(first.actual)}`
            : '—';
        lines.push(
            `| ${cell(s.taskId)} | ${tick(s.passed)} | ${s.passedCount}/${s.total} | ` +
            `${pct(s.score)} | ${failTxt} |`,
        );
    }
    lines.push('');

    // ── single-part literature metrics (placeholders until wired) ────────────
    lines.push('## Single-part metrics (literature-comparable)');
    lines.push('');
    lines.push('> Placeholders — populate from a runner that has the reference solid + kernel.');
    lines.push('');
    lines.push('| Task | Chamfer distance (mm) | IoU | Invalidity ratio |');
    lines.push('| --- | :---: | :---: | :---: |');
    for (const s of rows) {
        const m = metrics[s.taskId] || {};
        lines.push(
            `| ${cell(s.taskId)} | ${cell(m.chamferDistance)} | ${cell(m.iou)} | ${cell(m.invalidityRatio)} |`,
        );
    }
    lines.push('');

    return lines.join('\n');
}

export default formatScoreboard;
