//! engine-server: moves commands from PostgreSQL through the deterministic
//! matching library and writes events back (ADR-0007).
//!
//! Guarantees:
//! - one active engine (session advisory lock; others wait as standby);
//! - on start, every processed command is replayed and must reproduce the stored
//!   event sequence and state hash, otherwise the engine refuses to run;
//! - events and offsets of a batch commit atomically (optimistic offset check);
//! - any error terminates the process so a supervisor restarts it from durable state.

use std::collections::BTreeMap;
use std::env;
use std::error::Error;
use std::time::Duration;

use futures_util::StreamExt;
use matching_engine::{EventEnvelope, Sequencer};
use serde_json::json;
use tokio::sync::mpsc;
use tokio_postgres::{AsyncMessage, Client, NoTls};

type BoxError = Box<dyn Error + Send + Sync>;

/// Advisory lock key reserved for the matching engine.
const ENGINE_LOCK_KEY: i64 = 7_270_001;
const BATCH_LIMIT: i64 = 500;

fn log(level: &str, msg: &str, fields: serde_json::Value) {
    let mut line = json!({ "level": level, "service": "matching-engine", "msg": msg });
    if let (Some(obj), serde_json::Value::Object(extra)) = (line.as_object_mut(), fields) {
        obj.extend(extra);
    }
    println!("{line}");
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    if let Err(err) = run().await {
        log(
            "error",
            "engine stopped",
            json!({ "error": err.to_string() }),
        );
        std::process::exit(1);
    }
}

async fn run() -> Result<(), BoxError> {
    let url = env::var("DATABASE_URL").map_err(|_| "DATABASE_URL is required")?;
    let poll_ms: u64 = env::var("ENGINE_POLL_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(200);

    // TLS: development uses a private network. Production must use TLS (see ADR-0007 consequences).
    let (mut client, mut connection) = tokio_postgres::connect(&url, NoTls).await?;
    let (notify_tx, mut notify_rx) = mpsc::unbounded_channel::<()>();
    tokio::spawn(async move {
        let mut messages = futures_util::stream::poll_fn(move |cx| connection.poll_message(cx));
        while let Some(message) = messages.next().await {
            match message {
                Ok(AsyncMessage::Notification(_)) => {
                    let _ = notify_tx.send(());
                }
                Ok(_) => {}
                Err(err) => {
                    log(
                        "error",
                        "database connection lost",
                        json!({ "error": err.to_string() }),
                    );
                    break;
                }
            }
        }
        std::process::exit(2);
    });

    loop {
        let locked: bool = client
            .query_one("SELECT pg_try_advisory_lock($1)", &[&ENGINE_LOCK_KEY])
            .await?
            .get(0);
        if locked {
            break;
        }
        log(
            "info",
            "another engine is active; waiting as standby",
            json!({}),
        );
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    client.batch_execute("LISTEN engine_commands").await?;

    let mut markets = recover(&client).await?;
    log(
        "info",
        "engine ready",
        json!({ "markets": markets.len(), "poll_ms": poll_ms }),
    );

    loop {
        let processed = process_batch(&mut client, &mut markets).await?;
        if processed == 0 {
            tokio::select! {
                _ = notify_rx.recv() => {}
                _ = tokio::time::sleep(Duration::from_millis(poll_ms)) => {}
                _ = tokio::signal::ctrl_c() => {
                    log("info", "shutdown requested", json!({}));
                    return Ok(());
                }
            }
            while notify_rx.try_recv().is_ok() {}
        }
    }
}

/// Rebuilds every market by replaying its processed commands and verifies the
/// result against the durable offsets and state hash.
async fn recover(client: &Client) -> Result<BTreeMap<String, Sequencer>, BoxError> {
    let mut markets = BTreeMap::new();
    let states = client
        .query(
            "SELECT market_id::text, last_command_seq, last_event_seq, state_hash FROM engine_market_state ORDER BY market_id",
            &[],
        )
        .await?;
    for row in states {
        let market: String = row.get(0);
        let last_command: i64 = row.get(1);
        let last_event: i64 = row.get(2);
        let hash: String = row.get(3);
        let commands = client
            .query(
                "SELECT seq, payload::text FROM engine_commands WHERE market_id = $1::text::uuid AND seq <= $2 ORDER BY seq",
                &[&market, &last_command],
            )
            .await?;
        let mut sequencer = Sequencer::new();
        for c in commands {
            let seq: i64 = c.get(0);
            let payload: String = c.get(1);
            sequencer.apply_json(seq as u64, &payload)?;
        }
        if sequencer.last_command_seq() != last_command as u64
            || sequencer.last_event_seq() != last_event as u64
            || sequencer.state_hash() != hash
        {
            return Err(format!(
                "replay of market {market} does not reproduce stored state (commands {}/{last_command}, events {}/{last_event}, hash match: {})",
                sequencer.last_command_seq(),
                sequencer.last_event_seq(),
                sequencer.state_hash() == hash
            )
            .into());
        }
        log(
            "info",
            "market recovered and verified",
            json!({ "market": market, "last_command_seq": last_command, "last_event_seq": last_event }),
        );
        markets.insert(market, sequencer);
    }
    Ok(markets)
}

async fn process_batch(
    client: &mut Client,
    markets: &mut BTreeMap<String, Sequencer>,
) -> Result<usize, BoxError> {
    let rows = client
        .query(
            "SELECT c.market_id::text, c.seq, c.payload::text
               FROM engine_commands c
               LEFT JOIN engine_market_state s ON s.market_id = c.market_id
              WHERE c.seq > COALESCE(s.last_command_seq, 0)
              ORDER BY c.market_id, c.seq
              LIMIT $1",
            &[&BATCH_LIMIT],
        )
        .await?;
    let mut grouped: BTreeMap<String, Vec<(i64, String)>> = BTreeMap::new();
    for row in &rows {
        grouped
            .entry(row.get(0))
            .or_default()
            .push((row.get(1), row.get(2)));
    }

    for (market, commands) in grouped {
        let sequencer = markets.entry(market.clone()).or_default();
        let previous_command_seq = sequencer.last_command_seq() as i64;
        let mut envelopes: Vec<EventEnvelope> = Vec::new();
        for (seq, payload) in &commands {
            envelopes.extend(sequencer.apply_json(*seq as u64, payload)?);
        }

        let tx = client.transaction().await?;
        let insert = tx
            .prepare(
                "INSERT INTO engine_events (market_id, seq, command_seq, type, payload)
                 VALUES ($1::text::uuid, $2, $3, $4, $5::text::jsonb)",
            )
            .await?;
        for env in &envelopes {
            let value = serde_json::to_value(&env.event)?;
            let kind = value
                .get("type")
                .and_then(|t| t.as_str())
                .unwrap_or("unknown")
                .to_owned();
            let payload = value.to_string();
            tx.execute(
                &insert,
                &[
                    &market,
                    &(env.seq as i64),
                    &(env.command_seq as i64),
                    &kind,
                    &payload,
                ],
            )
            .await?;
        }
        let updated = tx
            .execute(
                "INSERT INTO engine_market_state (market_id, last_command_seq, last_event_seq, state_hash, updated_at)
                 VALUES ($1::text::uuid, $2, $3, $4, now())
                 ON CONFLICT (market_id) DO UPDATE
                   SET last_command_seq = EXCLUDED.last_command_seq,
                       last_event_seq = EXCLUDED.last_event_seq,
                       state_hash = EXCLUDED.state_hash,
                       updated_at = now()
                 WHERE engine_market_state.last_command_seq = $5",
                &[
                    &market,
                    &(sequencer.last_command_seq() as i64),
                    &(sequencer.last_event_seq() as i64),
                    &sequencer.state_hash(),
                    &previous_command_seq,
                ],
            )
            .await?;
        if updated != 1 {
            return Err(format!(
                "offset for market {market} changed concurrently; refusing to continue"
            )
            .into());
        }
        tx.execute("SELECT pg_notify('engine_events', $1)", &[&market])
            .await?;
        tx.commit().await?;
    }
    Ok(rows.len())
}
