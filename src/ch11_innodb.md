# Chapter 11: InnoDB Redo and Undo Logging

---

## **1. Introduction**

The **InnoDB storage engine** (the default for MySQL) implements full **ACID** guarantees - Atomicity, Consistency, Isolation, and Durability.

At its core, InnoDB achieves **durability and atomicity** through two powerful mechanisms:

1. **Redo Log** - for durability and crash recovery (similar to WAL)
2. **Undo Log** - for atomic rollback and MVCC (Multi-Version Concurrency Control)

These two logs form the backbone of InnoDB’s storage and recovery system.

> Reference: [MySQL InnoDB Redo Log Documentation](https://dev.mysql.com/doc/refman/8.0/en/innodb-redo-log.html)

---

## **2. The Dual-Log Architecture**

Unlike SQLite (single WAL) or PostgreSQL (single WAL + hint bits), InnoDB splits logging responsibilities:

| Log Type     | Purpose                                             | Stored In                               |
| ------------ | --------------------------------------------------- | --------------------------------------- |
| **Redo Log** | Replays committed changes after crash               | `ib_logfile0`, `ib_logfile1` (circular) |
| **Undo Log** | Rolls back uncommitted transactions & supports MVCC | Inside `ibdata1` or undo tablespaces    |

**Analogy:**

* Redo log → “Replay what was done”
* Undo log → “Undo what wasn’t committed”

This dual design gives InnoDB the ability to **recover from crashes** while also **supporting consistent reads** without blocking writers.

---

## **3. The InnoDB Transaction Lifecycle**

When a transaction modifies a record, the following steps occur:

```
+----------------------------------------------------+
| 1. Modify page in buffer pool                      |
| 2. Record change in redo log (write-ahead)         |
| 3. Record original version in undo log             |
| 4. Commit transaction                              |
| 5. Flush redo log to disk (fsync)                  |
| 6. Later: flush dirty pages to tablespace (.ibd)   |
+----------------------------------------------------+
```

So, InnoDB writes twice before the actual data hit the disk:

* **Redo Log** ensures durability.
* **Undo Log** ensures atomicity and rollback capability.

---

## **4. Redo Log Internals**

### **4.1 Files and Format**

The redo log is stored in the `innodb_log_group_home_dir`, typically:

```
ib_logfile0
ib_logfile1
```

As of MySQL 8.0, these are stored in the **redo log directory** and form a **circular log sequence**.

Each file contains *log records* describing low-level modifications (like updating a page or index).

### **4.2 Write-Ahead Principle**

Just like PostgreSQL and SQLite WAL:

> InnoDB **always writes redo logs before flushing data pages** to disk.

This guarantees that on a crash, InnoDB can recover committed transactions by replaying redo logs.

**Config parameters:**

```sql
SHOW VARIABLES LIKE 'innodb_flush_log_at_trx_commit';
```

| Value | Behavior                            |
| ----- | ----------------------------------- |
| 0     | Write and flush every second        |
| 1     | (Default) Flush on every commit     |
| 2     | Write at commit, flush every second |

---

### **4.3 Redo Log Record Example**

A redo record doesn’t store “SQL,” it stores **physical changes** - like “modify bytes in page X at offset Y.”

Simplified example (conceptually):

```text
LSN: 108490
Type: Update
Space ID: 3
Page No: 204
Offset: 0x4F
Before: 0x0002
After: 0x0003
```

Each record is identified by a **Log Sequence Number (LSN)** - a monotonically increasing byte offset.

---

### **4.4 Checkpointing**

InnoDB periodically writes a **checkpoint** - the point up to which all changes have been flushed to disk.

* Prevents replaying the entire redo log during recovery.
* Maintains `min_lsn` (oldest log needed for recovery).
* Implemented via the **log checkpoint thread**.

```
LSN progression:
 |-----------|-----------|-----------|
   flushed     checkpoint   new writes
```

Checkpoint info is stored in the **InnoDB system tablespace header**.

---

## **5. Undo Log Internals**

### **5.1 Purpose**

Undo logs are the **mirror** of redo logs - they store how to **undo** modifications.

* On rollback → undo logs reverse changes.
* On consistent reads → they reconstruct old versions of rows (MVCC).

---

### **5.2 Structure**

Undo logs are stored in **undo segments** within **rollback segments**, inside undo tablespaces:

```
Undo Tablespace
 └── Rollback Segments
      └── Undo Segments
           ├── Insert Undo
           └── Update Undo
```

Each undo record links to:

* Transaction ID
* Previous version pointer
* Modified columns

---

### **5.3 Undo Record Example**

Conceptually:

```text
Undo Record:
{
  trx_id: 505,
  table_id: 13,
  row_id: 600,
  undo_type: UPDATE,
  before_image: { col1=‘Alice’, col2=42 },
  prev_undo_ptr: 0x0001A3F0
}
```

Undo logs form a **linked list of versions**, allowing readers to traverse back in time.

---

### **5.4 Undo and MVCC**

When a reader starts a transaction, it gets a **consistent snapshot** of the database.
If another transaction updates a row afterward, InnoDB uses undo logs to reconstruct the old version.

This allows **non-blocking reads** (snapshot isolation).

```
Current Row → Undo #2 → Undo #1 → Original
```

Readers pick the appropriate version based on the transaction’s snapshot view.

---

## **6. Recovery Process**

On startup after a crash:

1. **Redo Phase** – Replay committed changes (using redo logs).
2. **Undo Phase** – Roll back uncommitted transactions (using undo logs).

This is very similar to **ARIES** recovery algorithm used in many databases.

```text
Crash Recovery Steps:
1. Read checkpoint LSN.
2. Replay redo records >= checkpoint LSN.
3. For uncommitted trx, follow undo logs backward.
```

---

## **7. Visualization of Interaction**

```
                ┌────────────────────────────────────┐
                │          User Transaction          │
                └────────────────────────────────────┘
                          │
                          ▼
                  ┌─────────────┐
                  │ Buffer Pool │
                  └─────────────┘
                       │
        ┌──────────────┼────────────────────┐
        ▼                                      ▼
┌──────────────┐                    ┌────────────────┐
│   Redo Log   │                    │   Undo Log     │
│ (Durability) │                    │ (Atomicity)    │
└──────────────┘                    └────────────────┘
```

---

## **8. Simplified Example in C++**

Let’s model InnoDB’s idea of redo/undo pairs conceptually.

```cpp
#include <iostream>
#include <stack>
#include <string>

struct LogRecord {
    std::string action;
    std::string before;
    std::string after;
};

int main() {
    std::stack<LogRecord> undoLog;
    std::vector<LogRecord> redoLog;

    // Update operation
    LogRecord record = {"UPDATE users SET age=30", "age=29", "age=30"};
    redoLog.push_back(record);
    undoLog.push(record);

    // Commit: flush redo log
    std::cout << "Flushing redo log to disk..." << std::endl;

    // Rollback: use undo log
    if (false) { // simulate rollback
        auto undo = undoLog.top();
        std::cout << "Undoing: " << undo.before << std::endl;
    }
}
```

This simplified code shows:

* Redo = persist future changes.
* Undo = restore old state if rollback is needed.

---

## **9. Monitoring and Configuration**

Useful commands for administrators:

```sql
-- View redo log size
SHOW VARIABLES LIKE 'innodb_log_file_size';

-- View undo tablespaces
SELECT * FROM INFORMATION_SCHEMA.INNODB_TABLESPACES WHERE NAME LIKE 'undo%';

-- Check LSN progress
SHOW ENGINE INNODB STATUS\G

-- Configure redo log files
SET GLOBAL innodb_redo_log_capacity = 256M;
```

---

## **10. Design Comparisons**

| Feature        | SQLite WAL         | PostgreSQL WAL          | InnoDB Redo/Undo            |
| -------------- | ------------------ | ----------------------- | --------------------------- |
| Crash recovery | Replay WAL         | Replay WAL              | Replay Redo + Rollback Undo |
| MVCC           | Snapshot via pages | Undo via tuple versions | Undo log based              |
| Writers        | Single             | Multiple                | Multiple                    |
| Checkpoints    | Manual or auto     | Checkpoints + segments  | Checkpoint + purge          |
| Isolation      | Basic snapshot     | MVCC                    | MVCC via undo segments      |

---

## **11. Advanced Concepts**

* **Doublewrite Buffer** – Prevents partial page writes.
* **Log Sequence Numbers (LSN)** – Global logical clock for redo positions.
* **Purge Thread** – Cleans old undo logs after transactions commit.
* **Group Commit** – Batches fsyncs for higher throughput.

---

## **12. References**

* [MySQL InnoDB Redo Log Docs](https://dev.mysql.com/doc/refman/8.0/en/innodb-redo-log.html)
* [MySQL InnoDB Undo Tablespaces](https://dev.mysql.com/doc/refman/8.0/en/innodb-undo-tablespaces.html)
* [InnoDB Recovery Process](https://dev.mysql.com/doc/refman/8.0/en/innodb-recovery.html)
* [MySQL Source Code – log0recv.cc](https://github.com/mysql/mysql-server/blob/8.0/storage/innobase/log/log0recv.cc)
* [ARIES: A Transaction Recovery Method Supporting Fine-Granularity Locking](https://www.microsoft.com/en-us/research/publication/aries/)

---

## **13. Summary**

InnoDB’s dual log system - **redo for durability** and **undo for atomicity and MVCC** - provides a robust foundation for transactional consistency.
While the **redo log** ensures all committed changes can survive a crash, the **undo log** provides rollback capability and snapshot isolation, ensuring correctness in concurrent systems.

This elegant separation allows MySQL to balance **performance, durability, and concurrency**, making InnoDB one of the most advanced storage engines in the open-source ecosystem.