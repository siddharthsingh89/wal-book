# Chapter 2: The Core Idea of Write-Ahead Logging

When you use a database - whether you’re transferring money in an app, editing a document, or saving a game - you expect your data to stay safe, **no matter what**.
Even if the power goes out, your laptop crashes, or your phone dies midway, you want your data to come back intact when you restart.

But how does that actually happen?

That’s where **Write-Ahead Logging (WAL)** comes in - a clever technique that databases use to ensure that data isn’t lost or corrupted even in the face of failures.
Let’s understand the *core idea* behind it step by step.

---

## 1. The Problem WAL Solves

Imagine you’re building a banking app.
A user transfers ₹1000 from **Account A** to **Account B**.

You write some code like this:

```sql
UPDATE accounts SET balance = balance - 1000 WHERE id = 'A';
UPDATE accounts SET balance = balance + 1000 WHERE id = 'B';
COMMIT;
```

Looks fine, right?

Now imagine the power goes out **after** the first line executes but **before** the second one does.
Account A has lost ₹1000, but Account B hasn’t received it yet.
Your database is now in an inconsistent state.

This kind of partial update is what **WAL** is designed to prevent.

It ensures that even if a crash happens halfway through an operation, the database can **recover to a consistent state** - either completing the transaction fully or rolling it back entirely.

---

## 2. The Naive Approach and Its Limitations

In theory, we could just **write all changes directly to disk immediately** to ensure they are durable.

But there’s a problem - disk I/O is **slow** compared to memory operations.

If every update required rewriting data files on disk synchronously, performance would tank.
To make matters worse, if the system crashes during that disk write, the data file could become partially updated (corrupted).

So we need something faster and safer - something that records *what we intend to do* before doing it.

---

## 3. The Key Idea: Log Before You Write

Here’s the golden rule of WAL:

> **Always write the intent of a change (to a log) before applying the change to the main data.**

This means whenever the database wants to modify data, it follows this simple three-step process:

1. **Create a log record** that describes the change.
   Example: “At time T, subtract 1000 from A, add 1000 to B.”
2. **Append that record to a log file** on disk - *sequentially* (this is fast).
3. **Apply the change to the actual data file** - possibly later, in batches.

If a crash happens right after step 2 but before step 3, the log file still contains the record of what was intended.
When the system restarts, it can **replay** the log to restore the correct state.

Here’s a simple pseudo-code version:

```rust
fn transfer(a: &mut Account, b: &mut Account, amount: i64) {
    // Step 1: create log entry
    let log_entry = format!("TRANSFER {} {} {}", a.id, b.id, amount);

    // Step 2: write log first (flush to disk)
    write_to_log(log_entry);

    // Step 3: apply to data
    a.balance -= amount;
    b.balance += amount;

    // Step 4: mark log as committed
    mark_log_committed();
}
```

Notice that **we never update the data until the log is safely on disk**.

That’s the essence of “write-ahead.”

---

## 4. The Log as a Source of Truth

The WAL is typically a **sequential file** - an append-only record of every change the database plans to make.

Each record (or “log entry”) contains enough information to redo or undo an operation.

Example structure:

| Log Sequence Number (LSN) | Operation | Before Value | After Value  | Page ID |
| ------------------------- | --------- | ------------ | ------------ | ------- |
| 101                       | UPDATE    | balance=5000 | balance=4000 | A       |
| 102                       | UPDATE    | balance=2000 | balance=3000 | B       |

Why is this efficient?

* Appending to a log file is a **sequential write** - disks and SSDs handle it extremely fast.
* Updating the data file directly involves **random I/O**, which is much slower.
* This means WAL gives you **durability with high performance**.

In many databases (like PostgreSQL and SQLite), the log file is stored separately - often in a directory like `pg_wal/` or `journal/`.

---

## 5. Crash Recovery Using WAL

So what happens if the system crashes?

On restart, the database checks two things:

1. **The log** - what changes were intended or committed?
2. **The data files** - what’s the current state on disk?

It then performs two operations:

* **Redo:** Reapply committed changes that weren’t fully written to the data files.
* **Undo:** Roll back uncommitted changes that were partially applied.

Example:

Let’s say the last few WAL entries were:

```
LSN 201: START TRANSACTION
LSN 202: UPDATE A -1000
LSN 203: UPDATE B +1000
LSN 204: COMMIT
```

If the system crashed before the data was flushed to disk, the WAL replay will read up to `LSN 204` (the COMMIT) and **redo** the operations to make sure both updates appear.

If it crashed before `COMMIT`, WAL ensures both are undone - maintaining atomicity.

---

## 6. Benefits of WAL

WAL gives databases several powerful advantages:

* **Durability** – Once a log is written, data can always be recovered.
* **Atomicity** – Transactions either complete fully or not at all.
* **Performance** – Sequential writes are faster than random writes.
* **Recovery** – Easy crash recovery using redo/undo.
* **Replication** – Logs can be shipped to replicas for high availability.
* **Checkpoints** – Data files can be periodically synced with logs for faster startup.

This is why almost every modern database - PostgreSQL, MySQL (InnoDB), SQLite, LevelDB, RocksDB, and more - uses some form of WAL.

---

## 7. Real-world Examples

Here’s how different systems implement WAL:

* **PostgreSQL:**
  Uses WAL segments (usually 16 MB files) stored in `pg_wal/`.
  You can stream these logs to replicas using **WAL shipping**.
  [PostgreSQL WAL Docs →](https://www.postgresql.org/docs/current/wal-intro.html)

* **SQLite:**
  Uses a WAL journal file (`.wal`) for atomic commits.
  You can even inspect it with tools like `sqlite3 mydb.db ".recover"`.
  [SQLite WAL Mode →](https://www.sqlite.org/wal.html)

* **RocksDB / LevelDB:**
  Use a write-ahead log (`MANIFEST` or `.log`) to record changes to key-value stores.
  It helps rebuild the database after crashes without full re-compaction.

Even modern file systems like **ext4** and **NTFS** internally use journaling - which is a form of WAL at the file-system level.

---

## 8. Summary and Key Takeaways

* **WAL’s core principle:** *Log every change before applying it.*
* This ensures **durability**, **atomicity**, and **fast recovery**.
* Logs are **append-only**, making writes efficient.
* During recovery, WAL replays committed transactions and rolls back incomplete ones.
* It’s the foundation for advanced database features like replication, checkpoints, and crash recovery.

---

> **Coming Next:**
> In the next chapter, we’ll open up the hood and look at the **architecture of WAL** - the actual components, buffer management, checkpoints, and how databases implement them efficiently.

---