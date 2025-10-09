# Part III: WAL in Real Databases

In the previous parts, we explored the *why* and *how* of Write-Ahead Logging (WAL).
We learned about durability, crash recovery, and even built our own miniature WAL system from scratch.
Now, it’s time to step into the real world.

Modern databases, from relational powerhouses like **PostgreSQL** and **MySQL (InnoDB)** to lightweight engines like **SQLite** and **LMDB**, all rely on WAL-or its close cousins-to ensure data consistency and crash recovery. But they each do it differently, balancing trade-offs in performance, durability, and concurrency.

In this part, we’ll take a guided tour through how real databases implement WAL. We’ll explore their internal mechanisms, design choices, and the reasoning behind them. Each section focuses on one system and connects theory to practice.

---

### 4.1 PostgreSQL WAL

We start with **PostgreSQL**, one of the most educational open-source systems when it comes to WAL design. Its implementation closely follows textbook principles but adds layers of sophistication-like checkpoints, timeline files, and streaming replication. We’ll see how PostgreSQL uses its WAL not only for recovery but also as a foundation for replication and point-in-time recovery.

---

### 4.2 SQLite WAL Mode

Next, we turn to **SQLite**, which takes a very different approach. Its “WAL mode” was introduced to solve concurrency issues in single-file databases. We’ll see how it replaces rollback journals with a simple yet powerful append-only WAL file, making reads and writes coexist peacefully in a lightweight environment-perfect for embedded and mobile systems.

---

### 4.3 InnoDB Redo and Undo Logs

MySQL’s **InnoDB** engine adds complexity with *two* kinds of logs-**redo** and **undo**. Together, they form a hybrid system balancing transactional atomicity and durability. We’ll dissect how the redo log ensures durability while the undo log maintains transactional isolation, and why InnoDB’s buffer pool makes its WAL design unique among relational engines.

---

### 4.4 RocksDB WAL

**RocksDB**, a high-performance key-value store from Meta (Facebook), uses WAL to achieve consistency in a Log-Structured Merge (LSM) tree. Its WAL plays a critical role in bridging in-memory memtables and on-disk SSTables. We’ll look at how it handles high write throughput, compression, and replication in modern data-intensive systems.

---

### 4.5 LMDB and Embedded Systems

Finally, we’ll explore **LMDB** (Lightning Memory-Mapped Database), which takes an unconventional approach by relying on copy-on-write B-trees instead of a traditional WAL. This section helps us see that durability doesn’t always require a separate log file-the underlying principle of "write-before-overwrite" can manifest in different forms depending on the system’s constraints and goals.

---

By the end of this part, you’ll have a deeper appreciation for how different databases interpret and implement WAL principles to fit their architectures. You’ll see the common threads-and the creative deviations-that make each system unique.
