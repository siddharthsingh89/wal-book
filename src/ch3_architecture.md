# Chapter 3: WAL Architecture and Components

In the previous chapter, we understood the **core idea** of Write-Ahead Logging (WAL):

> “Always record changes in a log before applying them to the main data.”

Now, let’s go one layer deeper and see **how WAL is actually structured** inside a database.
Think of this chapter as looking “under the hood” - we’ll explore how WAL is organized, the key components that make it work, and the different types used across systems.

---

## 1. What Happens Inside a WAL System

When a database receives an update (say, `UPDATE accounts SET balance = balance - 100;`),
it doesn’t immediately rewrite the whole data file. Instead, it follows this sequence:

1. **Prepare a log record** that describes what’s about to change.
2. **Append** that log record to the WAL file (sequential write).
3. **Acknowledge** the commit after the log is safely flushed to disk.
4. **Apply** the actual data change later in the background (during checkpoints).

This is the essential workflow across almost all WAL-based systems.

---

## 2. Types of Write-Ahead Logs

Different systems design WAL differently depending on their recovery model, performance target, and data model.
Broadly, we can categorize WAL implementations into **three major types**:

---

### **2.1 Physical WAL**

This logs **exact bytes** of data pages that changed.

* Used by systems like **PostgreSQL** and **SQLite**.
* Log entries describe *which block* changed and *what bytes* were modified.
* Recovery simply replays these changes in order.

#### Example (Pseudo-code)

```rust
// Simplified physical WAL record structure
struct PhysicalWalRecord {
    lsn: u64,              // Log sequence number
    page_id: u64,          // Which page (block) changed
    offset: u32,           // Byte offset within page
    before: Vec<u8>,       // Optional old bytes (for undo)
    after: Vec<u8>,        // New bytes to apply
}

// Writing a physical WAL entry
fn log_page_update(page_id: u64, offset: u32, new_data: &[u8]) {
    let record = PhysicalWalRecord {
        lsn: next_lsn(),
        page_id,
        offset,
        before: vec![],  // optional
        after: new_data.to_vec(),
    };
    wal_append(record);
}
```

**Advantages:**

* Simple to implement and fast for redo.
* Works directly on binary pages.

**Disadvantages:**

* Large log volume (writes entire page deltas).
* Harder to make portable between versions or replicas.

---

### **2.2 Logical WAL**

Logs the **intent** of the change, not the bytes.
Instead of “write bytes X–Y on page 123”, it logs “increment balance by 100”.

* Used by systems like **MySQL binlog (row or statement-based)** or **logical replication** in PostgreSQL.
* Useful for replication because it’s *database-independent*.

#### Example (Pseudo-code)

```rust
// Logical WAL record (SQL-level)
struct LogicalWalRecord {
    lsn: u64,
    table: String,
    operation: String,     // "UPDATE", "INSERT", etc.
    primary_key: u64,
    old_values: Option<HashMap<String, String>>,
    new_values: HashMap<String, String>,
}

fn log_update(pk: u64, old_balance: i64, new_balance: i64) {
    let record = LogicalWalRecord {
        lsn: next_lsn(),
        table: "accounts".into(),
        operation: "UPDATE".into(),
        primary_key: pk,
        old_values: Some(hashmap!{"balance" => old_balance.to_string()}),
        new_values: hashmap!{"balance" => new_balance.to_string()},
    };
    wal_append(record);
}
```

**Advantages:**

* Compact, portable, and perfect for replication.
* Easier to interpret for analytics or CDC (Change Data Capture).

**Disadvantages:**

* Slower recovery (must interpret higher-level operations).
* Requires schema awareness.

---

### **2.3 Hybrid WAL**

Many modern systems combine both:

* Physical WAL for **fast recovery**,
* Logical WAL for **replication or auditing**.

**Example:** PostgreSQL uses physical WAL for crash recovery and allows exporting *logical replication streams* derived from it.

---

## 3. Key Components of WAL

Let’s break down the moving parts inside a WAL system.
Each piece has a clear role in ensuring durability and consistency.

---

### **3.1 Log Sequence Number (LSN)**

Every WAL record gets a **monotonic number** - the **LSN**.
It uniquely identifies a log position and ensures recovery happens in the correct order.

```rust
static mut GLOBAL_LSN: u64 = 0;

fn next_lsn() -> u64 {
    unsafe {
        GLOBAL_LSN += 1;
        GLOBAL_LSN
    }
}
```

LSNs are like version numbers for database changes.
During recovery, the system knows “I’ve replayed logs up to LSN = 1050”.

---

### **3.2 WAL Buffer**

Instead of writing each log record directly to disk, databases keep a **WAL buffer** in memory.

* Multiple log records are grouped together (batching).
* Written to disk periodically or on commit.

```rust
struct WalBuffer {
    entries: Vec<WalRecord>,
}

impl WalBuffer {
    fn append(&mut self, rec: WalRecord) {
        self.entries.push(rec);
        if self.entries.len() > 1000 {
            self.flush_to_disk();
        }
    }

    fn flush_to_disk(&mut self) {
        // Sequential write
        write_all("wal.log", &self.entries);
        self.entries.clear();
    }
}
```

This gives both **high throughput** and **durability**.

---

### **3.3 WAL File Manager**

Handles log file creation, rotation, and deletion.

* Large systems split WAL into segments (like `00000001.wal`, `00000002.wal`).
* Older logs are archived or removed after checkpoints.

```bash
postgresql/
├── data/
│   ├── base/
│   ├── pg_wal/
│   │   ├── 00000001000000000000000A
│   │   ├── 00000001000000000000000B
│   │   └── ...
```

---

### **3.4 Checkpoints**

A **checkpoint** is when all in-memory changes are written to disk,
and the WAL up to that point is no longer needed for recovery.

* Reduces WAL size.
* Makes recovery faster (start from the last checkpoint).

```rust
fn checkpoint() {
    flush_dirty_pages_to_disk();
    mark_checkpoint_lsn(current_lsn());
    truncate_old_wal_files();
}
```

---

### **3.5 WAL Writer (Background Process)**

In systems like PostgreSQL:

* A background process (`walwriter`) constantly flushes log buffers to disk.
* Ensures commit latency stays low even under heavy load.

This decouples **user transactions** from **disk I/O**.

---

### **3.6 WAL Replay (Recovery)**

When the system restarts after a crash:

1. Identify the last checkpoint.
2. Replay all WAL entries **after** it.
3. Apply redo operations until the end of log.

```rust
fn recover_from_wal() {
    let logs = read_wal_since_checkpoint();
    for record in logs {
        apply_record(record);
    }
    println!("Recovery complete");
}
```

This guarantees that all committed transactions are redone,
and uncommitted ones are ignored (thanks to transaction IDs).

---

## 4. Putting It All Together

Let’s visualize a complete WAL cycle:

```
WAL Write Sequence:

App
 │
 │ Write log record
 ▼
WAL_Buffer
 │
 │ Flush on commit
 ▼
Disk_Log
 │
 │ Commit acknowledged (durable)
 ▼
Data_File
 │
 │ Apply during checkpoint
 ▼
Background redo (if crash occurs)
```



```
Step | Component      | Action
-----|----------------|---------------------------
1    | App            | Write log record
2    | WAL_Buffer     | Append to in-memory log buffer
3    | Disk_Log       | Flush log to disk (commit)
4    | App            | Commit acknowledged (durable)
5    | Data_File      | Apply changes during checkpoint
6    | Recovery       | Background redo if needed
```


This separation of **logging** (fast sequential writes) and **data flushing** (slow random writes)
is the key to WAL’s efficiency and reliability.

---

## 5. Summary




| Component           | Purpose                                  | Example                     |
| ------------------- | ---------------------------------------- | --------------------------- |
| **LSN**             | Identifies log order                     | `000000010000000A`          |
| **WAL Buffer**      | Temporary memory for batching logs       | `wal_buffer.append(record)` |
| **WAL File**        | Durable append-only log on disk          | `pg_wal/000000010000000A`   |
| **Checkpoint**      | Flushes dirty pages, truncates old WAL   | `checkpoint()`              |
| **Replay/Recovery** | Re-applies committed changes after crash | `recover_from_wal()`        |

---

### Key Takeaways

* WAL is the **heart of durability** - every change is first made durable through the log.
* There are **three main types**: physical, logical, and hybrid.
* Core components (LSN, buffer, files, checkpoint, replay) work together to ensure **crash recovery and consistency**.
* WAL is not just for databases - file systems, message queues, and even compilers use the same principle.

---