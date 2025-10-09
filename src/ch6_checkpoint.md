# Chapter 6: Checkpointing and Log Compaction

By now, you’ve built a database that can **survive crashes** using a Write-Ahead Log and **recover** correctly.
But if you let your system run long enough, your WAL file will just keep growing - indefinitely.

Every transaction, every update, every byte of history lives on in that log, even after it’s no longer needed.
Soon, you’ll have gigabytes of old, irrelevant log records sitting on disk.

That’s where **checkpointing** and **log compaction** come in.

---

## Step 1: The Problem - Infinite Logs

Imagine your WAL has been running for hours:

```
LSN 100: BEGIN_TXN 1
LSN 110: UPDATE page 3
LSN 120: COMMIT_TXN 1
...
LSN 10,000,000: UPDATE page 8
```

The system is fine, but recovery is getting slower - because every crash means replaying millions of records.
Even though most of those updates have long been persisted to disk, we’re still keeping them “just in case.”

We need a way to:

1. Persist a consistent snapshot of the system state.
2. Discard old WAL entries that are no longer required for recovery.

That’s exactly what a **checkpoint** does.

---

## Step 2: What Is a Checkpoint?

A **checkpoint** is a point in time where we guarantee:

> “All updates up to this LSN are reflected on disk.”

When a checkpoint is taken, we flush all dirty pages to disk, record which transactions are still active, and write a *checkpoint record* to the WAL.

Later, if a crash happens, recovery can skip all log records before the last checkpoint - because we know the data files already contain those effects.

---

## Step 3: Checkpoint Contents

A checkpoint record usually includes:

* **Last LSN flushed to disk**
* **List of active transactions**
* **Dirty page table** (pages modified but not yet flushed)

In our minimal WAL, we’ll store a simple JSON structure like:

```json
{
  "type": "CHECKPOINT",
  "active_txns": [3, 4],
  "dirty_pages": [7, 9],
  "last_lsn": 900
}
```

This record marks a safe recovery starting point.
When recovery begins, it finds the last checkpoint and starts replaying from there instead of from LSN 0.

---

## Step 4: How to Take a Checkpoint

To take a checkpoint safely:

1. **Pause new writes** (briefly or via a lightweight lock).
2. **Flush all dirty pages** to disk.
3. **Record current active transactions and their last LSNs.**
4. **Append a checkpoint record** to the WAL.
5. **Flush the WAL** to ensure durability.
6. **Resume normal operations.**

Here’s the pseudocode:

```text
take_checkpoint():
    lock system
    flush all dirty pages
    record active_txns and last_lsn
    append CHECKPOINT record to WAL
    fsync WAL
    unlock system
```

---

## Step 5: Log Compaction (Truncation)

Once we’ve written a checkpoint and ensured all earlier updates are persisted,
**older WAL entries become redundant**. We can safely delete or truncate them.

We call this **log compaction** or **log truncation**.

* The log can be truncated up to the last checkpoint’s LSN.
* Recovery will never need those earlier records again.

This keeps our log file size bounded and ensures faster recovery.

---

## Step 6: Example Timeline

Let’s visualize how checkpointing fits into the life of a running database:

```
Time → →
| Txn A Updates | Txn A Commits | Txn B Starts | Checkpoint | Txn B Updates | Crash |
|----------------|---------------|---------------|-------------|---------------|-------|

During recovery:
  - Start from last checkpoint
  - Redo only log records after checkpoint
  - Undo incomplete Txn B if necessary
```

If we didn’t have checkpoints, recovery would have to scan the entire log from the beginning - much slower.

---

## Step 7: Checkpointing in Code (Rust Example)

Here’s a simple demonstration of checkpoint creation and log truncation logic,
extending the recovery manager from the previous chapter.

```rust
use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};

type Lsn = u64;
type TxnId = u64;
type PageId = u64;

#[derive(Clone, Debug)]
struct CheckpointRecord {
    last_lsn: Lsn,
    active_txns: HashSet<TxnId>,
    dirty_pages: HashSet<PageId>,
}

impl CheckpointRecord {
    fn serialize(&self) -> String {
        format!(
            "{{\"type\":\"CHECKPOINT\",\"last_lsn\":{},\"active_txns\":{:?},\"dirty_pages\":{:?}}}",
            self.last_lsn, self.active_txns, self.dirty_pages
        )
    }
}

/// A minimal WAL manager that supports writing, checkpointing, and truncation.
struct WalManager {
    wal_path: String,
    next_lsn: Lsn,
    active_txns: HashSet<TxnId>,
    dirty_pages: HashSet<PageId>,
}

impl WalManager {
    fn new(wal_path: &str) -> Self {
        Self {
            wal_path: wal_path.to_string(),
            next_lsn: 1,
            active_txns: HashSet::new(),
            dirty_pages: HashSet::new(),
        }
    }

    fn append(&mut self, record: &str) {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.wal_path)
            .expect("Failed to open WAL file");

        writeln!(file, "{}", record).expect("Write WAL failed");
        file.flush().unwrap();
        self.next_lsn += 1;
    }

    fn take_checkpoint(&mut self) -> CheckpointRecord {
        // Simulate flushing all dirty pages
        println!("Flushing {} dirty pages to disk...", self.dirty_pages.len());

        // Create checkpoint record
        let chk = CheckpointRecord {
            last_lsn: self.next_lsn,
            active_txns: self.active_txns.clone(),
            dirty_pages: self.dirty_pages.clone(),
        };

        // Write checkpoint to WAL
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.wal_path)
            .unwrap();

        writeln!(file, "{}", chk.serialize()).unwrap();
        file.flush().unwrap();

        println!("Checkpoint created at LSN {}", chk.last_lsn);
        chk
    }

    fn truncate_log(&mut self, checkpoint: &CheckpointRecord) {
        // For simplicity, we just rewrite WAL file starting from checkpoint.
        // In real DBs, you'd keep the tail after checkpoint and delete older data.
        println!("Truncating WAL up to LSN {}", checkpoint.last_lsn);

        let mut file = File::create(&self.wal_path).unwrap();
        writeln!(file, "{}", checkpoint.serialize()).unwrap();
        file.flush().unwrap();
    }
}

fn main() {
    let mut wal = WalManager::new("wal.log");
    wal.active_txns.insert(1);
    wal.dirty_pages.insert(3);
    wal.dirty_pages.insert(5);

    wal.append("{\"type\":\"BEGIN_TXN\",\"txn\":1}");
    wal.append("{\"type\":\"UPDATE\",\"txn\":1,\"page\":3}");
    wal.append("{\"type\":\"COMMIT_TXN\",\"txn\":1}");

    let chk = wal.take_checkpoint();
    wal.truncate_log(&chk);
}
```

### What’s happening:

* We log a few records.
* We flush dirty pages and write a checkpoint record.
* We truncate the WAL, keeping only the checkpoint forward.

This simple mechanism ensures your WAL file stays compact and recovery starts quickly.

---

## Step 8: Checkpoint Frequency

How often should you checkpoint?
It’s a trade-off:

| Frequency                      | Pros            | Cons                    |
| ------------------------------ | --------------- | ----------------------- |
| Frequent (every few seconds)   | Faster recovery | Higher runtime overhead |
| Infrequent (every few minutes) | Lower overhead  | Longer recovery time    |

Many databases use a hybrid strategy - **periodic checkpoints** plus **event-based checkpoints** when the log grows beyond a certain threshold.

---

## Step 9: Putting It All Together

At this point, your database engine now supports:

* **Write-Ahead Logging** - ensuring durability.
* **Crash Recovery** - guaranteeing atomicity.
* **Checkpointing and Compaction** - keeping the system lean and fast.

These three pillars form the foundation of any reliable storage engine.

---

## Step 10: Next Steps

Now that we’ve built durability and recovery, we can explore:

* **Concurrency Control** - locks, latches, and isolation.
* **Buffer Management** - page replacement and pinning.
* **Replication** - applying WAL across nodes for fault tolerance.

But even at this stage, you’ve implemented something profound - a **recoverable transactional storage system**, built from first principles.