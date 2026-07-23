//! graph/store.rs — port of services/gtfs/graph/coarseGraphStore.ts.
//!
//! TABLE NAMES: deliberately NOT the same `coarse_graph_meta` /
//! `coarse_graph_adjacency` tables the JS build persists to. Those are
//! keyed by TEXT stop_key (agency-qualified string); this Rust build is
//! keyed by INTEGER stop_pk directly (see repo.rs's module doc). Reusing
//! the same table names with an incompatible schema would risk exactly the
//! stale/cross-format load bug flagged in this codebase's own history —
//! using `rust_coarse_graph_meta` / `rust_coarse_graph_adjacency` instead
//! makes the two builds structurally incapable of reading each other's
//! data, even if the invalidation signature ever coincidentally matched.
//!
//! ENCODING: TS packs edges as a `\x1f`-joined string of
//! `{to}{kind}{FIELD_SEP}{viaPatternKey}` tokens, parsed back with string
//! splits. Rust packs each edge as a fixed-width 17-byte binary record
//! instead (i64 `to` + u8 `kind` + i64 `via_pattern`, `-1` sentinel for
//! "none") — no string parsing on the load path, which matters here since
//! this blob holds ~2M edges total.

use std::collections::HashMap;
use rusqlite::{params, Connection, OptionalExtension};
use crate::graph::coarse::{CoarseEdge, EdgeKind};

/// Bumped whenever the algorithm that builds the adjacency changes, not
/// just when the underlying GTFS data does — same reasoning as TS's
/// GRAPH_ALGO_VERSION (a code change that produces different edges from the
/// same row counts must still force a rebuild).
const RUST_GRAPH_ALGO_VERSION: i64 = 1;

pub struct GraphSignature {
    pub stop_count: i64,
    pub pattern_stop_count: i64,
}

pub fn compute_graph_signature(conn: &Connection) -> rusqlite::Result<GraphSignature> {
    let stop_count: i64 = conn.query_row("SELECT COUNT(*) FROM stops", [], |r| r.get(0))?;
    let pattern_stop_count: i64 = conn.query_row("SELECT COUNT(*) FROM pattern_stops", [], |r| r.get(0))?;
    Ok(GraphSignature { stop_count, pattern_stop_count })
}

fn signature_key(sig: &GraphSignature) -> String {
    format!("{RUST_GRAPH_ALGO_VERSION}:{}:{}", sig.stop_count, sig.pattern_stop_count)
}

fn ensure_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS rust_coarse_graph_meta (
            key   TEXT PRIMARY KEY,
            value TEXT
         );
         CREATE TABLE IF NOT EXISTS rust_coarse_graph_adjacency (
            stop_pk INTEGER PRIMARY KEY,
            edges   BLOB NOT NULL
         );",
    )
}

fn encode_edges(edges: &[CoarseEdge]) -> Vec<u8> {
    let mut out = Vec::with_capacity(edges.len() * 17);
    for e in edges {
        out.extend_from_slice(&e.to.to_le_bytes());
        out.push(match e.kind { EdgeKind::Transit => 0, EdgeKind::Walk => 1 });
        out.extend_from_slice(&e.via_pattern.unwrap_or(-1).to_le_bytes());
    }
    out
}

fn decode_edges(bytes: &[u8]) -> Vec<CoarseEdge> {
    let mut out = Vec::with_capacity(bytes.len() / 17);
    let mut i = 0;
    while i + 17 <= bytes.len() {
        let to = i64::from_le_bytes(bytes[i..i + 8].try_into().unwrap());
        let kind = if bytes[i + 8] == 0 { EdgeKind::Transit } else { EdgeKind::Walk };
        let via_raw = i64::from_le_bytes(bytes[i + 9..i + 17].try_into().unwrap());
        let via_pattern = if via_raw < 0 { None } else { Some(via_raw) };
        let cost = match kind { EdgeKind::Transit => 1.0, EdgeKind::Walk => 0.5 };
        out.push(CoarseEdge { to, kind, cost, via_pattern });
        i += 17;
    }
    out
}

/// Attempts to load a previously persisted graph matching `signature`.
/// Returns None on any mismatch/absence — caller falls back to a full
/// rebuild (which also re-persists).
pub fn load_persisted_graph(
    conn: &Connection,
    signature: &GraphSignature,
) -> rusqlite::Result<Option<HashMap<i64, Vec<CoarseEdge>>>> {
    ensure_tables(conn)?;

    let stored: Option<String> = conn
        .query_row("SELECT value FROM rust_coarse_graph_meta WHERE key = 'signature'", [], |r| r.get(0))
        .optional()?;
    if stored.as_deref() != Some(signature_key(signature).as_str()) {
        return Ok(None);
    }

    let mut stmt = conn.prepare("SELECT stop_pk, edges FROM rust_coarse_graph_adjacency")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)))?;
    let mut adjacency = HashMap::new();
    let mut any = false;
    for row in rows {
        let (stop_pk, blob) = row?;
        any = true;
        adjacency.insert(stop_pk, decode_edges(&blob));
    }
    if !any { return Ok(None); } // stale/half-written — treat as a miss, rebuild

    Ok(Some(adjacency))
}

/// Persists a freshly-built graph, replacing whatever was stored before.
/// Runs as one transaction so a crash mid-write can't leave a half-written
/// store that still matches the signature.
pub fn save_persisted_graph(
    conn: &mut Connection,
    signature: &GraphSignature,
    adjacency: &HashMap<i64, Vec<CoarseEdge>>,
) -> rusqlite::Result<()> {
    ensure_tables(conn)?;

    let tx = conn.transaction()?;
    tx.execute("DELETE FROM rust_coarse_graph_adjacency", [])?;
    tx.execute("DELETE FROM rust_coarse_graph_meta", [])?;
    {
        let mut ins = tx.prepare("INSERT INTO rust_coarse_graph_adjacency (stop_pk, edges) VALUES (?, ?)")?;
        for (stop_pk, edges) in adjacency {
            let blob = encode_edges(edges);
            ins.execute(params![stop_pk, blob])?;
        }
    }
    tx.execute(
        "INSERT INTO rust_coarse_graph_meta (key, value) VALUES ('signature', ?)",
        params![signature_key(signature)],
    )?;
    tx.commit()?;
    Ok(())
}
