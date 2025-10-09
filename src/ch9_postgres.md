# Chapter 9 : PostgreSQL WAL

### *Inside PostgreSQL’s Write-Ahead Log: Design, Implementation, and Recovery*

---

## 1. Introduction - WAL at the Heart of PostgreSQL

When PostgreSQL promises that a committed transaction will never vanish-even after a crash-it’s the **Write-Ahead Log (WAL)** that makes that promise possible.
Every change in PostgreSQL passes through this append-only log before it ever touches the main data files.

In the PostgreSQL source tree, the WAL subsystem lives primarily under
`src/backend/access/transam/` and headers under `src/include/access/`.
If you ever browse the repo ([github.com/postgres/postgres](https://github.com/postgres/postgres)), files like
`xlog.c`, `xlogrecovery.c`, and `walwriter.c` are the main entry points.

Official documentation:

* [WAL Introduction](https://www.postgresql.org/docs/current/wal-intro.html)
* [WAL Internals](https://www.postgresql.org/docs/current/wal-internals.html)
* [Continuous Archiving and PITR](https://www.postgresql.org/docs/current/continuous-archiving.html)

---

## 2. Architecture Overview

PostgreSQL uses a **multiprocess** model-each client connection runs in its own process. WAL management therefore depends on shared memory and a few cooperating background processes:

| Process                   | Responsibility                                                          |
| ------------------------- | ----------------------------------------------------------------------- |
| **Backend**               | Executes queries and inserts WAL records for each change.               |
| **WAL Writer**            | Periodically flushes WAL buffers to disk, offloading I/O from backends. |
| **Background Writer**     | Writes dirty data pages from shared buffers to data files.              |
| **Checkpointer**          | Creates checkpoints, ensuring pages up to a certain LSN are on disk.    |
| **Archiver / WAL Sender** | Ships WAL segments to replicas or archives.                             |

The high-level flow looks like this:

```
Client SQL  → Backend modifies buffers
             → XLogInsert() creates WAL record
             → WAL buffer appended
             → WAL Writer flushes to segment file
             → Checkpoint ensures data pages persist
```

All WAL-related files live under `pg_wal/` in the data directory. Each file (a *segment*) is 16 MB by default and named like `00000001000000000000000A`.

---

## 3. WAL Record Structure & LSNs

Every operation that changes data generates one or more **WAL records**.
The core structure, defined in `xlogrecord.h`, contains:

```c
typedef struct XLogRecord {
    uint32  xl_tot_len;   /* total record length */
    TransactionId xl_xid; /* transaction id */
    XLogRecPtr xl_prev;   /* pointer to previous record */
    uint8   xl_info;      /* record type flags */
    RmgrId  xl_rmid;      /* resource manager id */
    /* followed by record-specific data */
} XLogRecord;
```

PostgreSQL assigns each byte in the WAL a **Log Sequence Number (LSN)** - a 64-bit pointer displayed as two hex parts (`0/16B3C1F0`).
Every data page stores the LSN of its last update in its header.
During recovery, WAL records are applied only if their LSN > page LSN, guaranteeing idempotent replay.

LSNs are returned by SQL functions like:

```sql
SELECT pg_current_wal_lsn();
SELECT pg_last_wal_replay_lsn();
```

---

## 4. Inserting and Flushing WAL

When a backend modifies a page, it calls `XLogInsert()` to write a WAL record into a circular buffer in shared memory (the *WAL buffers*).
Space reservation and LSN assignment are protected by lightweight locks to serialize writers.

Simplified flow (adapted from `xlog.c`):

```c
/* Pseudocode illustration */
XLogRecPtr XLogInsert(rmid, info, data)
{
    acquire(WALInsertLock);
    LSN start = InsertPos;
    InsertPos += sizeof(XLogRecord) + data_length;
    release(WALInsertLock);

    fill_record_header(...);
    copy_payload_into_wal_buffer(...);
    return start;
}
```

Backends don’t usually write WAL to disk themselves.
Instead, they signal that their commit’s LSN must be flushed, and either the **WAL Writer** or one backend performing a commit will call `XLogFlush()`:

```c
void XLogFlush(LSN target)
{
    if (WalWriterFlushPos >= target)
        return;
    acquire(WALFlushLock);
    write_wal_buffers_to_disk(up_to=target);
    fsync(wal_segment_file);
    WalWriterFlushPos = target;
    release(WALFlushLock);
}
```

This batching amortizes costly `fsync()` calls and allows many commits to share the same disk flush.

---

## 5. Checkpointing and Background Processes

A **checkpoint** marks a moment when all changes up to a given LSN are safely on disk.
During a checkpoint, PostgreSQL:

1. Requests the WAL Writer to flush WAL up to the checkpoint LSN.
2. Forces all dirty buffers whose page LSN ≤ that LSN to disk.
3. Writes a *checkpoint record* into WAL describing the redo start point.
4. Updates `pg_control` with the new checkpoint pointer.

Simplified flow (modeled after `checkpointer.c`):

```c
CheckPoint()
{
    LSN redo = ComputeRedoStart();
    RequestXLogFlush(redo);
    FlushDirtyBuffers(redo);
    XLogInsert(RM_XLOG_ID, XLOG_CHECKPOINT_ONLINE, ...);
    XLogFlush(...);
    UpdateControlFile(redo);
}
```

Checkpoints keep recovery time bounded but introduce heavy I/O bursts, so PostgreSQL spreads them over time using `checkpoint_completion_target`.

Old segments before the checkpoint are either archived (via `archive_command`) or recycled for reuse, depending on configuration.

---

## 6. Recovery and Replay

On startup, PostgreSQL inspects `pg_control` to find the last checkpoint.
If the previous shutdown wasn’t clean, it enters **crash recovery** mode.

Recovery algorithm (simplified from `xlogrecovery.c`):

1. Read the checkpoint record; get its *redo LSN*.
2. From that point, sequentially read WAL records.
3. For each record:

   * Identify the resource manager (`rmgr`) responsible.
   * If the target page’s LSN < record LSN, apply the redo function.
   * Update the page’s LSN.
4. Stop at the end of WAL or at a requested PITR target.

Each record type has a dedicated redo callback (see `src/backend/access/rmgr/` for modules like `heapam`, `btree`, `gin`, etc.) implementing `rm_redo()`.

During replay, PostgreSQL can branch timelines: when a standby is promoted, it starts a new timeline file (`00000002.history`) recording ancestry-vital for point-in-time recovery and replication consistency.

---

## 7. Concurrency and Design Trade-offs

PostgreSQL’s WAL design balances *simplicity* with *safety*:

* **Append-only design** makes inserts fast and serializable with simple locks.
* **WAL Writer batching** reduces fsync overhead.
* **Full-page writes** (entire page images logged when first modified after a checkpoint) prevent torn-page corruption.
* **Checkpoints** trade off runtime I/O vs. recovery duration.
* **Multiprocess architecture** avoids complex thread safety issues but relies heavily on shared memory coordination.

### Observed trade-offs

| Goal                | Challenge                  | Mitigation                     |
| ------------------- | -------------------------- | ------------------------------ |
| Low latency commits | fsync cost                 | Group commits via WAL Writer   |
| Quick recovery      | Frequent checkpoints       | Spread checkpoint I/O          |
| Small WAL size      | full_page_writes expansion | Optional compression / tuning  |
| Replication lag     | WAL shipping delay         | Asynchronous streaming / slots |

---

## 8. Configuration, Tuning & Monitoring

PostgreSQL exposes many WAL-related parameters in `postgresql.conf` ([docs](https://www.postgresql.org/docs/current/runtime-config-wal.html)):

| Setting                            | Description                                           |
| ---------------------------------- | ----------------------------------------------------- |
| `wal_level`                        | Controls WAL detail: `minimal`, `replica`, `logical`. |
| `synchronous_commit`               | Determines when commit waits for WAL flush.           |
| `checkpoint_timeout`               | Maximum time between checkpoints.                     |
| `checkpoint_completion_target`     | Fraction of interval used to spread writes.           |
| `max_wal_size` / `min_wal_size`    | Controls recycling/archiving thresholds.              |
| `archive_mode` / `archive_command` | Enables continuous archiving.                         |

Monitoring views:

```sql
SELECT * FROM pg_stat_bgwriter;
SELECT * FROM pg_stat_wal;
```

---

## 9. Summary & Takeaways

PostgreSQL’s WAL system embodies the purest form of write-ahead logging found in any production database:

* **Strict ordering:** Every modification is logged before it reaches disk.
* **Cooperative background processes:** WAL Writer, Checkpointer, and Archiver work in concert.
* **LSN-based recovery:** Pages and WAL are stitched together by LSNs for deterministic replay.
* **Unified mechanism:** The same WAL supports crash recovery, replication, and point-in-time restoration.

For readers exploring the codebase:

* `src/backend/access/transam/xlog.c` – core WAL insert & flush logic
* `walwriter.c` – background writer loop
* `xlogrecovery.c` – recovery and redo routines
* `rmgr.c` + `src/backend/access/rmgr/` – resource-manager redo handlers

---

## 10. Reflection and Comparison Template

This section acts as a **bridge** for upcoming chapters (SQLite, InnoDB, RocksDB, LMDB).
You can reuse the same structure to compare how each system:

1. Defines log records and sequence numbers
2. Handles concurrency and flushing
3. Implements checkpoints or compaction
4. Replays logs during recovery
5. Balances performance vs. durability

For PostgreSQL, the guiding philosophy is clarity over cleverness-every change flows through a linear, append-only stream, and every byte written can be traced by its LSN.

---

**Further Reading**

* [PostgreSQL WAL Internals (official)](https://www.postgresql.org/docs/current/wal-internals.html)
* [PostgreSQL Source: `xlog.c`](https://github.com/postgres/postgres/blob/master/src/backend/access/transam/xlog.c)
* [A Deep Dive into PostgreSQL’s Write-Ahead Logging - Brandur Leach](https://brandur.org/postgres-wal)
* [Understanding Checkpoints in PostgreSQL](https://www.postgresql.org/docs/current/checkpoints.html)