//! Single-market order book with price-time priority.
//!
//! All collections are ordered (`BTreeMap`/`VecDeque`) so iteration and
//! serialisation are deterministic. The book never sees balances: funds are
//! held by the ledger before a command is issued.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use serde::{Deserialize, Serialize};

use crate::types::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RestingOrder {
    pub order_id: String,
    pub account: String,
    pub side: Side,
    pub price: Price,
    pub remaining: Qty,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingStop {
    pub order: PlaceOrder,
    pub remaining: Qty,
}

/// An order currently taking liquidity.
struct Taker {
    order_id: String,
    account: String,
    side: Side,
    /// Worst acceptable price; `None` = unbounded (market order without protection).
    limit: Option<Price>,
    tif: TimeInForce,
    /// Whether an unfilled remainder may rest in the book.
    can_rest: bool,
    remaining: Qty,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrderBook {
    /// price → FIFO queue of order ids (time priority).
    bids: BTreeMap<Price, VecDeque<String>>,
    asks: BTreeMap<Price, VecDeque<String>>,
    resting: BTreeMap<String, RestingOrder>,
    /// arrival number → pending stop (arrival order = trigger priority).
    stops: BTreeMap<u64, PendingStop>,
    stop_index: BTreeMap<String, u64>,
    /// Every order id ever seen (duplicate protection).
    known_ids: BTreeSet<String>,
    last_trade_price: Option<Price>,
    next_arrival: u64,
}

fn valid_units(v: u64) -> bool {
    v > 0 && v <= MAX_UNITS
}

impl OrderBook {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn best_bid(&self) -> Option<Price> {
        self.bids.keys().next_back().copied()
    }

    pub fn best_ask(&self) -> Option<Price> {
        self.asks.keys().next().copied()
    }

    pub fn last_trade_price(&self) -> Option<Price> {
        self.last_trade_price
    }

    pub fn resting_order(&self, order_id: &str) -> Option<&RestingOrder> {
        self.resting.get(order_id)
    }

    pub fn resting_orders(&self) -> impl Iterator<Item = &RestingOrder> {
        self.resting.values()
    }

    pub fn pending_stop_count(&self) -> usize {
        self.stops.len()
    }

    /// Aggregated depth: (price, total quantity) best first.
    pub fn depth(&self, side: Side) -> Vec<(Price, Qty)> {
        let level_qty =
            |ids: &VecDeque<String>| ids.iter().map(|id| self.resting[id].remaining).sum::<u64>();
        match side {
            Side::Buy => self
                .bids
                .iter()
                .rev()
                .map(|(p, ids)| (*p, level_qty(ids)))
                .collect(),
            Side::Sell => self
                .asks
                .iter()
                .map(|(p, ids)| (*p, level_qty(ids)))
                .collect(),
        }
    }

    /// Applies one command and returns the resulting events, in order.
    pub fn apply(&mut self, command: &Command) -> Vec<Event> {
        let mut events = Vec::new();
        match command {
            Command::Place(order) => self.place(order, &mut events),
            Command::Cancel { order_id, account } => self.cancel(order_id, account, &mut events),
            Command::Reduce {
                order_id,
                account,
                remaining,
            } => self.reduce(order_id, account, *remaining, &mut events),
            Command::Block { buy, sell, maker } => self.block(buy, sell, *maker, &mut events),
        }
        events
    }

    // ------------------------------------------------------------ block

    fn block(&mut self, buy: &PlaceOrder, sell: &PlaceOrder, maker: Side, events: &mut Vec<Event>) {
        let shape_ok = buy.side == Side::Buy
            && sell.side == Side::Sell
            && buy.kind == OrderKind::Limit
            && sell.kind == OrderKind::Limit
            && buy.tif == TimeInForce::Fok
            && sell.tif == TimeInForce::Fok
            && buy.price.is_some()
            && buy.price == sell.price
            && buy.quantity == sell.quantity
            && buy.account != sell.account
            && buy.order_id != sell.order_id
            && self.validate(buy).is_ok()
            && self.validate(sell).is_ok();
        let duplicate =
            self.known_ids.contains(&buy.order_id) || self.known_ids.contains(&sell.order_id);
        for o in [buy, sell] {
            if !o.order_id.is_empty() {
                self.known_ids.insert(o.order_id.clone());
            }
        }
        if !shape_ok || duplicate {
            let reason = if duplicate {
                RejectReason::DuplicateOrderId
            } else {
                RejectReason::InvalidBlock
            };
            for o in [buy, sell] {
                events.push(Event::Rejected {
                    order_id: o.order_id.clone(),
                    reason,
                });
            }
            return;
        }
        events.push(Self::accepted(buy));
        events.push(Self::accepted(sell));
        let (m, t) = if maker == Side::Buy {
            (buy, sell)
        } else {
            (sell, buy)
        };
        events.push(Event::Trade {
            maker_order_id: m.order_id.clone(),
            taker_order_id: t.order_id.clone(),
            maker_account: m.account.clone(),
            taker_account: t.account.clone(),
            taker_side: t.side,
            price: buy.price.expect("checked"),
            quantity: buy.quantity,
            maker_remaining: 0,
            taker_remaining: 0,
        });
        events.push(Event::Filled {
            order_id: m.order_id.clone(),
        });
        events.push(Event::Filled {
            order_id: t.order_id.clone(),
        });
    }

    // ------------------------------------------------------------ place

    fn validate(&self, o: &PlaceOrder) -> Result<(), RejectReason> {
        if o.order_id.is_empty() || o.account.is_empty() {
            return Err(RejectReason::MalformedCommand);
        }
        if !valid_units(o.quantity) {
            return Err(RejectReason::InvalidQuantity);
        }
        if let Some(p) = o.price {
            if !valid_units(p) {
                return Err(RejectReason::InvalidPrice);
            }
        }
        if let Some(p) = o.stop_price {
            if !valid_units(p) {
                return Err(RejectReason::InvalidPrice);
            }
        }
        match o.kind {
            OrderKind::Limit | OrderKind::StopLimit if o.price.is_none() => {
                return Err(RejectReason::MissingPrice)
            }
            OrderKind::StopLimit | OrderKind::StopMarket if o.stop_price.is_none() => {
                return Err(RejectReason::MissingStopPrice)
            }
            OrderKind::Limit | OrderKind::Market if o.stop_price.is_some() => {
                return Err(RejectReason::UnexpectedStopPrice)
            }
            OrderKind::Limit | OrderKind::Market if o.trigger.is_some() => {
                return Err(RejectReason::UnexpectedTrigger)
            }
            _ => {}
        }
        let tif_ok = match o.kind {
            OrderKind::Limit => true,
            OrderKind::StopLimit => o.tif != TimeInForce::PostOnly,
            OrderKind::Market | OrderKind::StopMarket => {
                matches!(o.tif, TimeInForce::Ioc | TimeInForce::Fok)
            }
        };
        if !tif_ok {
            return Err(RejectReason::InvalidTimeInForce);
        }
        Ok(())
    }

    fn place(&mut self, o: &PlaceOrder, events: &mut Vec<Event>) {
        if self.known_ids.contains(&o.order_id) {
            events.push(Event::Rejected {
                order_id: o.order_id.clone(),
                reason: RejectReason::DuplicateOrderId,
            });
            return;
        }
        if !o.order_id.is_empty() {
            self.known_ids.insert(o.order_id.clone());
        }
        if let Err(reason) = self.validate(o) {
            events.push(Event::Rejected {
                order_id: o.order_id.clone(),
                reason,
            });
            return;
        }

        if o.kind.is_stop() {
            let stop = o.stop_price.expect("validated");
            if self
                .last_trade_price
                .is_some_and(|last| Self::stop_triggered(o.side, o.trigger, stop, last))
            {
                events.push(Event::Rejected {
                    order_id: o.order_id.clone(),
                    reason: RejectReason::StopWouldTriggerImmediately,
                });
                return;
            }
            events.push(Self::accepted(o));
            let arrival = self.next_arrival;
            self.next_arrival += 1;
            self.stop_index.insert(o.order_id.clone(), arrival);
            self.stops.insert(
                arrival,
                PendingStop {
                    order: o.clone(),
                    remaining: o.quantity,
                },
            );
            return;
        }

        if o.tif == TimeInForce::PostOnly && self.would_cross(o.side, o.price) {
            events.push(Event::Rejected {
                order_id: o.order_id.clone(),
                reason: RejectReason::PostOnlyWouldTake,
            });
            return;
        }

        events.push(Self::accepted(o));
        let traded = self.execute(Self::taker_from(o, o.quantity), events);
        if traded {
            self.process_stop_triggers(events);
        }
    }

    fn accepted(o: &PlaceOrder) -> Event {
        Event::Accepted {
            order_id: o.order_id.clone(),
            account: o.account.clone(),
            side: o.side,
            kind: o.kind,
            tif: o.tif,
            price: o.price,
            stop_price: o.stop_price,
            quantity: o.quantity,
        }
    }

    fn taker_from(o: &PlaceOrder, remaining: Qty) -> Taker {
        let limit_like = matches!(o.kind, OrderKind::Limit | OrderKind::StopLimit);
        Taker {
            order_id: o.order_id.clone(),
            account: o.account.clone(),
            side: o.side,
            limit: o.price,
            tif: o.tif,
            can_rest: limit_like && matches!(o.tif, TimeInForce::Gtc | TimeInForce::PostOnly),
            remaining,
        }
    }

    fn stop_triggered(side: Side, trigger: Option<Trigger>, stop: Price, last: Price) -> bool {
        let direction = trigger.unwrap_or(match side {
            Side::Buy => Trigger::Above,
            Side::Sell => Trigger::Below,
        });
        match direction {
            Trigger::Above => last >= stop,
            Trigger::Below => last <= stop,
        }
    }

    fn price_acceptable(side: Side, limit: Option<Price>, level: Price) -> bool {
        match (side, limit) {
            (_, None) => true,
            (Side::Buy, Some(l)) => level <= l,
            (Side::Sell, Some(l)) => level >= l,
        }
    }

    fn would_cross(&self, side: Side, limit: Option<Price>) -> bool {
        let best = match side {
            Side::Buy => self.best_ask(),
            Side::Sell => self.best_bid(),
        };
        best.is_some_and(|b| Self::price_acceptable(side, limit, b))
    }

    /// Opposite-side price levels in priority order (best first).
    fn opposite_levels(&self, side: Side) -> Vec<Price> {
        match side {
            Side::Buy => self.asks.keys().copied().collect(),
            Side::Sell => self.bids.keys().rev().copied().collect(),
        }
    }

    /// Quantity a taker could fill before hitting its price limit or its own order.
    fn fillable_quantity(&self, taker: &Taker) -> Qty {
        let mut total: Qty = 0;
        for price in self.opposite_levels(taker.side) {
            if !Self::price_acceptable(taker.side, taker.limit, price) {
                break;
            }
            let level = match taker.side {
                Side::Buy => &self.asks[&price],
                Side::Sell => &self.bids[&price],
            };
            for id in level {
                let maker = &self.resting[id];
                if maker.account == taker.account {
                    return total; // self-trade prevention would stop matching here
                }
                total = total.saturating_add(maker.remaining);
                if total >= taker.remaining {
                    return total;
                }
            }
        }
        total
    }

    /// Matches a taker against the book. Returns whether any trade happened.
    fn execute(&mut self, mut taker: Taker, events: &mut Vec<Event>) -> bool {
        if taker.tif == TimeInForce::Fok && self.fillable_quantity(&taker) < taker.remaining {
            events.push(Event::Cancelled {
                order_id: taker.order_id,
                remaining: taker.remaining,
                reason: CancelReason::FokUnfillable,
            });
            return false;
        }

        let mut traded = false;
        while taker.remaining > 0 {
            let best = match taker.side {
                Side::Buy => self.best_ask(),
                Side::Sell => self.best_bid(),
            };
            let Some(price) = best else { break };
            if !Self::price_acceptable(taker.side, taker.limit, price) {
                break;
            }
            let level = match taker.side {
                Side::Buy => self.asks.get_mut(&price),
                Side::Sell => self.bids.get_mut(&price),
            }
            .expect("best level exists");
            let maker_id = level.front().expect("levels are never empty").clone();
            let maker = self
                .resting
                .get_mut(&maker_id)
                .expect("indexed order exists");

            if maker.account == taker.account {
                events.push(Event::Cancelled {
                    order_id: taker.order_id.clone(),
                    remaining: taker.remaining,
                    reason: CancelReason::SelfTradePrevention,
                });
                return traded;
            }

            let quantity = maker.remaining.min(taker.remaining);
            maker.remaining -= quantity;
            taker.remaining -= quantity;
            traded = true;
            self.last_trade_price = Some(price);
            events.push(Event::Trade {
                maker_order_id: maker_id.clone(),
                taker_order_id: taker.order_id.clone(),
                maker_account: maker.account.clone(),
                taker_account: taker.account.clone(),
                taker_side: taker.side,
                price,
                quantity,
                maker_remaining: maker.remaining,
                taker_remaining: taker.remaining,
            });
            if maker.remaining == 0 {
                level.pop_front();
                if level.is_empty() {
                    match taker.side {
                        Side::Buy => self.asks.remove(&price),
                        Side::Sell => self.bids.remove(&price),
                    };
                }
                self.resting.remove(&maker_id);
                events.push(Event::Filled { order_id: maker_id });
            }
        }

        if taker.remaining == 0 {
            events.push(Event::Filled {
                order_id: taker.order_id,
            });
        } else if taker.can_rest {
            let price = taker.limit.expect("resting orders have a limit price");
            let book_side = match taker.side {
                Side::Buy => &mut self.bids,
                Side::Sell => &mut self.asks,
            };
            book_side
                .entry(price)
                .or_default()
                .push_back(taker.order_id.clone());
            self.resting.insert(
                taker.order_id.clone(),
                RestingOrder {
                    order_id: taker.order_id,
                    account: taker.account,
                    side: taker.side,
                    price,
                    remaining: taker.remaining,
                },
            );
        } else {
            events.push(Event::Cancelled {
                order_id: taker.order_id,
                remaining: taker.remaining,
                reason: CancelReason::Unfilled,
            });
        }
        traded
    }

    /// Triggers pending stops (arrival order) until none fire; cascades are deterministic.
    fn process_stop_triggers(&mut self, events: &mut Vec<Event>) {
        loop {
            let Some(last) = self.last_trade_price else {
                return;
            };
            let next = self
                .stops
                .iter()
                .find(|(_, s)| {
                    Self::stop_triggered(
                        s.order.side,
                        s.order.trigger,
                        s.order.stop_price.expect("stop"),
                        last,
                    )
                })
                .map(|(arrival, _)| *arrival);
            let Some(arrival) = next else { return };
            let stop = self.stops.remove(&arrival).expect("found above");
            self.stop_index.remove(&stop.order.order_id);
            events.push(Event::StopTriggered {
                order_id: stop.order.order_id.clone(),
                trigger_price: last,
            });
            self.execute(Self::taker_from(&stop.order, stop.remaining), events);
        }
    }

    // ----------------------------------------------------------- cancel / reduce

    fn cancel(&mut self, order_id: &str, account: &str, events: &mut Vec<Event>) {
        if let Some(order) = self.resting.get(order_id) {
            if order.account != account {
                events.push(Event::CommandRejected {
                    order_id: order_id.into(),
                    reason: RejectReason::NotOwner,
                });
                return;
            }
            let order = self.resting.remove(order_id).expect("checked");
            let book_side = match order.side {
                Side::Buy => &mut self.bids,
                Side::Sell => &mut self.asks,
            };
            if let Some(level) = book_side.get_mut(&order.price) {
                level.retain(|id| id != order_id);
                if level.is_empty() {
                    book_side.remove(&order.price);
                }
            }
            events.push(Event::Cancelled {
                order_id: order_id.into(),
                remaining: order.remaining,
                reason: CancelReason::User,
            });
        } else if let Some(arrival) = self.stop_index.get(order_id).copied() {
            if self.stops[&arrival].order.account != account {
                events.push(Event::CommandRejected {
                    order_id: order_id.into(),
                    reason: RejectReason::NotOwner,
                });
                return;
            }
            let stop = self.stops.remove(&arrival).expect("indexed");
            self.stop_index.remove(order_id);
            events.push(Event::Cancelled {
                order_id: order_id.into(),
                remaining: stop.remaining,
                reason: CancelReason::User,
            });
        } else {
            events.push(Event::CommandRejected {
                order_id: order_id.into(),
                reason: RejectReason::UnknownOrder,
            });
        }
    }

    fn reduce(
        &mut self,
        order_id: &str,
        account: &str,
        new_remaining: Qty,
        events: &mut Vec<Event>,
    ) {
        let current = if let Some(o) = self.resting.get_mut(order_id) {
            Some((&mut o.remaining, o.account == account))
        } else if let Some(arrival) = self.stop_index.get(order_id).copied() {
            let s = self.stops.get_mut(&arrival).expect("indexed");
            Some((&mut s.remaining, s.order.account == account))
        } else {
            None
        };
        match current {
            None => events.push(Event::CommandRejected {
                order_id: order_id.into(),
                reason: RejectReason::UnknownOrder,
            }),
            Some((_, false)) => events.push(Event::CommandRejected {
                order_id: order_id.into(),
                reason: RejectReason::NotOwner,
            }),
            Some((remaining, true)) => {
                if new_remaining == 0 || new_remaining >= *remaining {
                    events.push(Event::CommandRejected {
                        order_id: order_id.into(),
                        reason: RejectReason::InvalidReduce,
                    });
                } else {
                    *remaining = new_remaining;
                    events.push(Event::Reduced {
                        order_id: order_id.into(),
                        remaining: new_remaining,
                    });
                }
            }
        }
    }
}
