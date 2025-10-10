# Chapter 13: LMDB & Embedded Systems

## 13.1 Introduction

LMDB (Lightning Memory-Mapped Database) is a high-performance, ultra-lightweight key-value store designed for reliability and speed. It is particularly well-suited for **embedded systems**, where resource constraints and real-time performance requirements demand efficient storage engines.

In this chapter, we will explore:

* The design principles of LMDB.
* Why LMDB is ideal for embedded environments.
* Memory-mapped storage and zero-copy access.
* Transactional guarantees (ACID compliance).
* Practical examples of using LMDB in embedded applications.
* Performance tuning for constrained hardware.

---

## 13.2 LMDB Fundamentals

### 13.2.1 Key Features

1. **Memory-Mapped Storage**: LMDB maps the database file into the process’s address space. Reads are zero-copy and extremely fast.
2. **ACID Transactions**: LMDB supports fully serializable transactions without locks for readers.
3. **Single-Level B+Tree**: Uses a copy-on-write B+Tree, making writes safe and enabling consistent snapshots.
4. **No Fragmentation**: LMDB avoids internal fragmentation through page-based allocation and reuse.
5. **Read-Optimized**: Multiple readers can access the database simultaneously without blocking.

### 13.2.2 Database Structure

* LMDB uses **fixed-size pages**, typically 4 KB.
* Keys and values are stored in **B+Tree nodes**.
* **Copy-on-write** ensures that updates do not overwrite active readers.

---

## 13.3 Why LMDB is Ideal for Embedded Systems

Embedded systems often have limited CPU, memory, and storage. LMDB fits this scenario perfectly because:

1. **Minimal Dependencies**: LMDB is a single C library with no external dependencies.
2. **Small Footprint**: It uses a fixed-size memory map and minimal heap allocations.
3. **High Throughput**: Zero-copy reads and sequential writes leverage the OS page cache.
4. **Crash Safety**: Copy-on-write ensures database consistency even on power failure.
5. **Predictable Latency**: Since reads never block, performance is deterministic.

**Example use cases in embedded systems:**

* IoT devices storing sensor logs.
* Routers or network appliances storing configuration and routing tables.
* Mobile apps needing reliable local storage.

---

## 13.4 LMDB Transactions in Embedded Systems

### 13.4.1 Read-Only Transactions

Read transactions are **lock-free** and lightweight:

```c
MDB_txn *txn;
mdb_txn_begin(env, NULL, MDB_RDONLY, &txn);
MDB_cursor *cursor;
mdb_cursor_open(txn, dbi, &cursor);

MDB_val key, data;
while (mdb_cursor_get(cursor, &key, &data, MDB_NEXT) == 0) {
    printf("Key: %s, Value: %s\n", (char *)key.mv_data, (char *)data.mv_data);
}

mdb_cursor_close(cursor);
mdb_txn_abort(txn); // read-only transactions can be aborted
```

### 13.4.2 Read-Write Transactions

Write transactions use **copy-on-write**, ensuring no active reader is blocked:

```c
MDB_txn *txn;
mdb_txn_begin(env, NULL, 0, &txn);

MDB_val key, data;
key.mv_size = strlen("device_id");
key.mv_data = "device_id";
data.mv_size = strlen("12345");
data.mv_data = "12345";

mdb_put(txn, dbi, &key, &data, 0);
mdb_txn_commit(txn);
```

---

## 13.5 Memory Mapping Considerations

* LMDB maps the entire database into the virtual memory of the process.
* Embedded devices often have limited RAM; choose an appropriate **map size**:

```c
mdb_env_set_mapsize(env, 10 * 1024 * 1024); // 10 MB map
```

* The map size must be larger than your database. Expanding the map requires reopening the environment.

---

## 13.6 Performance Tuning for Embedded Devices

1. **Page Size**: Default 4 KB is often ideal; smaller pages reduce RAM usage but may increase fragmentation.
2. **Batch Writes**: Group multiple writes into a single transaction to minimize disk I/O.
3. **Read-Only Transactions**: Use multiple concurrent readers for analytics or monitoring.
4. **Avoid Frequent Map Resizing**: Pre-allocate a map large enough for future growth.

---

## 13.7 LMDB vs Other Embedded Databases

| Feature           | LMDB      | SQLite    | RocksDB   |
| ----------------- | --------- | --------- | --------- |
| Read Performance  | Excellent | Good      | Good      |
| Write Performance | Good      | Moderate  | Excellent |
| Memory Usage      | Low       | Low       | Moderate  |
| ACID Compliance   | Yes       | Yes       | Yes       |
| Complexity        | Low       | Low       | High      |
| Embedded-Friendly | Excellent | Excellent | Moderate  |

LMDB is **read-heavy optimized** and excels in environments where reads dominate writes.

---

## 13.8 Embedded System Example: IoT Device Log Storage

Suppose we want to store sensor readings in an IoT device:

```c
#include <stdio.h>
#include <lmdb.h>

int main() {
    MDB_env *env;
    MDB_dbi dbi;
    MDB_txn *txn;

    mdb_env_create(&env);
    mdb_env_set_mapsize(env, 2 * 1024 * 1024); // 2 MB
    mdb_env_open(env, "./sensor_db", 0, 0664);

    mdb_txn_begin(env, NULL, 0, &txn);
    mdb_dbi_open(txn, NULL, 0, &dbi);

    MDB_val key, data;
    key.mv_size = sizeof(int);
    key.mv_data = &(int){1};
    data.mv_size = sizeof(double);
    double temp = 25.3;
    data.mv_data = &temp;

    mdb_put(txn, dbi, &key, &data, 0);
    mdb_txn_commit(txn);

    mdb_dbi_close(env, dbi);
    mdb_env_close(env);
    return 0;
}
```

**Explanation:**

* Each sensor reading is stored as a key-value pair.
* LMDB ensures writes are atomic and consistent.
* Reading the database requires no locks, even while writes happen.

---

## 13.9 Summary

* LMDB is a **lightweight, reliable, and fast** key-value store ideal for embedded systems.
* Its **memory-mapped architecture** enables zero-copy reads and high throughput.
* Copy-on-write and ACID transactions make it **crash-safe**.
* Performance tuning is crucial for constrained devices: map size, batch writes, and read optimization.
* LMDB is widely used in embedded software, IoT devices, mobile apps, and network appliances.

---

## 13.10 LMDB Transactional Design and WAL-like Mechanism

Unlike many traditional databases, LMDB does **not use a separate Write-Ahead Log (WAL) file**. Instead, it achieves **atomicity, durability, and crash safety** using **memory-mapped files and a copy-on-write (COW) B+Tree**. Let’s break this down.

---

### 13.10.1 Copy-on-Write (COW) B+Tree

LMDB’s core design revolves around a **COW B+Tree**, which ensures that **writes never overwrite existing data in place**:

1. Each page in the database file is **immutable once written**.
2. Updates create **new copies of the affected pages**, leaving readers untouched.
3. Once the transaction commits, LMDB **updates the root pointer** to the new B+Tree root.
4. Readers always see a **consistent snapshot** of the database, even while writers are active.

**Advantages of this design:**

* **Readers never block writers**.
* **Atomic commits**: either the root pointer update succeeds or fails; partial writes are never visible.
* **Crash safety without WAL**: since old pages remain intact until commit, the database can always revert to the previous consistent state.

---

### 13.10.2 Pseudo-WAL Mechanism

While LMDB doesn’t have a traditional WAL, it mimics **WAL functionality** in a lightweight way:

* **Transactional updates**: New pages are written to free space in the memory-mapped file.
* **Durability**: On commit, LMDB updates the **root page number** in the database header and optionally flushes pages to disk (`mdb_env_sync`).
* **Atomic root update**: The root pointer acts as a single commit record, similar to the WAL commit record.
* **Rollback support**: If a crash occurs, uncommitted pages are simply ignored because the root pointer still points to the old tree.

**Visualization:**

```
[Old Tree Pages]         [New Tree Pages]
      |                        |
      v                        v
   Reader sees             Writer modifies pages
   Old root pointer          (COW)
                              |
                              v
                        Root pointer updated -> commit
```

---

### 13.10.3 Transaction Commit Process

1. **Begin transaction**: Allocate new pages for updates.
2. **Write data to pages**: Updates occur in private copies.
3. **Commit transaction**:

   * Flush modified pages to disk.
   * Atomically update root page pointer in DB header.
4. **Readers continue using old root** until next transaction.
5. **Free old pages**: Pages from previous transactions that are no longer referenced are recycled.

This ensures **ACID compliance**:

| Property    | How LMDB Implements It                                               |
| ----------- | -------------------------------------------------------------------- |
| Atomicity   | Root page pointer updated atomically; either old or new tree visible |
| Consistency | B+Tree structure maintained; page-level integrity checks             |
| Isolation   | Readers see snapshot of database at transaction start                |
| Durability  | Pages written to disk and root pointer updated atomically            |

---

### 13.10.4 Page Management & Garbage Collection

LMDB uses a **freelist system** instead of log compaction:

* Modified pages are tracked during write transactions.
* After a transaction commits, **unused pages** are added to a free list.
* Next transaction can reuse pages without expanding the file.
* This avoids **fragmentation** and ensures predictable memory usage.

---

### 13.10.5 Comparison to Traditional WAL

| Feature                | Traditional WAL       | LMDB (COW)                |
| ---------------------- | --------------------- | ------------------------- |
| Separate log file      | Yes                   | No                        |
| Write amplification    | Higher                | Low                       |
| Crash recovery         | Replay WAL            | Root pointer rollback     |
| Read/write concurrency | Often blocked         | Readers never blocked     |
| Disk space overhead    | Extra log file needed | Only old pages (freelist) |

---

### 13.10.6 Performance Implications

1. **Reads are extremely fast**:

   * Memory-mapped pages allow direct access; no WAL replay required.
2. **Writes are sequential and append-only**:

   * Copy-on-write writes to free pages; minimal disk seek.
3. **Crash recovery is instant**:

   * Database can be reopened immediately; no log replay.

---

### 13.10.7 Practical Tips for Embedded Systems

* **Map size**: Ensure the memory-mapped file is large enough to accommodate growth and avoid frequent remapping.
* **Commit frequency**: Frequent small transactions can be slower due to flushing overhead; batch updates if possible.
* **Read-heavy applications**: LMDB excels because readers are non-blocking.
* **Write-heavy embedded workloads**: Optimize page size and map size; consider using multiple databases for partitioning.

---

### 13.11 Summary of LMDB WAL Design

* LMDB **does not need a separate WAL**; copy-on-write B+Tree + atomic root pointer ensures crash-safe commits.
* Embedded systems benefit from **low memory usage, predictable performance, and high read concurrency**.
* LMDB’s approach eliminates the complexity of WAL management while providing **full ACID guarantees**.