//! Deterministic spot matching engine (ADR-0007).
//!
//! The library is pure: no I/O, no clocks, no randomness. Given the same
//! sequence of commands it produces byte-identical events and state hashes.

pub mod book;
pub mod replay;
pub mod sequencer;
pub mod types;

pub use book::OrderBook;
pub use sequencer::{EventEnvelope, Sequencer};
pub use types::*;
