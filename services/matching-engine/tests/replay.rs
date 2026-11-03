use matching_engine::replay::{verify, Divergence, RecordedEvent};
use matching_engine::Sequencer;

fn commands() -> Vec<(u64, String)> {
    let place = |id: &str, acct: &str, side: &str, price: u64, qty: u64| {
        format!(
            r#"{{"type":"place","order_id":"{id}","account":"{acct}","side":"{side}","kind":"limit","tif":"gtc","price":{price},"stop_price":null,"quantity":{qty}}}"#
        )
    };
    vec![
        (1, place("s1", "a", "sell", 100, 5)),
        (2, place("b1", "b", "buy", 101, 3)),
        (
            3,
            r#"{"type":"cancel","order_id":"s1","account":"a"}"#.to_owned(),
        ),
    ]
}

/// Records events the way engine-server stores them.
fn record() -> (Vec<RecordedEvent>, String) {
    let mut s = Sequencer::new();
    let mut out = Vec::new();
    for (seq, payload) in commands() {
        for env in s.apply_json(seq, &payload).unwrap() {
            out.push(RecordedEvent {
                seq: env.seq,
                command_seq: env.command_seq,
                payload: serde_json::to_value(&env.event).unwrap(),
            });
        }
    }
    (out, s.state_hash().to_owned())
}

#[test]
fn identical_history_verifies() {
    let (events, hash) = record();
    let report = verify(commands(), &events, Some(&hash));
    assert!(report.ok(), "{report:?}");
    assert_eq!(report.commands, 3);
    assert_eq!(report.events, events.len() as u64);
}

#[test]
fn detects_a_changed_event() {
    let (mut events, hash) = record();
    events[2].payload["price"] = serde_json::json!(99); // the trade price
    let report = verify(commands(), &events, Some(&hash));
    assert!(
        matches!(
            report.divergence,
            Some(Divergence::EventMismatch { seq: 3, .. })
        ),
        "{report:?}"
    );
}

#[test]
fn detects_missing_and_extra_events() {
    let (events, hash) = record();
    let fewer = &events[..events.len() - 1];
    assert!(matches!(
        verify(commands(), fewer, Some(&hash)).divergence,
        Some(Divergence::ExtraEvent { .. })
    ));
    let mut more = events.clone();
    more.push(RecordedEvent {
        seq: 99,
        command_seq: 3,
        payload: serde_json::json!({"type":"filled","order_id":"x"}),
    });
    assert!(matches!(
        verify(commands(), &more, Some(&hash)).divergence,
        Some(Divergence::MissingEvents {
            from_seq: 99,
            count: 1
        })
    ));
}

#[test]
fn detects_hash_and_sequence_problems() {
    let (events, _) = record();
    assert!(matches!(
        verify(commands(), &events, Some("deadbeef")).divergence,
        Some(Divergence::StateHashMismatch { .. })
    ));
    let mut gap = commands();
    gap[1].0 = 5;
    assert!(matches!(
        verify(gap, &events, None).divergence,
        Some(Divergence::CommandError { command_seq: 5, .. })
    ));
}
