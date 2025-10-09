# Chapter 12: RocksDB WAL and Recovery

---

## **1. Introduction**

RocksDB is a **high-performance, embedded key–value store** developed by Facebook (now Meta), built on top of Google’s LevelDB.
It’s optimized for **SSD storage, write-intensive workloads, and low-latency access**.

At its core, RocksDB uses a **Log-Structured Merge Tree (LSM)** architecture - a write-optimized design where:

* Writes are appended sequentially (fast!),
* Reads use in-memory indexes and Bloom filters,
* And background **compaction** merges data to maintain order.

Durability in RocksDB is achieved through a **Write-Ahead Log (WAL)**, just like in traditional databases - but adapted to an LSM world.

> Reference: [RocksDB WAL Docs](https://github.com/facebook/rocksdb/wiki/Write-Ahead-Log)

---

## **2. The Core Idea**

All writes in RocksDB go through two components:

```
Client Write → WAL (log file) → MemTable → SSTables (via Compaction)
```

* The **WAL** ensures durability.
* The **MemTable** (an in-memory skiplist) provides fast access to recent data.
* When the MemTable fills up, it’s flushed to disk as an **SSTable** (Sorted String Table).

This two-tier approach provides **fast writes + crash recovery**.

---

## **3. The Write Path**

Here’s the step-by-step lifecycle of a write in RocksDB:

```
1. Client issues PUT("key", "value")
2. RocksDB appends the record to the WAL file
3. Write is acknowledged after fsync (durability)
4. The record is inserted into the MemTable
5. Once MemTable is full → flush to disk (SST)
6. Later: Compaction merges SSTs for optimization
```

### Visual Flow

```
┌─────────────┐
│ Application │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ WAL (Log)   │  ← Durable
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ MemTable    │  ← In-memory, fast
└──────┬──────┘
       │ (flush)
       ▼
┌─────────────┐
│ SSTables    │  ← On-disk sorted runs
└─────────────┘
```

---

## **4. WAL File Format and Management**

Every RocksDB WAL file contains a sequence of **records**, each representing a batch of writes (WriteBatch).
Each record has:

| Field  | Description                             |
| ------ | --------------------------------------- |
| CRC32C | Checksum                                |
| Size   | Record length                           |
| Type   | Record type (full, first, middle, last) |
| Data   | The serialized write batch              |

**Files:**

```
00001.log
00002.log
...
MANIFEST-000003
```

Each WAL file corresponds to a specific **log number**, and RocksDB maintains metadata about active and obsolete logs.

---

## **5. C++ Example: Writing to WAL**

RocksDB’s public API automatically handles WAL writes internally.
However, here’s a minimal example:

```cpp
#include "rocksdb/db.h"
#include "rocksdb/options.h"

using namespace rocksdb;

int main() {
    DB* db;
    Options options;
    options.create_if_missing = true;

    Status s = DB::Open(options, "/tmp/rocksdb_wal_demo", &db);
    assert(s.ok());

    WriteOptions writeOptions;
    writeOptions.sync = true; // ensures WAL fsync
    db->Put(writeOptions, "user:1", "Alice");

    delete db;
}
```

Here:

* `writeOptions.sync = true` forces a flush to the WAL before acknowledging the write.
* If RocksDB crashes, it replays the WAL to reconstruct the MemTable.

---

## **6. Recovery Process**

During startup:

1. RocksDB scans the last checkpoint and log sequence numbers.
2. Finds any unflushed WAL files.
3. Replays WAL entries to reconstruct in-memory MemTables.
4. Resumes normal operation.

Simplified from [db_impl/db_impl_open.cc](https://github.com/facebook/rocksdb/blob/main/db/db_impl_open.cc):

```cpp
Status DBImpl::RecoverLogFiles() {
    for (auto log : logs_to_recover) {
        SequentialFileReader reader(log.file);
        while (ReadRecord(&reader, &record)) {
            WriteBatch batch(record);
            WriteBatchInternal::InsertInto(&batch, memtable);
        }
    }
}
```

This ensures that all committed writes are replayed into the MemTable, exactly like **PostgreSQL’s replay of WAL segments** or **InnoDB’s redo recovery**.

---

## **7. Flushing and Checkpointing**

RocksDB performs **flushing** and **checkpoints** differently:

* **Flushing**: Converts MemTable → SSTable.
* **Checkpointing**: Writes a consistent snapshot of the entire DB (via `Checkpoint::CreateCheckpoint()`).

WAL files are deleted only after their corresponding MemTables are flushed and persisted.

```cpp
Status DB::Flush(const FlushOptions& options);
```

The process:

```
WAL File → MemTable → Flush → SSTable → Remove old WAL
```

---

## **8. Compaction and Log Compaction**

RocksDB’s **compaction** process is a background merge of SST files to maintain sorted order and reclaim space.
It’s conceptually related to “log compaction” in Kafka - rewriting data to keep only the latest versions.

### **Levels in RocksDB:**

```
L0: Recent SSTs (from MemTables)
L1: Older, larger files
L2..Ln: Compact, sorted data
```

During compaction:

* Redundant key versions are dropped.
* Deleted keys are purged.
* Older SSTs are merged into newer ones.

This keeps query performance fast and storage usage efficient.

---

## **9. Performance Considerations**

| Configuration             | Description                           |
| ------------------------- | ------------------------------------- |
| `write_buffer_size`       | Controls MemTable size                |
| `max_write_buffer_number` | Number of MemTables before flush      |
| `WAL_ttl_seconds`         | How long to keep WALs before deletion |
| `WAL_size_limit_MB`       | Max total WAL size before force flush |
| `max_background_flushes`  | Number of flush threads               |

**Write latency** in RocksDB is typically determined by:

* WAL fsync cost
* MemTable lock contention
* Background flush pressure

For most workloads, RocksDB achieves **<1ms durability latency** with async I/O and group commits.

---

## **10. Group Commit and Batching**

RocksDB batches multiple concurrent writes into a **single WAL record**, improving throughput:

```cpp
Status DBImpl::WriteImpl(WriteOptions options, WriteBatch* updates) {
    Writer w(updates);
    writers_.push_back(&w);
    if (writers_.size() > 1) {
        // Wait for the leader writer
        w.wait();
    } else {
        // Leader writes all batches to WAL
        WriteBatch merged = MergePendingWrites();
        wal->Append(merged);
        fsync_if_needed();
        notify_followers();
    }
}
```

This is similar to **InnoDB’s group commit mechanism**.

---

## **11. WAL Recycling and TTL**

To avoid creating too many log files, RocksDB recycles WAL files:

```cpp
options.recycle_log_file_num = 2;
```

When enabled, old WALs are truncated and reused, reducing filesystem overhead - a critical optimization for SSD endurance and cloud workloads.

---

## **12. Example: Manual WAL Replay**

RocksDB provides a lower-level API to read WALs manually for diagnostics or replication:

```cpp
#include "rocksdb/transaction_log.h"

DB* db;
DB::Open(Options(), "/tmp/rocksdb_demo", &db);

SequenceNumber start_seq = 0;
std::unique_ptr<TransactionLogIterator> it;
db->GetUpdatesSince(start_seq, &it);

while (it->Valid()) {
    BatchResult batch = it->GetBatch();
    std::cout << "Sequence: " << batch.sequence << std::endl;
    it->Next();
}
```

This feature is used by **RocksDB Replication**, **MyRocks**, and **distributed storage systems** to stream changes downstream - similar to PostgreSQL’s `WALReceiver`.

---

## **13. Recovery Example Timeline**

```
Before crash:
  WAL: 00023.log
  MemTable: unflushed writes

After crash:
  On startup:
    → Detects 00023.log
    → Reads each WriteBatch
    → Reconstructs MemTable
    → Continues operation
```

This recovery process is extremely fast - often milliseconds - since logs are sequential.

---

## **14. Comparison with Other Systems**

| Feature              | RocksDB                    | InnoDB               | PostgreSQL      |
| -------------------- | -------------------------- | -------------------- | --------------- |
| Storage model        | LSM Tree                   | B+ Tree              | Heap + B+ Index |
| WAL type             | Append-only key-value logs | Page-level redo logs | Segment WAL     |
| Checkpoint           | Flush MemTable             | Flush dirty pages    | Checkpoint LSN  |
| Undo/Redo separation | None (idempotent updates)  | Both                 | Single WAL      |
| Compaction           | Background merge           | Buffer flushing      | None            |
| Concurrency          | Multi-threaded             | Multi-threaded       | Multi-process   |
| Designed for         | Embedded / SSD / Key-value | OLTP relational      | OLTP relational |

---

## **15. Design Insights**

* **Log-structured design** turns random writes into sequential appends - perfect for SSDs.
* **Compaction replaces checkpointing and vacuuming**, simplifying recovery logic.
* **Crash safety** is simple - replay WALs, rebuild MemTables.
* **No undo logs** needed - LSM updates are idempotent.

RocksDB’s design favors **high throughput and low write amplification** at the cost of higher background I/O (compaction).

---

## **16. References**

* [RocksDB Wiki – Write-Ahead Log](https://github.com/facebook/rocksdb/wiki/Write-Ahead-Log)
* [RocksDB Source Code – db_impl/db_impl_open.cc](https://github.com/facebook/rocksdb/blob/main/db/db_impl_open.cc)
* [RocksDB Compaction Overview](https://github.com/facebook/rocksdb/wiki/Compaction)
* [LevelDB Log Format](https://github.com/google/leveldb/blob/main/db/log_format.h)
* [MyRocks Design Docs](https://github.com/facebook/mysql-5.6/wiki/MyRocks-Introduction)

---

## **17. Summary**

RocksDB’s WAL is simple yet powerful - an **append-only, sequential log** that guarantees durability and fast recovery.
It fits naturally into the LSM design philosophy:
**write fast, merge later**.

By combining WAL + MemTable + Compaction, RocksDB achieves:

* High throughput,
* Fast crash recovery,
* Tunable durability,
* And SSD-optimized performance.

RocksDB’s design demonstrates how **WAL principles evolve** from page-based systems to log-structured, distributed storage - a natural evolution of durability mechanisms for modern data systems.