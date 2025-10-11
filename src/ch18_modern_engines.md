# Chapter 18: Modern Storage Engines

> “Every generation of databases reinvents the log - but smarter.”

In the early days of databases, storage engines were simple.
You had a few data files, a write-ahead log, and a recovery routine.
Today, storage engines are the *nervous system* of distributed data infrastructure - balancing durability, speed, and scalability across disks, memory, and the cloud.

This chapter explores **how modern storage engines use and extend WAL concepts**, how new designs like **LSM trees**, **columnar formats**, and **cloud-native architectures** evolved from the same core principle:

> *Log first, organize later.*

---

## **1. From Pages to Streams**

Traditional databases like PostgreSQL and MySQL use **page-based storage**.
Each data page (e.g., 8 KB) is updated directly on disk, and the WAL records every modification.

This works well for transactional workloads, but struggles when:

* Writes are random and frequent.
* Datasets exceed memory size.
* You need high ingest rates (e.g., analytics or time-series).

So modern systems flipped the model:

> Instead of updating in place, **append changes** and **merge later**.

This philosophy led to **Log-Structured Storage Engines** - the foundation for RocksDB, LevelDB, Cassandra, and even some cloud systems.

---

## **2. Log-Structured Merge Trees (LSM Trees)**

### The Core Idea

Instead of updating disk pages directly, write everything sequentially to a **log** and a **memtable** (in-memory index).
When the memtable fills, flush it to disk as an **SSTable** (Sorted String Table).

Over time, multiple SSTables accumulate and are **compacted** into fewer, larger ones.

This keeps writes **sequential** (fast) and uses background threads to manage organization (compaction).

### WAL’s Role in LSM Engines

Even LSM engines still need WAL:

* Every write is appended to a WAL file for durability.
* If the process crashes, the WAL is replayed into the memtable.

So the flow looks like:

```
[Write Request]
      ↓
[Append to WAL]  ---> [Durability]
      ↓
[Insert into MemTable]  ---> [In-memory performance]
      ↓
[Flush to SSTable] ---> [Persistence + Compaction]
```

The LSM approach **maximizes write throughput** and **minimizes random I/O** - making it ideal for workloads like logs, analytics, or key-value stores.

### Real-World Examples

* **LevelDB** – Simple key-value store from Google using LSM + WAL.
* **RocksDB** – Facebook’s evolution of LevelDB, optimized for SSDs, with parallel WAL writes.
* **Cassandra** – Distributed LSM engine where each node maintains a commit log (WAL) and memtable.

---

## **3. Columnar Storage and WAL**

Columnar databases (like **ClickHouse**, **Parquet**, or **DuckDB**) store data by **columns** instead of rows.

That design is fantastic for analytics - but what about durability?

Columnar systems also rely on WAL, but in a slightly different way:

* Instead of logging every cell change, they **batch record changes** to entire column segments.
* The WAL acts as a *staging area* for compressed columnar blocks.
* Once a block is finalized and flushed to disk, the WAL entries can be discarded.

### Visualization

```
[Query Insert]
   ↓
[Write to Columnar WAL]
   ↓
[Compress Columns + Encode]
   ↓
[Write Final Column Files (.parquet/.orc)]
```

Columnar WALs emphasize **batch durability** - balancing the need for crash safety with high analytical throughput.

---

## **4. Hybrid Engines: Mixing Row and Columnar with WAL**

Modern workloads often need both:

* Fast transactional updates (row-oriented)
* Fast analytics (column-oriented)

Hybrid engines like **MariaDB ColumnStore**, **SingleStore**, and **DuckDB** bridge this gap.

They maintain:

* A **row-based WAL** for real-time inserts and updates.
* Periodic **columnar compaction** that merges WAL data into analytical blocks.

This approach combines **low-latency writes** with **OLAP performance** - both powered by WAL as the unifying persistence layer.

---

## **5. Cloud-Native WAL and Shared Storage**

In cloud systems, local disks are no longer the only persistence layer.
Storage engines are now built to work with **object storage (S3, GCS, Azure Blob)** and **distributed WALs**.

### Example: Aurora’s Log-First Design

Amazon Aurora flipped traditional architecture on its head:

* Instead of storing data pages directly on disk, each database node sends WAL records to a **distributed log service**.
* The log service persists and replicates the WAL across storage nodes.
* Data pages are *reconstructed* on demand from these logs.

This effectively turns WAL into a **control plane for data durability**.

### Benefits

* Near-instant crash recovery (since logs are distributed).
* Storage layer is stateless and shared.
* Read replicas can rebuild data independently from WAL streams.

The same philosophy powers **CockroachDB**, **TiDB**, and **FoundationDB** - all of which rely on some form of **log shipping** as the backbone of durability and replication.

---

## **6. WAL in Embedded Systems**

Even tiny databases embedded in devices use WAL - though optimized for constraints.

### Example: LMDB

* Uses **memory-mapped I/O** instead of writing log segments manually.
* The “log” is implicit in the **copy-on-write B+Tree** structure.
* Commits atomically swap root pointers, ensuring durability without explicit log replay.

### Example: SQLite (WAL Mode)

* Uses a rolling WAL file to stage changes.
* On checkpoint, merges WAL content into the main database.
* Provides atomicity even on mobile or IoT devices.

In embedded systems, the focus is on **simplicity, crash safety, and minimal overhead**, not high throughput.

---

## **7. Advanced WAL Techniques in Modern Engines**

| Technique                  | Description                                                | Used In                     |
| -------------------------- | ---------------------------------------------------------- | --------------------------- |
| **Tiered WAL Storage**     | Hot log segments on SSD, cold on HDD or S3                 | RocksDB, CockroachDB        |
| **Vectorized WAL Records** | Log multiple column changes as vectorized batches          | ClickHouse, DuckDB          |
| **Delta WAL**              | Only log changed values, not full pages                    | InnoDB, WiredTiger          |
| **Logical WAL**            | Store changes as logical events (SQL-like) for replication | PostgreSQL Logical Decoding |
| **Network-Replicated WAL** | Stream WAL directly over network for fault tolerance       | Aurora, TiDB                |

Each technique reflects a design trade-off between **write latency**, **replay speed**, and **data granularity**.

---

## **8. Visualization: Evolution of WAL Architecture**

```
Traditional Engine (PostgreSQL, MySQL)
--------------------------------------
   [WAL] → [Data Pages] → [Disk]

Log-Structured Engine (RocksDB, Cassandra)
------------------------------------------
   [WAL] → [MemTable] → [SSTables] → [Compaction]

Cloud-Native Engine (Aurora, CockroachDB)
-----------------------------------------
   [WAL Stream] → [Distributed Log Service] → [Object Storage]
```

Each evolution pushes the boundary of performance, durability, and scalability -
but the **WAL remains the beating heart** of all of them.

---

## **9. Debugging and Observing Modern WALs**

As WALs become distributed and layered, debugging tools have evolved too:

* **Aurora Log Inspector** shows per-node WAL latency.
* **RocksDB’s db_bench + perf** visualize compaction and WAL I/O patterns.
* **ClickHouse system tables** expose WAL flush timings and segment sizes.
* **FoundationDB trace logs** reveal commit log latencies across the cluster.

The trend is clear - **WAL visibility** is now a first-class citizen in modern observability stacks.

---

## **10. The Future of WAL: Beyond Disks**

Emerging technologies are changing what “durability” means:

* **Persistent Memory (PMEM)** allows direct, byte-addressable writes.
* **Battery-backed NVRAM** eliminates fsync latency.
* **Transactional file systems** integrate WAL-like journaling directly into the OS.

In such systems, WAL may shift from being an *explicit file* to a *memory region* or *replicated stream* - but its purpose remains unchanged:

> *A safe, ordered record of the truth.*

---

## **11. Closing Thoughts**

From the earliest relational engines to today’s distributed cloud systems,
the Write-Ahead Log has evolved - but never disappeared.

It has become:

* A **buffer** for performance,
* A **timeline** for recovery,
* A **replication medium** for scale,
* And a **control plane** for cloud data integrity.

Modern storage engines might differ wildly in form - page stores, LSMs, column stores, or shared logs -
but they all whisper the same story:

> *“Durability begins with a log.”*

And understanding that story is what transforms a developer into a database engineer.

---