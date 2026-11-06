//! Property tests over random command sequences.

use std::collections::BTreeMap;

use matching_engine::*;
use proptest::prelude::*;

const ACCOUNTS: [&str; 4] = ["a", "b", "c", "d"];

fn arb_command(max_id: u32) -> impl Strategy<Value = Command> {
    let side = prop_oneof![Just(Side::Buy), Just(Side::Sell)];
    let kind = prop_oneof![
        6 => Just(OrderKind::Limit),
        2 => Just(OrderKind::Market),
        1 => Just(OrderKind::StopLimit),
        1 => Just(OrderKind::StopMarket),
    ];
    let tif = prop_oneof![
        5 => Just(TimeInForce::Gtc),
        2 => Just(TimeInForce::Ioc),
        1 => Just(TimeInForce::Fok),
        1 => Just(TimeInForce::PostOnly),
    ];
    let place = (
        0..max_id,
        0..4usize,
        side,
        kind,
        tif,
        90u64..110,
        90u64..110,
        1u64..20,
        any::<bool>(),
    )
        .prop_map(|(id, acct, side, kind, tif, price, stop, qty, protect)| {
            let tif = match kind {
                OrderKind::Market | OrderKind::StopMarket => {
                    if tif == TimeInForce::Fok {
                        TimeInForce::Fok
                    } else {
                        TimeInForce::Ioc
                    }
                }
                OrderKind::StopLimit if tif == TimeInForce::PostOnly => TimeInForce::Gtc,
                _ => tif,
            };
            let price = match kind {
                OrderKind::Limit | OrderKind::StopLimit => Some(price),
                _ => protect.then_some(price),
            };
            let stop_price = kind.is_stop().then_some(stop);
            Command::Place(PlaceOrder {
                order_id: format!("o{id}"),
                account: ACCOUNTS[acct].into(),
                side,
                kind,
                tif,
                price,
                stop_price,
                quantity: qty,
                trigger: None,
            })
        });
    let cancel = (0..max_id, 0..4usize).prop_map(|(id, acct)| Command::Cancel {
        order_id: format!("o{id}"),
        account: ACCOUNTS[acct].into(),
    });
    let reduce = (0..max_id, 0..4usize, 1u64..20).prop_map(|(id, acct, r)| Command::Reduce {
        order_id: format!("o{id}"),
        account: ACCOUNTS[acct].into(),
        remaining: r,
    });
    prop_oneof![8 => place, 2 => cancel, 1 => reduce]
}

/// Tracks every order's lifecycle from the event stream alone.
#[derive(Default)]
struct Ledger {
    original: BTreeMap<String, u64>,
    filled: BTreeMap<String, u64>,
    cancelled: BTreeMap<String, u64>,
    reduced_by: BTreeMap<String, u64>,
    terminal: BTreeMap<String, &'static str>,
    accounts: BTreeMap<String, String>,
}

fn run(commands: &[Command]) -> (Sequencer, Vec<EventEnvelope>) {
    let mut seq = Sequencer::new();
    let mut all = Vec::new();
    for (i, c) in commands.iter().enumerate() {
        all.extend(seq.apply(i as u64 + 1, c).unwrap());
    }
    (seq, all)
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 400, ..ProptestConfig::default() })]

    #[test]
    fn book_invariants_hold(commands in prop::collection::vec(arb_command(40), 1..150)) {
        let mut seq = Sequencer::new();
        let mut track = Ledger::default();
        let mut placed: BTreeMap<String, PlaceOrder> = BTreeMap::new();

        for (i, command) in commands.iter().enumerate() {
            let events = seq.apply(i as u64 + 1, command).unwrap();
            for env in &events {
                match &env.event {
                    Event::Accepted { order_id, account, .. } => {
                        prop_assert!(!track.original.contains_key(order_id), "accepted twice: {order_id}");
                        if let Command::Place(p) = command { placed.insert(order_id.clone(), p.clone()); }
                        track.original.insert(order_id.clone(), placed[order_id].quantity);
                        track.accounts.insert(order_id.clone(), account.clone());
                    }
                    Event::Trade { maker_order_id, taker_order_id, maker_account, taker_account, taker_side, price, quantity, .. } => {
                        prop_assert!(*quantity > 0);
                        prop_assert_ne!(maker_account, taker_account, "self trade");
                        // Taker limit respected; trade at maker's resting price.
                        let taker = &placed[taker_order_id];
                        if let (Some(limit), OrderKind::Limit | OrderKind::StopLimit | OrderKind::Market | OrderKind::StopMarket) = (taker.price, taker.kind) {
                            match taker_side {
                                Side::Buy => prop_assert!(*price <= limit),
                                Side::Sell => prop_assert!(*price >= limit),
                            }
                        }
                        prop_assert_eq!(*price, placed[maker_order_id].price.unwrap());
                        *track.filled.entry(maker_order_id.clone()).or_default() += quantity;
                        *track.filled.entry(taker_order_id.clone()).or_default() += quantity;
                    }
                    Event::Cancelled { order_id, remaining, .. } => {
                        prop_assert!(track.terminal.insert(order_id.clone(), "cancelled").is_none(), "double terminal");
                        track.cancelled.insert(order_id.clone(), *remaining);
                    }
                    Event::Filled { order_id } => {
                        prop_assert!(track.terminal.insert(order_id.clone(), "filled").is_none(), "double terminal");
                    }
                    Event::Reduced { order_id, remaining } => {
                        let orig = track.original[order_id];
                        let before = orig - track.filled.get(order_id).copied().unwrap_or(0) - track.reduced_by.get(order_id).copied().unwrap_or(0);
                        prop_assert!(*remaining < before);
                        *track.reduced_by.entry(order_id.clone()).or_default() += before - remaining;
                    }
                    _ => {}
                }
            }

            // The book is never crossed.
            if let (Some(bid), Some(ask)) = (seq.book().best_bid(), seq.book().best_ask()) {
                prop_assert!(bid < ask, "crossed book: bid {bid} >= ask {ask}");
            }
            // Event sequence numbers are contiguous.
            for (k, env) in events.iter().enumerate() {
                prop_assert_eq!(env.command_seq, i as u64 + 1);
                if k > 0 { prop_assert_eq!(env.seq, events[k - 1].seq + 1); }
            }
        }

        // Conservation of quantity for every accepted order.
        for (id, original) in &track.original {
            let filled = track.filled.get(id).copied().unwrap_or(0);
            let reduced = track.reduced_by.get(id).copied().unwrap_or(0);
            let resting = seq.book().resting_order(id).map(|o| o.remaining);
            match track.terminal.get(id) {
                Some(&"filled") => prop_assert_eq!(filled + reduced, *original, "{}", id),
                Some(&"cancelled") => prop_assert_eq!(filled + reduced + track.cancelled[id], *original, "{}", id),
                _ => {
                    // Still live: resting in the book or pending as a stop.
                    if let Some(r) = resting {
                        prop_assert_eq!(filled + reduced + r, *original, "{}", id);
                        prop_assert!(r > 0);
                    } else {
                        prop_assert_eq!(filled, 0, "pending stop cannot have fills: {}", id);
                    }
                }
            }
        }
    }

    #[test]
    fn deterministic_replay(commands in prop::collection::vec(arb_command(30), 1..120)) {
        let (a, ea) = run(&commands);
        let (b, eb) = run(&commands);
        prop_assert_eq!(ea, eb);
        prop_assert_eq!(a.state_hash(), b.state_hash());
        prop_assert_eq!(a.snapshot(), b.snapshot());
    }

    #[test]
    fn snapshot_restore_equals_continuous(commands in prop::collection::vec(arb_command(30), 2..120), split in 0usize..1000) {
        let split = 1 + split % (commands.len() - 1);
        let (continuous, all_events) = run(&commands);

        let mut first = Sequencer::new();
        let mut events = Vec::new();
        for (i, c) in commands[..split].iter().enumerate() {
            events.extend(first.apply(i as u64 + 1, c).unwrap());
        }
        let mut restored = Sequencer::restore(&first.snapshot()).unwrap();
        for (i, c) in commands[split..].iter().enumerate() {
            events.extend(restored.apply((split + i) as u64 + 1, c).unwrap());
        }
        prop_assert_eq!(events, all_events);
        prop_assert_eq!(restored.state_hash(), continuous.state_hash());
    }
}

#[test]
fn hash_changes_with_any_difference() {
    let cmd = |price| {
        Command::Place(PlaceOrder {
            order_id: "x".into(),
            account: "a".into(),
            side: Side::Buy,
            kind: OrderKind::Limit,
            tif: TimeInForce::Gtc,
            price: Some(price),
            stop_price: None,
            quantity: 1,
            trigger: None,
        })
    };
    let (a, _) = run(&[cmd(100)]);
    let (b, _) = run(&[cmd(101)]);
    assert_ne!(a.state_hash(), b.state_hash());
    assert_ne!(a.state_hash(), "0".repeat(64));
}
