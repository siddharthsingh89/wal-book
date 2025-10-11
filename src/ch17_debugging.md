# Chapter 17: Debugging & Visualization

> “It’s not what your system *does*, it’s what you can *see it doing* that makes it reliable.”

Up to now, we’ve learned how to make Write-Ahead Logging (WAL) **fast** and **durable**.
But what happens when something goes wrong - a commit stalls, replication lags, or recovery takes forever?

At that moment, logs and metrics become your only window into the database’s inner life.

This chapter focuses on **how to debug, trace, and visualize** WAL internals.
You’ll learn how to understand the flow of data inside the log, interpret checkpoints and sequence numbers, and even design visualization tools that make the invisible parts of the database *visible and intuitive*.

---

## **1. Why Debugging WAL Matters**

Debugging WAL is different from debugging application code.
You’re not just looking at stack traces - you’re examining **how data moves through time**:

* From memory to disk,
* From one node to another,
* From one checkpoint to the next.

Failures in this pipeline cause:

* **Data loss or corruption** (if WAL isn’t replayed correctly)
* **Replication lag** (if followers can’t keep up)
* **High latency** (if fsyncs block)
* **Long recovery time** (if checkpoints are sparse)

Understanding WAL internals helps you *predict*, *diagnose*, and *prevent* such issues.

---

## **2. The Key Metrics: What to Observe**

Let’s start by listing the key things to monitor and visualize in a WAL system:

| Metric                        | Description                                       | Why It Matters               |
| ----------------------------- | ------------------------------------------------- | ---------------------------- |
| **LSN (Log Sequence Number)** | A monotonically increasing byte offset in the WAL | Tracks progress of writes    |
| **WAL write rate**            | Bytes written per second                          | Indicates I/O throughput     |
| **Flush latency**             | Time taken for fsync                              | Detects slow disks           |
| **Replication lag**           | Difference between primary and replica LSN        | Shows sync delay             |
| **Checkpoint distance**       | WAL bytes since last checkpoint                   | Determines recovery workload |
| **Pending transactions**      | Unflushed or uncommitted transactions             | Useful for debugging stalls  |

Most production databases expose these metrics via logs, system tables, or monitoring APIs.

---

## **3. Reading the WAL: The Human Way**

Let’s make this practical.
Imagine you’re debugging PostgreSQL.

You can actually read the WAL files using:

```bash
pg_waldump /var/lib/postgresql/data/pg_wal/000000010000000A000000C5
```

This command prints each record with its **LSN**, **transaction ID**, **type of operation**, and **affected relation**.

Example output:

```
rmgr: Heap      len (rec/tot): 56/64, tx: 127, lsn: 1/A/C5A40010, desc: INSERT off 5
```

This single line tells you:

* The WAL record is from the **heap** (table storage layer)
* It represents an **INSERT**
* It belongs to transaction **127**
* Its LSN is **1/A/C5A40010**

By reading WAL entries, you can reconstruct what happened just before a crash - like an airplane black box.

---

## **4. Visualizing WAL Internals**

### **a. The Flow of a Transaction**

Let’s visualize how a single transaction moves through WAL stages:

```
[Transaction Start]
       |
       v
[Generate WAL Record] -- (in memory buffer)
       |
       v
[Write to WAL file] -- (sequential write)
       |
       v
[fsync to disk] -- (durability point)
       |
       v
[Apply changes to data pages]
```

Each stage emits measurable signals:

* Time spent in each stage
* Queue depth (number of waiting commits)
* Size of buffered log

A good visualization tool (like a Grafana dashboard or custom timeline UI) can show these flows in real time.

---

### **b. Example Visualization: WAL Throughput**

A simple time-series graph can reveal much:

```
WAL Write Rate (MB/s)
│
│         ┌─────────────┐
│         │             │
│     ┌───┘             └───┐
│ ────┘                       └───────▶ Time
        (checkpoint starts) 
```

You can immediately spot spikes - often caused by checkpoints or bursts of commits.

---

### **c. Example Visualization: Replication Lag**

For replicated databases, plot **Primary LSN – Replica LSN** over time.

```
Replication Lag (bytes)
│
│         ┌─────────┐
│         │         │
│     ┌───┘         └───┐
│ ────┘                   └────▶ Time
       (network slowdown)
```

A steady lag increase signals that replicas aren’t catching up - possibly due to I/O or network issues.

---

## **5. Common Debugging Scenarios**

### **Scenario 1: Slow Commits**

Symptoms:

* `COMMIT` takes longer than expected.

Debug Steps:

1. Check `wal_write_time` vs `wal_sync_time` metrics.
2. If `sync_time` is high → disk I/O issue.
3. Enable `track_io_timing` (PostgreSQL) or use I/O tracing tools.
4. Consider enabling group commit or async fsync.

---

### **Scenario 2: WAL Growing Too Fast**

Symptoms:

* Disk usage increases rapidly.
* Checkpoints are infrequent.

Possible Causes:

* Long-running transactions prevent cleanup.
* Checkpoint interval too large.
* Replication lag keeps old segments from being recycled.

Debugging Tools:

* Monitor `checkpoint_distance`.
* Use commands like `pg_stat_bgwriter` or `SHOW wal_keep_size;`.

---

### **Scenario 3: Replication Lag**

Symptoms:

* Replica constantly behind primary.

Debugging Steps:

1. Compare primary and replica `current_lsn`.
2. Monitor network latency and disk speed on replicas.
3. Enable WAL compression to reduce transfer volume.
4. Visualize lag over time - patterns often reveal root causes.

---

## **6. Building WAL Visualizers**

You don’t need complex enterprise tools to visualize WAL.

Here’s a simple approach you can build:

1. **Collect Metrics**
   Use APIs or log hooks to capture:

   * LSNs
   * Write latency
   * WAL size growth
2. **Store in Time-Series DB**
   e.g., Prometheus or InfluxDB.
3. **Visualize**
   Use Grafana, Plotly, or a custom dashboard.

### Example (Rust + Prometheus):

```rust
use prometheus::{IntGauge, Encoder, TextEncoder};

let wal_write_bytes = IntGauge::new("wal_write_bytes", "Total WAL bytes written").unwrap();

// In WAL write loop
wal_write_bytes.add(batch_size as i64);
```

A small exporter like this can feed live metrics into your visualization tool.

---

## **7. Timeline Visualization (For Recovery & Replay)**

When recovering from crashes or replays, it’s helpful to see a **timeline view** of the WAL:

```
|----------------------|----------------------|----------------------|
Checkpoint 1           Checkpoint 2           Checkpoint 3
      ↑
   crash here
```

The recovery process replays from the last checkpoint to the crash point.
A timeline visualization helps operators know how far replay has progressed - similar to a progress bar during recovery.

Some databases even visualize this internally. For example:

* **PostgreSQL** exposes `pg_stat_recovery_prefetch` metrics.
* **CockroachDB**’s web UI shows per-node WAL replay progress.

---

## **8. Real-World Tools**

| Tool                        | Database     | Purpose                       |
| --------------------------- | ------------ | ----------------------------- |
| `pg_waldump`                | PostgreSQL   | View raw WAL records          |
| `pg_stat_wal`               | PostgreSQL   | Monitor WAL write rates       |
| `SHOW ENGINE INNODB STATUS` | MySQL        | Inspect log buffer and I/O    |
| `db_bench` + perf tools     | RocksDB      | Trace WAL performance         |
| `Grafana + Prometheus`      | Generic      | Visualization                 |
| `strace / iostat / dstat`   | System-level | Observe I/O and fsync latency |

These tools help bridge the gap between *storage layer behavior* and *system observability*.

---

## **9. WAL Debugging Checklist**

When diagnosing WAL issues, use this simple checklist:

 **Is WAL being flushed regularly?**
Check for stalled or large buffers.

 **Are checkpoints configured correctly?**
Too frequent = overhead, too rare = long recovery.

 **Is fsync latency stable?**
Spikes indicate hardware or OS buffering problems.

 **Is replication lag stable?**
If not, network or disk I/O might be limiting performance.

 **Do WAL files recycle properly?**
Old segments piling up can signal retention or recovery issues.

---

## **10. Closing Thoughts**

Debugging WAL is like listening to a heartbeat monitor - it tells you how healthy your database really is.

Visualization transforms low-level log mechanics into clear insights:

* You see *where* time is spent.
* You detect *when* something is off.
* You understand *why* performance changes.

Ultimately, observability completes the story of WAL:

> It starts with **durability**, evolves with **performance**, and matures with **visibility**.

When you can visualize your WAL - from the first byte written to the last byte replayed -
you no longer just operate a database.
You *understand* it.

---