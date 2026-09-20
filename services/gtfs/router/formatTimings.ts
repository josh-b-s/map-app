// formatTimings.ts
//
// Turns the flat `{label, ms}[]` list coming back from the Rust engine into a
// readable multi-line report. The Rust side piggybacks counts, flags and
// second-valued numbers on the same (label, i64) channel as real millisecond
// durations, so this file is what tells them apart:
//
//   - `count.*` / `*.count.*`            -> plain counts (never ms)
//   - `window.*_sec`                     -> seconds
//   - MISC_LABELS                        -> flags / small integers
//   - `windowed_discovery_and_fetch.attemptN_windowXs_tripsY_rowsZ`
//                                        -> a duration whose label carries data
//   - everything else                    -> milliseconds
//
// `failed_attempt.*` labels come from lib.rs's retry path and are formatted as
// their own block so they don't get mixed into the successful attempt.

// uniffi maps Rust i64 to JS bigint, so `ms` can arrive as either type.
// Everything below works on plain numbers; formatTimings() converts once.
export interface TimingEntryLike {
    label: string;
    ms: number | bigint;
}

interface NumTiming {
    label: string;
    ms: number;
}

const COUNT_RE = /(^|\.)count\./;
const WINDOW_SEC_RE = /^window\..*_sec$/;
const ATTEMPT_RE = /^windowed_discovery_and_fetch\.attempt(\d+)_window(\d+)s_trips(\d+)_rows(\d+)$/;
const MISC_LABELS = new Set([
    'active_trip_filter_sql',
    'freq_raptor.fallback_to_full',
    'windowed_trip_discovery.stages_tried',
    'seed_batch_retry.from_batch_size',
]);
// Top-level stages that run AFTER (or outside) the loader's own `total`, so a
// "% of load" figure would be misleading for them.
const NO_PCT = new Set(['total', 'raptor_search', 'journey_shape_resolve', 'journey_select', 'debug_emit']);

const LINE_WIDTH = 100;
const BAR_WIDTH = 16;

const fmtInt = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const fmtSec = (s: number): string => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${fmtInt(s)}s (${h}h${String(m).padStart(2, '0')}m)`;
    if (m > 0) return `${fmtInt(s)}s (${m}m)`;
    return `${fmtInt(s)}s`;
};

const bar = (frac: number): string => {
    const n = Math.max(0, Math.min(BAR_WIDTH, Math.round(frac * BAR_WIDTH)));
    return '█'.repeat(n) + '·'.repeat(BAR_WIDTH - n);
};

/** Joins `key value` items with " · ", wrapping onto indented lines. */
const wrapItems = (items: string[], indent: string): string[] => {
    const lines: string[] = [];
    let cur = indent;
    for (const item of items) {
        const sep = cur.trim().length === 0 ? '' : ' · ';
        if (cur.length + sep.length + item.length > LINE_WIDTH && cur.trim().length > 0) {
            lines.push(cur);
            cur = indent + item;
        } else {
            cur += sep + item;
        }
    }
    if (cur.trim().length > 0) lines.push(cur);
    return lines;
};

const section = (title: string): string => `  ${title}`;

function formatBlock(entries: NumTiming[]): string[] {
    const stages: NumTiming[] = [];      // top-level ms stages, execution order
    const detail: NumTiming[] = [];      // dotted ms entries (corridor.* etc.)
    const attempts: { n: number; win: number; trips: number; rows: number; ms: number }[] = [];
    const counts: NumTiming[] = [];
    const windows: NumTiming[] = [];
    const misc: NumTiming[] = [];

    for (const e of entries) {
        const attempt = ATTEMPT_RE.exec(e.label);
        if (attempt) {
            attempts.push({ n: +attempt[1], win: +attempt[2], trips: +attempt[3], rows: +attempt[4], ms: e.ms });
        } else if (COUNT_RE.test(e.label)) counts.push(e);
        else if (WINDOW_SEC_RE.test(e.label)) windows.push(e);
        else if (MISC_LABELS.has(e.label)) misc.push(e);
        else if (e.label.includes('.')) detail.push(e);
        else stages.push(e);
    }

    const out: string[] = [];
    const total = stages.find(s => s.label === 'total')?.ms ?? 0;
    const raptor = stages.find(s => s.label === 'raptor_search')?.ms;

    // ── headline ──
    const head: string[] = [];
    if (total > 0) head.push(`load ${fmtInt(total)}ms`);
    if (raptor !== undefined) head.push(`raptor ${fmtInt(raptor)}ms`);
    if (head.length) out.push('  ' + head.join(' + '));

    // ── top-level stages, with % of load and a bar so hotspots stand out ──
    const shown = stages.filter(s => s.label !== 'total' && s.ms > 0);
    if (shown.length) {
        out.push(section('stages (ms, % of load)'));
        const nameW = Math.max(...shown.map(s => s.label.length));
        const msW = Math.max(...shown.map(s => fmtInt(s.ms).length));
        for (const s of shown) {
            const pct = !NO_PCT.has(s.label) && total > 0 ? s.ms / total : null;
            const pctStr = pct === null ? '    ' : `${String(Math.round(pct * 100)).padStart(3)}%`;
            const b = pct === null ? ' '.repeat(BAR_WIDTH) : bar(pct);
            out.push(`    ${s.label.padEnd(nameW)}  ${fmtInt(s.ms).padStart(msW)}  ${pctStr}  ${b}`);
        }
        const zero = stages.filter(s => s.label !== 'total' && s.ms <= 0).map(s => s.label);
        if (zero.length) out.push(...wrapItems([`0ms: ${zero.join(', ')}`], '    '));
    }

    // ── timetable fetch attempts (label-embedded data) ──
    if (attempts.length) {
        out.push(section('stop_times fetch'));
        // Fetch cost scales with how many stops get a time-range seek (each one
        // scans every departure at that stop inside the window), not with rows
        // returned — so report ms per queried stop, which stays comparable
        // between runs (~0.1ms warm, ~0.2ms cold), unlike µs/row.
        const stopsQueried =
            counts.find(c => c.label === 'count.fetch_stops_queried')?.ms ??
            counts.find(c => c.label === 'count.seed_path_narrowed_stop_pks')?.ms;
        const stopsWithRows = counts.find(c => c.label === 'count.stop_times_distinct_stops')?.ms;
        for (const a of attempts) {
            const perStop = stopsQueried && stopsQueried > 0 ? ` (${(a.ms / stopsQueried).toFixed(2)}ms/stop)` : '';
            out.push(
                `    attempt ${a.n}: window ${fmtSec(a.win)} → ${fmtInt(a.trips)} trips, ${fmtInt(a.rows)} rows, ` +
                `${fmtInt(a.ms)}ms${perStop}`,
            );
        }
        if (stopsQueried && stopsWithRows !== undefined && stopsQueried > 0) {
            const wasted = Math.max(0, stopsQueried - stopsWithRows);
            out.push(
                `    stops queried ${fmtInt(stopsQueried)}, with rows ${fmtInt(stopsWithRows)} ` +
                `(${Math.round((wasted / stopsQueried) * 100)}% empty seeks)`,
            );
        }
    }

    // ── nested durations, biggest first, zeros folded away ──
    const nonZero = detail.filter(d => d.ms > 0).sort((a, b) => b.ms - a.ms);
    if (nonZero.length) {
        out.push(section('sub-stages (ms, biggest first)'));
        out.push(...wrapItems(nonZero.map(d => `${d.label} ${fmtInt(d.ms)}`), '    '));
    }

    // ── window sizing ──
    if (windows.length) {
        out.push(section('window'));
        out.push(...wrapItems(windows.map(w => `${w.label.replace(/^window\./, '').replace(/_sec$/, '')} ${fmtSec(w.ms)}`), '    '));
    }

    // ── counts, grouped so the corridor funnel reads together ──
    const corridorCounts = counts.filter(c => c.label.startsWith('corridor.count.'));
    const loadCounts = counts.filter(c => !c.label.startsWith('corridor.count.'));
    if (loadCounts.length) {
        out.push(section('counts'));
        out.push(...wrapItems(loadCounts.map(c => `${c.label.replace(/^count\./, '')} ${fmtInt(c.ms)}`), '    '));
    }
    if (corridorCounts.length) {
        out.push(section('corridor counts'));
        out.push(...wrapItems(corridorCounts.map(c => `${c.label.replace(/^corridor\.count\./, '')} ${fmtInt(c.ms)}`), '    '));
    }

    if (misc.length) {
        out.push(section('flags'));
        out.push(...wrapItems(misc.map(m => `${m.label} ${fmtInt(m.ms)}`), '    '));
    }

    return out;
}

export function formatTimings(timings: TimingEntryLike[]): string {
    const failed: NumTiming[] = [];
    const main: NumTiming[] = [];
    for (const raw of timings) {
        const t: NumTiming = { label: raw.label, ms: Number(raw.ms) };
        if (t.label.startsWith('failed_attempt.')) {
            failed.push({ label: t.label.slice('failed_attempt.'.length), ms: t.ms });
        } else {
            main.push(t);
        }
    }

    const lines = ['[gtfsRouterNative] route timings', ...formatBlock(main)];
    if (failed.length) {
        lines.push('  ── earlier attempt (retried) ──', ...formatBlock(failed));
    }
    return lines.join('\n');
}
