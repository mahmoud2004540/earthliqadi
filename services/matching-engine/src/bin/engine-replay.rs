//! engine-replay: verifies that THIS engine build reproduces the recorded event
//! log of every market (or one market) exactly. Read-only; safe to run against
//! a live database or a restored backup.
//!
//!   DATABASE_URL=... engine-replay [--market SYMBOL]
//!
//! Prints one JSON line per market and exits 0 if all match, 2 on any divergence.

use std::env;
use std::error::Error;

use futures_util::StreamExt;
use matching_engine::replay::{verify, RecordedEvent};
use serde_json::{json, Value};
use tokio_postgres::NoTls;

type BoxError = Box<dyn Error + Send + Sync>;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    match run().await {
        Ok(true) => {}
        Ok(false) => std::process::exit(2),
        Err(err) => {
            eprintln!(
                "{}",
                json!({ "level": "error", "msg": "replay failed", "error": err.to_string() })
            );
            std::process::exit(1);
        }
    }
}

async fn run() -> Result<bool, BoxError> {
    let url = env::var("DATABASE_URL").map_err(|_| "DATABASE_URL is required")?;
    let args: Vec<String> = env::args().collect();
    let market_filter = args
        .iter()
        .position(|a| a == "--market")
        .and_then(|i| args.get(i + 1))
        .cloned();

    let (client, connection) = tokio_postgres::connect(&url, NoTls).await?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    // One consistent, read-only snapshot for all markets (safe alongside a live engine).
    client
        .batch_execute("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .await?;

    let markets = client
        .query(
            "SELECT m.id::text, m.symbol, s.last_command_seq, s.state_hash
               FROM markets m JOIN engine_market_state s ON s.market_id = m.id
              WHERE $1::text IS NULL OR m.symbol = $1
              ORDER BY m.symbol",
            &[&market_filter],
        )
        .await?;
    if markets.is_empty() {
        return Err("no matching markets with engine state".into());
    }

    let mut all_ok = true;
    for row in markets {
        let (id, symbol, last_command, hash): (String, String, i64, String) =
            (row.get(0), row.get(1), row.get(2), row.get(3));
        let commands = client
            .query(
                "SELECT seq, payload::text FROM engine_commands WHERE market_id = $1::text::uuid AND seq <= $2 ORDER BY seq",
                &[&id, &last_command],
            )
            .await?
            .into_iter()
            .map(|r| (r.get::<_, i64>(0) as u64, r.get::<_, String>(1)));
        let mut recorded = Vec::new();
        let stream = client
            .query_raw(
                "SELECT seq, command_seq, payload::text FROM engine_events WHERE market_id = $1::text::uuid ORDER BY seq",
                &[&id],
            )
            .await?;
        futures_util::pin_mut!(stream);
        while let Some(r) = stream.next().await {
            let r = r?;
            let payload: Value = serde_json::from_str(&r.get::<_, String>(2))?;
            recorded.push(RecordedEvent {
                seq: r.get::<_, i64>(0) as u64,
                command_seq: r.get::<_, i64>(1) as u64,
                payload,
            });
        }
        let report = verify(commands, &recorded, Some(&hash));
        all_ok &= report.ok();
        println!(
            "{}",
            json!({ "market": symbol, "ok": report.ok(), "report": report })
        );
    }
    client.batch_execute("ROLLBACK").await?;
    Ok(all_ok)
}
