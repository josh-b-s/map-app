use std::collections::HashMap;
use csv::ReaderBuilder;

/// Parses a small file fully into memory as Vec<HashMap<String,String>> —
/// equivalent to gtfsImporterLegacy.ts's parseCSVString / preprocess-gtfs.ts's
/// parseCSV, but using the `csv` crate's SIMD-accelerated reader instead of
/// hand-rolled quote-state parsing. Fine for stops/routes/calendar/trips
/// (hundreds-thousands of rows) — NOT used for stop_times/shapes, see
/// stream_rows below.
pub fn parse_csv_map(bytes: &[u8]) -> Vec<HashMap<String, String>> {
    if bytes.is_empty() { return Vec::new(); }
    let mut rdr = ReaderBuilder::new()
        .has_headers(true)
        .flexible(true) // tolerate ragged rows like the TS versions do
        .from_reader(bytes);

    // Strip BOM the same way stripBOM() does, on the header row only.
    let headers: Vec<String> = rdr.headers()
        .map(|h| h.iter().enumerate().map(|(i, s)| {
            if i == 0 { s.trim_start_matches('\u{feff}').trim().to_string() }
            else { s.trim().to_string() }
        }).collect())
        .unwrap_or_default();

    let mut out = Vec::new();
    for result in rdr.records() {
        let record = match result { Ok(r) => r, Err(_) => continue };
        let mut row = HashMap::with_capacity(headers.len());
        for (i, h) in headers.iter().enumerate() {
            row.insert(h.clone(), record.get(i).unwrap_or("").trim().to_string());
        }
        out.push(row);
    }
    out
}

/// Streaming version for stop_times.txt / shapes.txt — millions of rows,
/// avoid materializing every row as a HashMap. Caller gets column indices
/// once and reads by position, same idea as gtfsImporterLegacy.ts's
/// headerIndexes()+bounds approach but via the csv crate's byte-record API
/// instead of hand-rolled comma scanning (Rust doesn't need that hack —
/// there's no JS-interpreter-vs-native-call-overhead tradeoff here).
pub fn stream_csv_rows<'a>(
    bytes: &'a [u8],
) -> impl Iterator<Item = csv::StringRecord> + 'a {
    let rdr = ReaderBuilder::new()
        .has_headers(true)
        .flexible(true)
        .from_reader(bytes);
    rdr.into_records().filter_map(|r| r.ok())
}

pub fn header_index(headers: &csv::StringRecord, name: &str) -> Option<usize> {
    headers.iter().position(|h| h.trim().trim_start_matches('\u{feff}') == name)
}