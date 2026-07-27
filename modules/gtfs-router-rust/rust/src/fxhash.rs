//! fxhash.rs — a small, dependency-free reimplementation of the FxHash
//! algorithm (the same one rustc/Firefox use internally) for maps/sets
//! keyed by i64 stop_pks, e.g. in corridor/seed_bfs.rs.
//!
//! std's default hasher (SipHash) is DoS-resistant, which is the right
//! default for untrusted input, but it's overkill for internal i64 keys we
//! generate ourselves — most of the cost in a hot BFS loop hashing
//! millions of small integer keys is the hasher, not the lookup. FxHash is
//! a handful of multiply+rotate ops instead, no dependency needed since
//! it's this short.

use std::hash::{BuildHasherDefault, Hasher};

const SEED: u64 = 0x51_7c_c1_b7_27_22_0a_95;

#[derive(Default)]
pub struct FxHasher {
    hash: u64,
}

impl FxHasher {
    #[inline]
    fn add(&mut self, w: u64) {
        self.hash = (self.hash.rotate_left(5) ^ w).wrapping_mul(SEED);
    }
}

impl Hasher for FxHasher {
    #[inline]
    fn write(&mut self, mut bytes: &[u8]) {
        while bytes.len() >= 8 {
            self.add(u64::from_ne_bytes(bytes[..8].try_into().unwrap()));
            bytes = &bytes[8..];
        }
        if !bytes.is_empty() {
            let mut buf = [0u8; 8];
            buf[..bytes.len()].copy_from_slice(bytes);
            self.add(u64::from_ne_bytes(buf));
        }
    }
    #[inline]
    fn write_u64(&mut self, i: u64) { self.add(i); }
    #[inline]
    fn write_i64(&mut self, i: i64) { self.add(i as u64); }
    #[inline]
    fn write_usize(&mut self, i: usize) { self.add(i as u64); }
    #[inline]
    fn finish(&self) -> u64 { self.hash }
}

pub type FxBuildHasher = BuildHasherDefault<FxHasher>;
pub type FxHashMap<K, V> = std::collections::HashMap<K, V, FxBuildHasher>;
pub type FxHashSet<K> = std::collections::HashSet<K, FxBuildHasher>;
