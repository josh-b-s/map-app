use std::cell::RefCell;
use std::collections::HashMap;
use std::io::{Cursor, Read};
use zip::ZipArchive;

const ESSENTIAL_FILE: &str = "agency.txt";

/// Normalizes a zip entry name for matching purposes: backslash -> forward
/// slash (a minority of Windows-originated zip tools produce
/// backslash-separated entry names, against the zip spec but real enough
/// to see in the wild) and lowercased (GTFS providers are inconsistent
/// about "agency.txt" vs "Agency.txt" vs "AGENCY.TXT" — the spec doesn't
/// mandate a case, and not every provider's own tooling is spec-strict
/// about it either).
fn normalize_entry_name(name: &str) -> String {
    name.replace('\\', "/").to_lowercase()
}

/// One agency's GTFS source — either a real directory or an in-memory zip.
/// Matches gtfsImporterLegacy.ts's GtfsSource (dirPath) / preprocess-gtfs.ts's
/// GtfsSource (file() closure over AdmZip) — this unifies both into one
/// enum since Rust doesn't need the RN-vs-desktop split (no file-system-API
/// differences to work around).
///
/// Holds an already-parsed `ZipArchive`, not raw bytes — `.file()` is
/// called once per GTFS txt file needed (7-8 times per agency: stops,
/// routes, calendar, calendar_dates, trips, stop_times, shapes), and
/// `ZipArchive::new` has to read and parse the entire central directory
/// every time it's called. Re-parsing that 7-8 times per agency for
/// something that only changes between agencies, not between files within
/// one agency, was pure repeated work — parse once when the source is
/// discovered (`collect_from_zip` already parses it once anyway, to check
/// for agency.txt), keep it open, reuse it. `RefCell` because
/// `ZipArchive::by_name` needs `&mut self` to seek/read, but `file(&self)`
/// is called through a shared reference throughout `process_agency`.
pub enum GtfsSource {
    Zip {
        archive: RefCell<ZipArchive<Cursor<Vec<u8>>>>,
        /// normalize_entry_name(real entry name) -> real entry name, for
        /// this whole archive (not just this source's slice of it) — built
        /// once alongside the archive, so `.file()` can resolve a
        /// differently-cased/differently-separated request without
        /// re-scanning every entry on every call.
        name_index: HashMap<String, String>,
        prefix: String,
        describe: String,
    },
}

impl GtfsSource {
    /// Returns file contents, or empty Vec if absent — same "missing file
    /// -> empty buffer, let CSV parser yield nothing" contract as both TS
    /// versions' EMPTY/'' fallbacks. Case-insensitive and separator-
    /// normalized (see normalize_entry_name) — a provider whose agency.txt
    /// happens to be correctly-cased rarely has EVERY OTHER file
    /// differently-cased, but there's no reason to assume consistency
    /// provider-to-provider, so every file lookup gets the same tolerance
    /// agency.txt detection does, not just the one file used for detection.
    pub fn file(&self, name: &str) -> Vec<u8> {
        match self {
            GtfsSource::Zip { archive, name_index, prefix, .. } => {
                let lookup_key = normalize_entry_name(&format!("{prefix}{name}"));
                let Some(real_name) = name_index.get(&lookup_key) else { return Vec::new() };
                let mut zip = archive.borrow_mut();
                let result = match zip.by_name(real_name) {
                    Ok(mut entry) => {
                        let mut out = Vec::with_capacity(entry.size() as usize);
                        let _ = entry.read_to_end(&mut out);
                        out
                    }
                    Err(_) => Vec::new(),
                };
                result
            }
        }
    }

    pub fn describe(&self) -> &str {
        match self {
            GtfsSource::Zip { describe, .. } => describe,
        }
    }
}

/// Recursively finds every agency.txt inside `zip_bytes`, including nested
/// zips (e.g. this feed's real layout: gtfs.zip/11/google_transit.zip) —
/// same recursive-descent shape as preprocess-gtfs.ts's collectFromZip,
/// operating on entry-name prefixes rather than directory paths since a
/// zip has no real directories, only prefixed entry names.
pub fn find_all_gtfs_sources(zip_bytes: &[u8]) -> Vec<GtfsSource> {
    let mut out = Vec::new();
    collect_from_zip(zip_bytes, "", "root", &mut out);
    out
}

fn collect_from_zip(zip_bytes: &[u8], prefix: &str, label: &str, out: &mut Vec<GtfsSource>) {
    let cursor = Cursor::new(zip_bytes);
    let mut zip = match ZipArchive::new(cursor) {
        Ok(z) => z,
        Err(_) => return,
    };

    // Built once per zip level, used for both agency.txt detection (case-
    // /separator-tolerant, unlike a raw zip.by_name) and — if this level
    // turns out to be a real source — reused directly on the GtfsSource
    // so every subsequent .file() call gets the same tolerance.
    let mut name_index: HashMap<String, String> = HashMap::new();
    for i in 0..zip.len() {
        let Ok(entry) = zip.by_index(i) else { continue };
        let real_name = entry.name().to_string();
        name_index.insert(normalize_entry_name(&real_name), real_name);
    }

    let normalized_prefix = normalize_entry_name(prefix);
    let agency_lookup_key = format!("{normalized_prefix}{ESSENTIAL_FILE}");
    if name_index.contains_key(&agency_lookup_key) {
        // Re-parse once more here, over an OWNED copy of the bytes this
        // time (the `zip` above borrows the input slice, which doesn't
        // outlive this function call) — one extra parse to get an owned,
        // long-lived archive, versus the 7-8 we'd otherwise pay across
        // every subsequent `.file()` call on this source.
        let owned = zip_bytes.to_vec();
        if let Ok(owned_archive) = ZipArchive::new(Cursor::new(owned)) {
            out.push(GtfsSource::Zip {
                archive: RefCell::new(owned_archive),
                name_index,
                prefix: prefix.to_string(),
                describe: label.to_string(),
            });
        }
        return;
    }

    // Collect child "directories" (prefixes) and nested zip entries in one
    // pass over all entry names, same two-set approach as collectFromZip's
    // childDirs/childZips. Uses the REAL (non-normalized) names for actual
    // path-building — normalization is a matching aid, not a replacement
    // for the archive's real entry names, which is what by_name/read
    // ultimately need.
    let mut child_dirs = std::collections::BTreeSet::new();
    let mut child_zips = Vec::new();
    for i in 0..zip.len() {
        let entry = match zip.by_index(i) { Ok(e) => e, Err(_) => continue };
        let name = entry.name().replace('\\', "/");
        if !name.starts_with(prefix) { continue; }
        let rest = &name[prefix.len()..];
        if rest.is_empty() { continue; }
        if let Some(slash) = rest.find('/') {
            child_dirs.insert(rest[..slash].to_string());
        } else if !entry.is_dir() && rest.to_lowercase().ends_with(".zip") {
            child_zips.push(rest.to_string());
        }
    }

    for d in &child_dirs {
        collect_from_zip(zip_bytes, &format!("{prefix}{d}/"), &format!("{label}/{d}"), out);
    }
    for z in &child_zips {
        // z came from a backslash-normalized name above, but the archive's
        // REAL entry might still use backslashes — by_name needs the real
        // name, so try both forms rather than assuming either one.
        let full_name_normalized = format!("{prefix}{z}");
        let real_name = name_index.get(&normalize_entry_name(&full_name_normalized)).cloned().unwrap_or(full_name_normalized);
        if let Ok(mut entry) = zip.by_name(&real_name) {
            let mut nested = Vec::with_capacity(entry.size() as usize);
            if entry.read_to_end(&mut nested).is_ok() {
                collect_from_zip(&nested, "", &format!("{label}/{z}"), out);
            }
        }
    }
}