# Chapter 5: Crash Recovery

When you first implement a Write-Ahead Log, you might think the hard part is done - after all, every change is recorded safely before it’s applied to data. But the *real* test of a WAL comes when the system crashes.

This chapter is all about recovery: how a database uses the WAL to restore itself to a consistent state after a crash. You’ll see how to reconstruct committed transactions, discard incomplete ones, and make sure no data is lost - all automatically, on restart.

---

## Step 1: Why Crash Recovery Matters

Imagine your database is running smoothly, applying transactions and appending log records. Then suddenly the system crashes. When it comes back online, you have two kinds of persistent data:

1. **Data files** – may not include recent writes (since they’re buffered in memory).
2. **WAL file** – includes a complete, durable record of all operations.

That WAL is your lifeline. It remembers what the database *intended* to do, even if it didn’t finish doing it. Crash recovery’s job is to make sure those intentions are faithfully completed - or safely undone.

---

## Step 2: Recovery Goals

Crash recovery must satisfy two of the four core database guarantees:

* **Durability:** Committed transactions must survive crashes.
* **Atomicity:** Uncommitted transactions must be rolled back completely.

To achieve this, our recovery logic will:

1. **Redo** the effects of committed transactions that weren’t fully written to disk.
2. **Undo** the effects of incomplete or aborted transactions.

You can think of recovery as a replay and rewind system - replay all good work, rewind anything half-done.

---

## Step 3: What Survives a Crash

Let’s recap what persists across a crash:

* The **WAL file** on disk, flushed up to the last `fsync`.
* The **data files**, which may be out of date.

Everything else - the in-memory cache, dirty page map, and active transaction table - is gone.

When the system restarts, the recovery process will rebuild that lost in-memory state *by reading the WAL itself*.

---

## Step 4: The Recovery Process Overview

We’ll use a simplified version of the ARIES algorithm, with three stages:

1. **Analysis:** Figure out which transactions were active and which pages might be dirty at crash time.
2. **Redo:** Reapply changes for committed transactions to ensure durability.
3. **Undo:** Roll back incomplete transactions to ensure atomicity.

Here’s the pseudocode for our recovery:

```text
recover():
    txTable = {}
    dirtyPages = {}

    # Phase 1: Analysis
    for record in WAL:
        update txTable based on record type
        mark dirty pages

    # Phase 2: Redo
    for record in WAL:
        if record.page.LSN < record.LSN and record.txn is committed:
            apply(record)

    # Phase 3: Undo
    for record in reversed(WAL):
        if record.txn is uncommitted:
            undo(record)
```

---

## Step 5: The Analysis Phase

The first step is scanning the WAL from the beginning to rebuild our **transaction table** and **dirty page table**.

Whenever you see:

* `BEGIN_TXN` → Add transaction as *in-progress*
* `COMMIT_TXN` → Mark as *committed*
* `ABORT_TXN` → Mark as *aborted*
* `UPDATE` → Record that the page is dirty and associate it with that transaction

By the end of this scan, you know exactly which transactions were incomplete when the system crashed.

**Example:**

| Txn ID | State       | Last LSN | Dirty Pages |
| ------ | ----------- | -------- | ----------- |
| 1      | committed   | 152      | [P3, P5]    |
| 2      | in-progress | 177      | [P8]        |

Now we’re ready to restore data to a consistent state.

---

## Step 6: Redo Phase

Redo ensures that *all committed transactions* are reflected in the data files.

For each WAL record:

1. Read the page from disk.
2. Check the page’s stored `pageLSN` (the last log record applied to it).
3. If `pageLSN < record.LSN`, it means this record wasn’t applied yet - so apply the update now.
4. Update the `pageLSN` to the record’s `LSN`.

This process is **idempotent** - if you crash again during recovery, redoing the same records won’t double-apply changes.

---

### Example

Let’s say we have the following WAL log:

| LSN | Txn | Type       | Page | Before | After |
| --- | --- | ---------- | ---- | ------ | ----- |
| 100 | 1   | BEGIN_TXN  | -    | -      | -     |
| 110 | 1   | UPDATE     | P3   | A      | B     |
| 120 | 2   | BEGIN_TXN  | -    | -      | -     |
| 130 | 2   | UPDATE     | P5   | X      | Y     |
| 140 | 1   | COMMIT_TXN | -    | -      | -     |

Suppose a crash occurs right after record 130 (Txn 2’s update), before 140 is fully flushed.

On restart:

* Analysis: Txn 1 = committed, Txn 2 = in-progress.
* Redo: Apply Txn 1’s update to P3 (if not already applied).
* Undo: Roll back Txn 2’s change on P5.

The end state is consistent:

```
P3 = B  (committed)
P5 = X  (rolled back)
```

---

## Step 7: Undo Phase

The undo phase is the cleanup crew.
We scan the WAL backward and reverse any changes made by uncommitted transactions.

For each record:

* If it belongs to an in-progress transaction, apply its *before-image* to restore the old value.
* Optionally, write a **compensation log record (CLR)** indicating that this undo action has been logged. (Our minimal design can skip this for simplicity.)

When all incomplete transactions are undone, atomicity is guaranteed.

---

## Step 8: Checkpoints (Optional Optimization)

Reading the entire WAL on every restart works, but it can be slow.
To speed up recovery, databases write **checkpoints** periodically.

A checkpoint records:

* The list of active transactions
* The list of dirty pages
* The last flushed LSN

When the system restarts, recovery can begin from the last checkpoint instead of from the start of the log.

Here’s what a minimal checkpoint record might look like:

```json
{
  "type": "CHECKPOINT",
  "active_txns": [2, 3],
  "dirty_pages": ["P8", "P9"],
  "last_lsn": 150
}
```

---

## Step 9: Implementing Recovery in Code (C# Example)

Below is a minimal conceptual version of the recovery logic.
It assumes you already have a `WALRecord` struct and a way to read pages from disk.

```csharp
public class RecoveryManager
{
    private readonly IPageStore _pageStore;
    private readonly IEnumerable<WALRecord> _log;

    public RecoveryManager(IPageStore pageStore, IEnumerable<WALRecord> log)
    {
        _pageStore = pageStore;
        _log = log;
    }

    public void Recover()
    {
        var txState = new Dictionary<long, string>(); // txnId -> state

        // Phase 1: Analysis
        foreach (var rec in _log)
        {
            switch (rec.Type)
            {
                case WALRecordType.Begin:
                    txState[rec.TxnId] = "active";
                    break;
                case WALRecordType.Commit:
                    txState[rec.TxnId] = "committed";
                    break;
                case WALRecordType.Abort:
                    txState[rec.TxnId] = "aborted";
                    break;
            }
        }

        // Phase 2: Redo
        foreach (var rec in _log)
        {
            if (rec.Type == WALRecordType.Update &&
                txState.TryGetValue(rec.TxnId, out var state) &&
                state == "committed")
            {
                var page = _pageStore.ReadPage(rec.PageId);
                if (page.LSN < rec.LSN)
                {
                    page.Apply(rec.AfterImage);
                    page.LSN = rec.LSN;
                    _pageStore.WritePage(page);
                }
            }
        }

        // Phase 3: Undo
        foreach (var rec in _log.Reverse())
        {
            if (rec.Type == WALRecordType.Update &&
                txState.TryGetValue(rec.TxnId, out var state) &&
                state == "active")
            {
                var page = _pageStore.ReadPage(rec.PageId);
                page.Apply(rec.BeforeImage);
                _pageStore.WritePage(page);
            }
        }

        Console.WriteLine("Recovery complete!");
    }
}
```

This implementation is minimal but captures the essence:

* Replays committed work.
* Reverses incomplete transactions.
* Keeps idempotence through `page.LSN` checks.

---

## Step 10: Wrapping Up

Crash recovery completes the story that began with Write-Ahead Logging.
Together, they guarantee that your database can crash at *any* point and still come back consistent.

By now, your system:

* Writes intent before data (WAL).
* Replays or rolls back intent after crashes (Recovery).

In the next chapter, we’ll focus on **checkpointing and log truncation** - the final step in keeping your WAL lean, your recovery fast, and your storage healthy.

---