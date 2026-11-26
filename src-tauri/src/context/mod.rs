//! The Talk director's context engine (Talk engine v2, Epic B). B1 ships
//! the per-model budget guard and B2 the append-only transcript (behind
//! `talkEngine`); the cache plan and compaction segments come in later
//! slices.

pub mod budget;
pub mod transcript;
