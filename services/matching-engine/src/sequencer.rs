//! Wraps an order book with contiguous event sequence numbers and a hash chain
//! over every emitted event, so any divergence between runs is detectable.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::book::OrderBook;
use crate::types::{Command, Event, RejectReason};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventEnvelope {
    /// Contiguous per-market event sequence number, starting at 1.
    pub seq: u64,
    /// Sequence number of the command that produced this event.
    pub command_seq: u64,
    pub event: Event,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sequencer {
    book: OrderBook,
    last_command_seq: u64,
    last_event_seq: u64,
    /// Hex SHA-256 chain over every command and event:
    /// h = sha256(h_prev || "C" || command) then h = sha256(h_prev || "E" || json(envelope)).
    /// Starts as 64 zeros.
    state_hash: String,
}

impl Default for Sequencer {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SequenceError {
    /// Commands must arrive exactly in order with no gaps (ADR-0007).
    OutOfOrder { expected: u64, got: u64 },
}

impl std::fmt::Display for SequenceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SequenceError::OutOfOrder { expected, got } => {
                write!(f, "command sequence gap: expected {expected}, got {got}")
            }
        }
    }
}

impl std::error::Error for SequenceError {}

impl Sequencer {
    pub fn new() -> Self {
        Self {
            book: OrderBook::new(),
            last_command_seq: 0,
            last_event_seq: 0,
            state_hash: "0".repeat(64),
        }
    }

    pub fn book(&self) -> &OrderBook {
        &self.book
    }

    pub fn last_command_seq(&self) -> u64 {
        self.last_command_seq
    }

    pub fn last_event_seq(&self) -> u64 {
        self.last_event_seq
    }

    pub fn state_hash(&self) -> &str {
        &self.state_hash
    }

    /// Applies a raw JSON command. Malformed input is rejected deterministically
    /// (it still consumes the sequence number) instead of crashing the engine.
    pub fn apply_json(
        &mut self,
        command_seq: u64,
        payload: &str,
    ) -> Result<Vec<EventEnvelope>, SequenceError> {
        match serde_json::from_str::<Command>(payload) {
            Ok(command) => self.apply(command_seq, &command),
            Err(_) => {
                self.check_seq(command_seq)?;
                self.chain(b'C', payload.as_bytes());
                let order_id = serde_json::from_str::<serde_json::Value>(payload)
                    .ok()
                    .and_then(|v| {
                        v.get("order_id")
                            .and_then(|id| id.as_str())
                            .map(str::to_owned)
                    })
                    .unwrap_or_default();
                self.emit(
                    command_seq,
                    vec![Event::CommandRejected {
                        order_id,
                        reason: RejectReason::MalformedCommand,
                    }],
                )
            }
        }
    }

    pub fn apply(
        &mut self,
        command_seq: u64,
        command: &Command,
    ) -> Result<Vec<EventEnvelope>, SequenceError> {
        self.check_seq(command_seq)?;
        let canonical = serde_json::to_vec(command).expect("commands always serialise");
        self.chain(b'C', &canonical);
        let events = self.book.apply(command);
        self.emit(command_seq, events)
    }

    fn check_seq(&self, command_seq: u64) -> Result<(), SequenceError> {
        let expected = self.last_command_seq + 1;
        if command_seq != expected {
            return Err(SequenceError::OutOfOrder {
                expected,
                got: command_seq,
            });
        }
        Ok(())
    }

    fn emit(
        &mut self,
        command_seq: u64,
        events: Vec<Event>,
    ) -> Result<Vec<EventEnvelope>, SequenceError> {
        self.check_seq(command_seq)?;
        self.last_command_seq = command_seq;
        let mut out = Vec::with_capacity(events.len());
        for event in events {
            self.last_event_seq += 1;
            let envelope = EventEnvelope {
                seq: self.last_event_seq,
                command_seq,
                event,
            };
            let json = serde_json::to_vec(&envelope).expect("events always serialise");
            self.chain(b'E', &json);
            out.push(envelope);
        }
        Ok(out)
    }

    fn chain(&mut self, tag: u8, bytes: &[u8]) {
        let mut hasher = Sha256::new();
        hasher.update(self.state_hash.as_bytes());
        hasher.update([tag]);
        hasher.update(bytes);
        self.state_hash = hex(&hasher.finalize());
    }

    /// Serialises the full engine state (book, offsets, hash).
    pub fn snapshot(&self) -> String {
        serde_json::to_string(self).expect("state always serialises")
    }

    pub fn restore(snapshot: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(snapshot)
    }
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 0x0f) as usize] as char);
    }
    s
}
