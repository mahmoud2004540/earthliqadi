//! Wire protocol between the API and the engine (JSON, stored in PostgreSQL).
//! Prices are integer ticks, quantities integer lots (ADR-0007). No floats.

use serde::{Deserialize, Serialize};

/// Integer number of price ticks.
pub type Price = u64;
/// Integer number of quantity lots.
pub type Qty = u64;

/// Upper bound for prices and quantities (keeps values far inside i64 and ledger limits).
pub const MAX_UNITS: u64 = 1_000_000_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Buy,
    Sell,
}

impl Side {
    pub fn opposite(self) -> Side {
        match self {
            Side::Buy => Side::Sell,
            Side::Sell => Side::Buy,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrderKind {
    Limit,
    Market,
    StopLimit,
    StopMarket,
}

impl OrderKind {
    pub fn is_stop(self) -> bool {
        matches!(self, OrderKind::StopLimit | OrderKind::StopMarket)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimeInForce {
    Gtc,
    Ioc,
    Fok,
    PostOnly,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlaceOrder {
    pub order_id: String,
    pub account: String,
    pub side: Side,
    pub kind: OrderKind,
    pub tif: TimeInForce,
    /// Limit price (limit / stop_limit) or protection price (market / stop_market).
    pub price: Option<Price>,
    pub stop_price: Option<Price>,
    pub quantity: Qty,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    Place(PlaceOrder),
    Cancel {
        order_id: String,
        account: String,
    },
    /// Reduce the remaining quantity in place (keeps time priority).
    Reduce {
        order_id: String,
        account: String,
        remaining: Qty,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RejectReason {
    MalformedCommand,
    InvalidQuantity,
    InvalidPrice,
    MissingPrice,
    MissingStopPrice,
    UnexpectedStopPrice,
    InvalidTimeInForce,
    DuplicateOrderId,
    UnknownOrder,
    NotOwner,
    PostOnlyWouldTake,
    StopWouldTriggerImmediately,
    InvalidReduce,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelReason {
    User,
    /// IOC / market remainder that could not be filled.
    Unfilled,
    FokUnfillable,
    SelfTradePrevention,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    Accepted {
        order_id: String,
        account: String,
        side: Side,
        kind: OrderKind,
        tif: TimeInForce,
        price: Option<Price>,
        stop_price: Option<Price>,
        quantity: Qty,
    },
    Rejected {
        order_id: String,
        reason: RejectReason,
    },
    StopTriggered {
        order_id: String,
        trigger_price: Price,
    },
    Trade {
        maker_order_id: String,
        taker_order_id: String,
        maker_account: String,
        taker_account: String,
        taker_side: Side,
        price: Price,
        quantity: Qty,
        maker_remaining: Qty,
        taker_remaining: Qty,
    },
    Cancelled {
        order_id: String,
        remaining: Qty,
        reason: CancelReason,
    },
    Filled {
        order_id: String,
    },
    Reduced {
        order_id: String,
        remaining: Qty,
    },
    /// A cancel/reduce that could not be applied (no state change).
    CommandRejected {
        order_id: String,
        reason: RejectReason,
    },
}
