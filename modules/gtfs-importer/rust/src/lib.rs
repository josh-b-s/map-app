mod source;
mod csv_util;
mod schema;
mod import;

use std::sync::Arc;
use crate::import::ImportProgress;

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum ImportError {
    #[error("io error: {0}")]
    Io(String),
    #[error("zip error: {0}")]
    Zip(String),
    #[error("db error: {0}")]
    Db(String),
}

#[uniffi::export(with_foreign)]
pub trait ProgressCallback: Send + Sync {
    fn on_progress(&self, table: String, inserted: u64, total: u64);
}

// Bridges the uniffi-facing callback to import.rs's plain trait, so
// import.rs doesn't need to know about uniffi at all.
struct ProgressAdapter(Arc<dyn ProgressCallback>);
impl ImportProgress for ProgressAdapter {
    fn on_progress(&self, table: String, inserted: u64, total: u64) {
        self.0.on_progress(table, inserted, total);
    }
}

#[uniffi::export]
pub fn import_gtfs(
    zip_path: String,
    db_path: String,
    progress: Arc<dyn ProgressCallback>,
) -> Result<(), ImportError> {
    let adapter = ProgressAdapter(progress);
    import::import_gtfs(&zip_path, &db_path, &adapter)
        .map_err(|e| ImportError::Db(e.to_string()))
}

uniffi::setup_scaffolding!();
