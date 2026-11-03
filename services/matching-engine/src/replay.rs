//! Replay verification: re-runs a recorded command log through the current
//! engine build and compares every produced event with the recorded one.
//! Used to prove a new engine version is behaviour-identical on real history
//! before it is deployed (ADR-0010).

use serde::Serialize;
use serde_json::Value;

use crate::sequencer::Sequencer;

/// An event as recorded in the event log.
#[derive(Debug, Clone, PartialEq)]
pub struct RecordedEvent {
    pub seq: u64,
    pub command_seq: u64,
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Divergence {
    /// The replay produced a different event at this position.
    EventMismatch {
        seq: u64,
        recorded: Value,
        replayed: Value,
    },
    /// The replay produced an event the log does not contain.
    ExtraEvent { seq: u64, replayed: Value },
    /// The log contains events the replay did not produce.
    MissingEvents { from_seq: u64, count: usize },
    /// A command could not be applied (e.g. sequence gap).
    CommandError { command_seq: u64, message: String },
    /// Events match but the final state hash differs from the recorded one.
    StateHashMismatch { recorded: String, replayed: String },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReplayReport {
    pub commands: u64,
    pub events: u64,
    pub state_hash: String,
    pub divergence: Option<Divergence>,
}

impl ReplayReport {
    pub fn ok(&self) -> bool {
        self.divergence.is_none()
    }
}

/// Replays `commands` (seq, raw JSON payload) and compares with `recorded`
/// events (ordered by seq). Stops at the first divergence.
pub fn verify<I>(
    commands: I,
    recorded: &[RecordedEvent],
    recorded_hash: Option<&str>,
) -> ReplayReport
where
    I: IntoIterator<Item = (u64, String)>,
{
    let mut sequencer = Sequencer::new();
    let mut next = 0usize;
    let mut count = 0u64;
    let report = |s: &Sequencer, count: u64, divergence: Option<Divergence>| ReplayReport {
        commands: count,
        events: s.last_event_seq(),
        state_hash: s.state_hash().to_owned(),
        divergence,
    };

    for (command_seq, payload) in commands {
        let envelopes = match sequencer.apply_json(command_seq, &payload) {
            Ok(e) => e,
            Err(err) => {
                let d = Divergence::CommandError {
                    command_seq,
                    message: err.to_string(),
                };
                return report(&sequencer, count, Some(d));
            }
        };
        count += 1;
        for env in envelopes {
            let replayed = serde_json::to_value(&env.event).expect("events serialise");
            let Some(rec) = recorded.get(next) else {
                return report(
                    &sequencer,
                    count,
                    Some(Divergence::ExtraEvent {
                        seq: env.seq,
                        replayed,
                    }),
                );
            };
            if rec.seq != env.seq || rec.command_seq != env.command_seq || rec.payload != replayed {
                let d = Divergence::EventMismatch {
                    seq: env.seq,
                    recorded: rec.payload.clone(),
                    replayed,
                };
                return report(&sequencer, count, Some(d));
            }
            next += 1;
        }
    }
    if next < recorded.len() {
        let d = Divergence::MissingEvents {
            from_seq: recorded[next].seq,
            count: recorded.len() - next,
        };
        return report(&sequencer, count, Some(d));
    }
    if let Some(hash) = recorded_hash {
        if hash != sequencer.state_hash() {
            let d = Divergence::StateHashMismatch {
                recorded: hash.to_owned(),
                replayed: sequencer.state_hash().to_owned(),
            };
            return report(&sequencer, count, Some(d));
        }
    }
    report(&sequencer, count, None)
}
