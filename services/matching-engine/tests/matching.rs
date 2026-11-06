#![allow(clippy::too_many_arguments)] // compact test helper
use matching_engine::*;

fn place(
    id: &str,
    acct: &str,
    side: Side,
    kind: OrderKind,
    tif: TimeInForce,
    price: Option<u64>,
    stop: Option<u64>,
    qty: u64,
) -> Command {
    Command::Place(PlaceOrder {
        order_id: id.into(),
        account: acct.into(),
        side,
        kind,
        tif,
        price,
        stop_price: stop,
        quantity: qty,
        trigger: None,
    })
}

fn limit(id: &str, acct: &str, side: Side, price: u64, qty: u64) -> Command {
    place(
        id,
        acct,
        side,
        OrderKind::Limit,
        TimeInForce::Gtc,
        Some(price),
        None,
        qty,
    )
}

fn trades(events: &[Event]) -> Vec<(String, String, u64, u64)> {
    events
        .iter()
        .filter_map(|e| match e {
            Event::Trade {
                maker_order_id,
                taker_order_id,
                price,
                quantity,
                ..
            } => Some((
                maker_order_id.clone(),
                taker_order_id.clone(),
                *price,
                *quantity,
            )),
            _ => None,
        })
        .collect()
}

#[test]
fn resting_limit_orders_do_not_trade_when_not_crossing() {
    let mut book = OrderBook::new();
    let e1 = book.apply(&limit("b1", "alice", Side::Buy, 99, 10));
    let e2 = book.apply(&limit("s1", "bob", Side::Sell, 101, 10));
    assert!(matches!(e1.as_slice(), [Event::Accepted { .. }]));
    assert!(matches!(e2.as_slice(), [Event::Accepted { .. }]));
    assert_eq!(book.best_bid(), Some(99));
    assert_eq!(book.best_ask(), Some(101));
}

#[test]
fn price_time_priority_and_maker_price() {
    let mut book = OrderBook::new();
    book.apply(&limit("s1", "a", Side::Sell, 100, 5)); // first at 100
    book.apply(&limit("s2", "b", Side::Sell, 100, 5)); // second at 100
    book.apply(&limit("s3", "c", Side::Sell, 99, 5)); // better price, later
    let events = book.apply(&limit("buy", "d", Side::Buy, 101, 12));
    // Best price first (99), then FIFO at 100; trades at maker prices, never at 101.
    assert_eq!(
        trades(&events),
        vec![
            ("s3".into(), "buy".into(), 99, 5),
            ("s1".into(), "buy".into(), 100, 5),
            ("s2".into(), "buy".into(), 100, 2),
        ]
    );
    assert_eq!(book.resting_order("s2").unwrap().remaining, 3);
    assert!(events.contains(&Event::Filled {
        order_id: "buy".into()
    }));
    assert!(events.contains(&Event::Filled {
        order_id: "s1".into()
    }));
    assert_eq!(book.last_trade_price(), Some(100));
}

#[test]
fn partial_fill_rests_remainder_for_gtc() {
    let mut book = OrderBook::new();
    book.apply(&limit("s1", "a", Side::Sell, 100, 4));
    let events = book.apply(&limit("b1", "b", Side::Buy, 100, 10));
    assert_eq!(trades(&events), vec![("s1".into(), "b1".into(), 100, 4)]);
    assert_eq!(book.resting_order("b1").unwrap().remaining, 6);
    assert_eq!(book.best_bid(), Some(100));
    assert_eq!(book.best_ask(), None);
}

#[test]
fn ioc_cancels_remainder() {
    let mut book = OrderBook::new();
    book.apply(&limit("s1", "a", Side::Sell, 100, 4));
    let events = book.apply(&place(
        "b1",
        "b",
        Side::Buy,
        OrderKind::Limit,
        TimeInForce::Ioc,
        Some(100),
        None,
        10,
    ));
    assert_eq!(trades(&events).len(), 1);
    assert_eq!(
        events.last(),
        Some(&Event::Cancelled {
            order_id: "b1".into(),
            remaining: 6,
            reason: CancelReason::Unfilled
        })
    );
    assert_eq!(book.best_bid(), None);
}

#[test]
fn fok_is_all_or_nothing() {
    let mut book = OrderBook::new();
    book.apply(&limit("s1", "a", Side::Sell, 100, 4));
    book.apply(&limit("s2", "a", Side::Sell, 102, 10));
    let fok = |id: &str, qty| {
        place(
            id,
            "b",
            Side::Buy,
            OrderKind::Limit,
            TimeInForce::Fok,
            Some(101),
            None,
            qty,
        )
    };
    let events = book.apply(&fok("f1", 5));
    assert!(trades(&events).is_empty());
    assert!(matches!(
        events.last(),
        Some(Event::Cancelled {
            reason: CancelReason::FokUnfillable,
            remaining: 5,
            ..
        })
    ));
    assert_eq!(
        book.resting_order("s1").unwrap().remaining,
        4,
        "book untouched"
    );
    let events = book.apply(&fok("f2", 4));
    assert_eq!(trades(&events), vec![("s1".into(), "f2".into(), 100, 4)]);
}

#[test]
fn post_only_is_rejected_if_it_would_take() {
    let mut book = OrderBook::new();
    book.apply(&limit("s1", "a", Side::Sell, 100, 4));
    let po = |id: &str, price| {
        place(
            id,
            "b",
            Side::Buy,
            OrderKind::Limit,
            TimeInForce::PostOnly,
            Some(price),
            None,
            1,
        )
    };
    assert_eq!(
        book.apply(&po("p1", 100)),
        vec![Event::Rejected {
            order_id: "p1".into(),
            reason: RejectReason::PostOnlyWouldTake
        }]
    );
    assert!(matches!(
        book.apply(&po("p2", 99)).as_slice(),
        [Event::Accepted { .. }]
    ));
    assert_eq!(book.best_bid(), Some(99));
}

#[test]
fn market_orders_respect_protection_price_and_never_rest() {
    let mut book = OrderBook::new();
    book.apply(&limit("s1", "a", Side::Sell, 100, 2));
    book.apply(&limit("s2", "a", Side::Sell, 110, 2));
    let events = book.apply(&place(
        "m1",
        "b",
        Side::Buy,
        OrderKind::Market,
        TimeInForce::Ioc,
        Some(105),
        None,
        3,
    ));
    assert_eq!(trades(&events), vec![("s1".into(), "m1".into(), 100, 2)]);
    assert!(matches!(
        events.last(),
        Some(Event::Cancelled {
            remaining: 1,
            reason: CancelReason::Unfilled,
            ..
        })
    ));
    assert_eq!(book.best_bid(), None);

    // Market without protection takes any price; GTC market orders are invalid.
    let events = book.apply(&place(
        "m2",
        "b",
        Side::Buy,
        OrderKind::Market,
        TimeInForce::Ioc,
        None,
        None,
        2,
    ));
    assert_eq!(trades(&events), vec![("s2".into(), "m2".into(), 110, 2)]);
    let events = book.apply(&place(
        "m3",
        "b",
        Side::Buy,
        OrderKind::Market,
        TimeInForce::Gtc,
        None,
        None,
        1,
    ));
    assert_eq!(
        events,
        vec![Event::Rejected {
            order_id: "m3".into(),
            reason: RejectReason::InvalidTimeInForce
        }]
    );
}

#[test]
fn self_trade_prevention_cancels_the_taker() {
    let mut book = OrderBook::new();
    book.apply(&limit("s1", "other", Side::Sell, 99, 1));
    book.apply(&limit("s2", "alice", Side::Sell, 100, 5));
    let events = book.apply(&limit("b1", "alice", Side::Buy, 100, 3));
    assert_eq!(trades(&events), vec![("s1".into(), "b1".into(), 99, 1)]);
    assert_eq!(
        events.last(),
        Some(&Event::Cancelled {
            order_id: "b1".into(),
            remaining: 2,
            reason: CancelReason::SelfTradePrevention
        })
    );
    assert_eq!(
        book.resting_order("s2").unwrap().remaining,
        5,
        "resting order kept"
    );
    assert!(book.resting_order("b1").is_none(), "taker did not rest");
}

#[test]
fn stop_orders_trigger_on_last_trade_and_cascade_in_arrival_order() {
    let mut book = OrderBook::new();
    book.apply(&limit("s1", "a", Side::Sell, 100, 1));
    book.apply(&limit("s2", "a", Side::Sell, 105, 1));
    book.apply(&limit("s3", "a", Side::Sell, 110, 5));
    // Buy stops: trigger when last >= stop.
    let st1 = place(
        "st1",
        "b",
        Side::Buy,
        OrderKind::StopMarket,
        TimeInForce::Ioc,
        Some(200),
        Some(100),
        1,
    );
    let st2 = place(
        "st2",
        "c",
        Side::Buy,
        OrderKind::StopLimit,
        TimeInForce::Gtc,
        Some(110),
        Some(105),
        1,
    );
    assert!(matches!(
        book.apply(&st1).as_slice(),
        [Event::Accepted { .. }]
    ));
    assert!(matches!(
        book.apply(&st2).as_slice(),
        [Event::Accepted { .. }]
    ));
    assert_eq!(book.pending_stop_count(), 2);

    let events = book.apply(&limit("t", "d", Side::Buy, 100, 1)); // trades at 100 → st1 fires → trades at 105 → st2 fires
    let kinds: Vec<&str> = events
        .iter()
        .map(|e| match e {
            Event::Accepted { .. } => "accepted",
            Event::Trade { .. } => "trade",
            Event::Filled { .. } => "filled",
            Event::StopTriggered { .. } => "stop",
            _ => "other",
        })
        .collect();
    assert_eq!(
        kinds,
        [
            "accepted", "trade", "filled", "filled", "stop", "trade", "filled", "filled", "stop",
            "trade", "filled"
        ]
    );
    assert_eq!(
        trades(&events),
        vec![
            ("s1".into(), "t".into(), 100, 1),
            ("s2".into(), "st1".into(), 105, 1),
            ("s3".into(), "st2".into(), 110, 1)
        ]
    );
    assert_eq!(book.pending_stop_count(), 0);
}

#[test]
fn stops_that_would_trigger_immediately_are_rejected() {
    let mut book = OrderBook::new();
    book.apply(&limit("s1", "a", Side::Sell, 100, 1));
    book.apply(&limit("b1", "b", Side::Buy, 100, 1));
    let events = book.apply(&place(
        "st",
        "c",
        Side::Sell,
        OrderKind::StopMarket,
        TimeInForce::Ioc,
        None,
        Some(101),
        1,
    ));
    assert_eq!(
        events,
        vec![Event::Rejected {
            order_id: "st".into(),
            reason: RejectReason::StopWouldTriggerImmediately
        }]
    );
}

#[test]
fn cancel_and_reduce_are_owner_only_and_reduce_keeps_priority() {
    let mut book = OrderBook::new();
    book.apply(&limit("s1", "a", Side::Sell, 100, 10));
    book.apply(&limit("s2", "b", Side::Sell, 100, 10));
    assert_eq!(
        book.apply(&Command::Cancel {
            order_id: "s1".into(),
            account: "mallory".into()
        }),
        vec![Event::CommandRejected {
            order_id: "s1".into(),
            reason: RejectReason::NotOwner
        }]
    );
    assert_eq!(
        book.apply(&Command::Reduce {
            order_id: "s1".into(),
            account: "a".into(),
            remaining: 3
        }),
        vec![Event::Reduced {
            order_id: "s1".into(),
            remaining: 3
        }]
    );
    for bad in [0, 3, 50] {
        assert!(matches!(
            book.apply(&Command::Reduce {
                order_id: "s1".into(),
                account: "a".into(),
                remaining: bad
            })
            .as_slice(),
            [Event::CommandRejected {
                reason: RejectReason::InvalidReduce,
                ..
            }]
        ));
    }
    // s1 keeps time priority after the reduction.
    let events = book.apply(&limit("b", "c", Side::Buy, 100, 4));
    assert_eq!(
        trades(&events),
        vec![
            ("s1".into(), "b".into(), 100, 3),
            ("s2".into(), "b".into(), 100, 1)
        ]
    );
    assert_eq!(
        book.apply(&Command::Cancel {
            order_id: "s2".into(),
            account: "b".into()
        }),
        vec![Event::Cancelled {
            order_id: "s2".into(),
            remaining: 9,
            reason: CancelReason::User
        }]
    );
    assert_eq!(book.best_ask(), None);
    assert!(matches!(
        book.apply(&Command::Cancel {
            order_id: "s2".into(),
            account: "b".into()
        })
        .as_slice(),
        [Event::CommandRejected {
            reason: RejectReason::UnknownOrder,
            ..
        }]
    ));
}

#[test]
fn validation_rejects_bad_orders_and_duplicate_ids() {
    let mut book = OrderBook::new();
    let cases = [
        (
            limit("q0", "a", Side::Buy, 100, 0),
            RejectReason::InvalidQuantity,
        ),
        (
            limit("p0", "a", Side::Buy, 0, 1),
            RejectReason::InvalidPrice,
        ),
        (
            limit("big", "a", Side::Buy, MAX_UNITS + 1, 1),
            RejectReason::InvalidPrice,
        ),
        (
            place(
                "np",
                "a",
                Side::Buy,
                OrderKind::Limit,
                TimeInForce::Gtc,
                None,
                None,
                1,
            ),
            RejectReason::MissingPrice,
        ),
        (
            place(
                "ns",
                "a",
                Side::Buy,
                OrderKind::StopMarket,
                TimeInForce::Ioc,
                None,
                None,
                1,
            ),
            RejectReason::MissingStopPrice,
        ),
        (
            place(
                "us",
                "a",
                Side::Buy,
                OrderKind::Limit,
                TimeInForce::Gtc,
                Some(1),
                Some(1),
                1,
            ),
            RejectReason::UnexpectedStopPrice,
        ),
    ];
    for (cmd, reason) in cases {
        let events = book.apply(&cmd);
        assert!(
            matches!(events.as_slice(), [Event::Rejected { reason: r, .. }] if *r == reason),
            "{cmd:?} → {events:?}"
        );
    }
    book.apply(&limit("dup", "a", Side::Buy, 1, 1));
    assert_eq!(
        book.apply(&limit("dup", "a", Side::Buy, 1, 1)),
        vec![Event::Rejected {
            order_id: "dup".into(),
            reason: RejectReason::DuplicateOrderId
        }]
    );
    // A rejected id cannot be reused either.
    assert!(matches!(
        book.apply(&limit("q0", "a", Side::Buy, 1, 1)).as_slice(),
        [Event::Rejected {
            reason: RejectReason::DuplicateOrderId,
            ..
        }]
    ));
}

#[test]
fn sequencer_enforces_gap_free_commands_and_handles_malformed_json() {
    let mut seq = Sequencer::new();
    assert!(
        seq.apply(2, &limit("x", "a", Side::Buy, 1, 1)).is_err(),
        "gap rejected"
    );
    let out = seq.apply_json(1, "{not json").unwrap();
    assert_eq!(
        out[0].event,
        Event::CommandRejected {
            order_id: String::new(),
            reason: RejectReason::MalformedCommand
        }
    );
    let out = seq.apply_json(2, r#"{"type":"place","order_id":"o1","account":"a","side":"buy","kind":"limit","tif":"gtc","price":5,"stop_price":null,"quantity":1}"#).unwrap();
    assert_eq!(out[0].seq, 2);
    assert!(matches!(out[0].event, Event::Accepted { .. }));
    assert!(
        seq.apply(2, &limit("y", "a", Side::Buy, 1, 1)).is_err(),
        "replay of old seq rejected"
    );
    assert_eq!(seq.last_command_seq(), 2);
}

#[test]
fn wire_format_is_stable() {
    let json = serde_json::to_string(&Event::Cancelled {
        order_id: "o".into(),
        remaining: 3,
        reason: CancelReason::SelfTradePrevention,
    })
    .unwrap();
    assert_eq!(
        json,
        r#"{"type":"cancelled","order_id":"o","remaining":3,"reason":"self_trade_prevention"}"#
    );
}

fn with_trigger(cmd: Command, trigger: Trigger) -> Command {
    match cmd {
        Command::Place(mut o) => {
            o.trigger = Some(trigger);
            Command::Place(o)
        }
        other => other,
    }
}

#[test]
fn take_profit_triggers_in_the_opposite_direction() {
    let mut book = OrderBook::new();
    book.apply(&limit("s1", "a", Side::Sell, 100, 1));
    book.apply(&limit("b1", "b", Side::Buy, 100, 1)); // last = 100
    book.apply(&limit("bid", "m", Side::Buy, 109, 5));
    // A sell take-profit at 110 waits for the price to RISE to 110.
    let tp = with_trigger(
        place(
            "tp",
            "c",
            Side::Sell,
            OrderKind::StopMarket,
            TimeInForce::Ioc,
            None,
            Some(110),
            1,
        ),
        Trigger::Above,
    );
    assert!(matches!(
        book.apply(&tp).as_slice(),
        [Event::Accepted { .. }]
    ));
    // A fall in price does not trigger it.
    book.apply(&limit("s2", "a", Side::Sell, 109, 1));
    assert_eq!(book.pending_stop_count(), 1);
    // A trade at 110 does.
    book.apply(&limit("s3", "a", Side::Sell, 110, 1));
    let events = book.apply(&limit("b2", "d", Side::Buy, 110, 1));
    assert!(events
        .iter()
        .any(|e| matches!(e, Event::StopTriggered { order_id, .. } if order_id == "tp")));
    assert_eq!(book.pending_stop_count(), 0);
    // An "above" take-profit that is already reached is rejected, never fired at once.
    let late = with_trigger(
        place(
            "late",
            "c",
            Side::Sell,
            OrderKind::StopMarket,
            TimeInForce::Ioc,
            None,
            Some(105),
            1,
        ),
        Trigger::Above,
    );
    assert_eq!(
        book.apply(&late),
        vec![Event::Rejected {
            order_id: "late".into(),
            reason: RejectReason::StopWouldTriggerImmediately
        }]
    );
    // A trigger on a non-stop order is malformed.
    let bad = with_trigger(limit("bad", "c", Side::Buy, 1, 1), Trigger::Below);
    assert_eq!(
        book.apply(&bad),
        vec![Event::Rejected {
            order_id: "bad".into(),
            reason: RejectReason::UnexpectedTrigger
        }]
    );
}

#[test]
fn trigger_is_omitted_from_the_wire_when_absent() {
    let json = serde_json::to_string(&limit("x", "a", Side::Buy, 1, 1)).unwrap();
    assert!(!json.contains("trigger"));
}

fn block_order(id: &str, acct: &str, side: Side, price: u64, qty: u64) -> PlaceOrder {
    PlaceOrder {
        order_id: id.into(),
        account: acct.into(),
        side,
        kind: OrderKind::Limit,
        tif: TimeInForce::Fok,
        price: Some(price),
        stop_price: None,
        quantity: qty,
        trigger: None,
    }
}

#[test]
fn block_trades_fill_only_against_each_other_and_leave_the_book_alone() {
    let mut book = OrderBook::new();
    book.apply(&limit("s1", "a", Side::Sell, 100, 1));
    book.apply(&limit("b1", "b", Side::Buy, 100, 1)); // last = 100
    book.apply(&limit("ask", "m", Side::Sell, 101, 5));
    // A sell stop at 95 would fire if the block moved the last price.
    book.apply(&place(
        "st",
        "c",
        Side::Sell,
        OrderKind::StopMarket,
        TimeInForce::Ioc,
        None,
        Some(95),
        1,
    ));
    let events = book.apply(&Command::Block {
        buy: block_order("rb", "q", Side::Buy, 90, 10),
        sell: block_order("rs", "mm", Side::Sell, 90, 10),
        maker: Side::Sell,
    });
    assert_eq!(
        trades(&events),
        vec![("rs".to_string(), "rb".to_string(), 90, 10)]
    );
    assert!(matches!(events.last(), Some(Event::Filled { .. })));
    assert_eq!(
        book.pending_stop_count(),
        1,
        "the block did not trigger the stop"
    );
    // The resting ask is untouched.
    let events = book.apply(&limit("t", "z", Side::Buy, 101, 5));
    assert_eq!(
        trades(&events),
        vec![("ask".to_string(), "t".to_string(), 101, 5)]
    );
}

#[test]
fn malformed_or_self_blocks_are_rejected_on_both_sides() {
    let mut book = OrderBook::new();
    for (buy, sell) in [
        (
            block_order("b1", "a", Side::Buy, 90, 10),
            block_order("s1", "a", Side::Sell, 90, 10),
        ), // same account
        (
            block_order("b2", "a", Side::Buy, 90, 10),
            block_order("s2", "b", Side::Sell, 91, 10),
        ), // price mismatch
        (
            block_order("b3", "a", Side::Buy, 90, 10),
            block_order("s3", "b", Side::Sell, 90, 9),
        ), // size mismatch
    ] {
        let events = book.apply(&Command::Block {
            buy,
            sell,
            maker: Side::Sell,
        });
        assert_eq!(events.len(), 2);
        assert!(events.iter().all(|e| matches!(
            e,
            Event::Rejected {
                reason: RejectReason::InvalidBlock,
                ..
            }
        )));
    }
}
