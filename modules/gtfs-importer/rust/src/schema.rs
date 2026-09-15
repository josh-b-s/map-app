// Adjust these relative paths if schema.sql / indexes.sql live somewhere
// other than one level up from src/ (i.e. at rust/schema.sql, rust/indexes.sql).
pub const GTFS_SCHEMA_SQL: &str = include_str!("../schema.sql");
pub const GTFS_INDEXES_SQL: &str = include_str!("../indexes.sql");
