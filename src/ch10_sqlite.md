# Chapter 10: SQLite WAL Mode

## **1. Introduction**

SQLite is one of the most widely used embedded databases in the world. It powers everything from mobile applications and web browsers to IoT devices and operating systems. One of its most remarkable features is its simplicity-just a single file acts as a complete database.
But simplicity comes with a price: concurrency and performance challenges.

In earlier versions, SQLite used a **rollback journal** mechanism to ensure atomicity and durability. However, this model required exclusive file locking during commits, severely limiting write concurrency.

To solve this, SQLite introduced **Write-Ahead Logging (WAL) mode** in version **3.7.0 (2010)**. WAL mode fundamentally changed how SQLite handles transactions, offering better concurrency, crash recovery, and performance under multi-reader workloads.

> Official Docs: [SQLite WAL Mode Overview](https://www.sqlite.org/wal.html)

---

## **2. The Core Idea**

In **WAL mode**, writes are no longer made directly to the main database file (`.db`).
Instead, they are **appended** to a separate file - the **WAL file** (`.db-wal`).

* The WAL file stores the new versions of modified pages.
* Readers continue to access the old database file until a checkpoint merges the WAL contents back into it.
* This eliminates the need for readers to block writers.

SQLite’s WAL file acts as a **rolling append-only log of page changes**, maintaining durability and crash safety.

```
┌──────────────┐     ┌─────────────┐
│ main.db file │     │  main.db-wal│
└──────────────┘     └─────────────┘
       ↑                     ↑
       │                     │
    checkpoint ←────── append writes
```

---

## **3. How WAL Mode Works**

### **3.1 Normal Journal Mode vs WAL Mode**

| Aspect                    | Rollback Journal                                         | WAL Mode                                     |
| ------------------------- | -------------------------------------------------------- | -------------------------------------------- |
| Write behavior            | Copy old pages to rollback journal, then write new pages | Append modified pages to WAL file            |
| Reader-writer concurrency | Readers block writers                                    | Readers and writers can proceed concurrently |
| Crash recovery            | Rollback uncommitted changes                             | Replay committed changes from WAL            |
| Checkpointing             | Not needed (implicit)                                    | Required to merge WAL into DB                |

---

### **3.2 WAL File Structure**

Each WAL file is composed of **frames**, each representing a modified page.

**Structure:**

```
+-----------------------------------------------------------+
| WAL Header (32 bytes)                                     |
+-----------------------------------------------------------+
| Frame #1 Header (24 bytes) | Frame #1 Page Data (4096 B)  |
+-----------------------------------------------------------+
| Frame #2 Header (24 bytes) | Frame #2 Page Data (4096 B)  |
+-----------------------------------------------------------+
| ...                                                         
+-----------------------------------------------------------+
```

Each frame includes:

* **Page number**
* **Commit record number (or LSN)**
* **Checksum**
* **The page image**

SQLite always appends new frames to the WAL file until a **checkpoint** occurs.

---

### **3.3 Checkpointing**

Checkpointing merges changes from the WAL file into the main database.
There are three types:

| Type         | Description                                      |
| ------------ | ------------------------------------------------ |
| **Passive**  | Merge only if readers are not active             |
| **Full**     | Waits for readers to finish before checkpointing |
| **Restart**  | Like full, but also resets WAL                   |
| **Truncate** | Like restart, but truncates WAL to zero bytes    |

You can manually trigger one using SQL:

```sql
PRAGMA wal_checkpoint(FULL);
```

Or configure automatic checkpoints:

```sql
PRAGMA wal_autocheckpoint = 1000;
```

---

## **4. Code Example - Enabling WAL Mode**

Let’s enable WAL mode and observe its behavior:

```sql
-- Enable WAL mode
PRAGMA journal_mode = WAL;

-- Create a table
CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT);

-- Insert some data
INSERT INTO users(name) VALUES ('Alice');
INSERT INTO users(name) VALUES ('Bob');

-- Check current WAL mode
PRAGMA journal_mode;
```

**Output:**

```
wal
```

Now, check your directory - you’ll see a new file:

```
mydb.db-wal
```

This file will grow as you write, then shrink after a checkpoint.

---

## **5. C Code Snippet: Opening SQLite in WAL Mode**

From SQLite’s own [test fixture code](https://github.com/sqlite/sqlite/blob/master/src/wal.c):

```c
sqlite3 *db;
int rc = sqlite3_open("test.db", &db);
if (rc == SQLITE_OK) {
    sqlite3_exec(db, "PRAGMA journal_mode=WAL;", NULL, NULL, NULL);
}
```

SQLite internally calls `sqlite3PagerWalSupported()` and then opens a **WAL object** using the `sqlite3WalOpen()` function, which lives in `wal.c`.

Simplified from the SQLite source:

```c
int sqlite3WalOpen(
  sqlite3_vfs *pVfs,
  const char *zDb,
  sqlite3_file *pDbFd,
  int syncFlags,
  int *pExists,
  sqlite3_wal **ppWal
){
  // Open or create a .db-wal file
  // Initialize WAL header and frame buffer
  // Prepare locks for writers and readers
}
```

---

## **6. Concurrency in WAL Mode**

SQLite implements **multi-reader, single-writer** concurrency.

* Multiple readers can read from the database while the writer appends to WAL.
* Writers only need to acquire an **exclusive WAL lock** when committing.
* Readers use a snapshot view based on the WAL header.

Internally, this works through **shared memory (`.db-shm`)** that tracks:

* Readers’ positions (read marks)
* The last committed frame
* The writer’s status

```
main.db
main.db-wal
main.db-shm
```

`main.db-shm` helps coordinate access among multiple processes.

---

## **7. Recovery Process**

On startup:

1. SQLite checks if `.db-wal` exists.
2. If yes, it validates the WAL header.
3. Replays all committed frames (based on the last commit LSN).
4. Applies changes to the main database.
5. Truncates the WAL after recovery.

```c
// Simplified replay logic
while (next_frame <= last_commit_frame) {
    apply_page_to_db(wal_get_page(frame.page_no));
}
```

This ensures **atomic commit** and **durability** - even if the crash happened mid-transaction.

---

## **8. Performance and Tradeoffs**

**Advantages:**

* Readers and writers don’t block each other.
* Writes are sequential (append-only).
* Excellent for read-heavy workloads.

**Disadvantages:**

* Slightly higher disk space usage (WAL + main file).
* Checkpointing introduces periodic I/O bursts.
* Limited scalability on concurrent writes (still single-writer).

---

## **9. WAL Mode Configuration and Monitoring**

```sql
-- View WAL file size
PRAGMA wal_checkpoint;

-- Force a manual checkpoint
PRAGMA wal_checkpoint(TRUNCATE);

-- Configure auto-checkpoint
PRAGMA wal_autocheckpoint = 1000;

-- Check if WAL is enabled
PRAGMA journal_mode;
```

---

## **10. Experiment - Visualizing WAL in Action**

Try this Python script to observe WAL behavior live:

```python
import sqlite3, os, time

db = sqlite3.connect("wal_test.db")
cur = db.cursor()
cur.execute("PRAGMA journal_mode=WAL;")
cur.execute("CREATE TABLE IF NOT EXISTS test(id INTEGER PRIMARY KEY, value TEXT)")

for i in range(5):
    cur.execute("INSERT INTO test(value) VALUES (?)", (f"value-{i}",))
    db.commit()
    print("Inserted:", i)
    print("WAL size:", os.path.getsize("wal_test.db-wal"))
    time.sleep(1)
```

You’ll see the WAL file grow, then shrink when checkpointed.

---

## **11. Design Insights**

SQLite’s WAL design reflects minimalism:

* **Single-writer concurrency** suits embedded environments.
* **Append-only writes** minimize random I/O.
* **Auto-checkpointing** keeps WAL manageable.
* **Crash recovery** is simple: replay the log.

Its architecture inspired lightweight WAL systems in other embedded and distributed databases.

---

## **12. References**

* [SQLite WAL Documentation](https://www.sqlite.org/wal.html)
* [SQLite Source Code (`wal.c`)](https://github.com/sqlite/sqlite/blob/master/src/wal.c)
* [SQLite Checkpointing Details](https://www.sqlite.org/checkpoint.html)
* [SQLite Internals – The Architecture of Open Source Applications](http://aosabook.org/en/sqlite.html)

---

## **13. Summary**

SQLite’s **WAL mode** turns a single-file embedded database into a high-performance, crash-safe system capable of serving multiple readers and a single writer concurrently.
Its design is elegant - a minimal implementation of **write-ahead logging** tuned for simplicity and embedded environments.