# Chapter 7 - Concurrency and WAL

Concurrency is where correctness and performance collide. In a single-threaded toy WAL you can append records safely, but real systems must handle many concurrent transactions, background flushers, checkpointing, and possibly replication - all touching the WAL. This chapter explains practical, production-proven patterns and shows C# examples so you can experiment and reason about trade-offs.

---

## 7.1 Core concurrency goals for a WAL

When multiple threads/processes interact with the WAL we want to ensure:

1. **Atomicity of appends** - a single log record must be written atomically (no interleaving bytes from different writers).
2. **Ordering** - the on-disk order of records must match the logical order of operations (or at least the order required to preserve correctness).
3. **Durability semantics** - when a transaction commits, the WAL strategy must ensure its durability guarantees (e.g., durable after fsync, or "probably durable" if async).
4. **Performance** - high throughput and acceptable latency under concurrency.

These goals pull in opposite directions: stronger durability (fsync every commit) harms throughput; batching improves throughput but increases commit latency.

---

## 7.2 Common production approaches (what other databases do)

Short survey - patterns used by real DBs:

* **Single-writer + WAL writer thread**

  * *PostgreSQL* uses a WAL writer and a dedicated background process that helps flush WAL segments; the WAL insertion is serialized (though multiple backends can prepare WAL records, actual fsync/commit ordering is coordinated). Postgres implements **group commit** to batch multiple commits into a single fsync.
* **Group commit**

  * Many DBs (Postgres, MySQL InnoDB via `innodb_flush_log_at_trx_commit` variations) accumulate commit requests and do a single fsync for several transactions - trading a bound on latency for much higher throughput.
* **Buffered/appender thread**

  * A single thread accepts append requests (from other worker threads via a queue) and writes to disk, ensuring ordering and atomic writes while avoiding per-thread file locking cost.
* **Doublewrite / safe page writes**

  * *InnoDB* uses a doublewrite buffer to avoid torn page problems on partial page writes.
* **Force vs lazy flush**

  * Some systems allow synchronous durability (`fsync` at commit) or relaxed modes where commits are acknowledged before `fsync` (risking data loss on crash).
* **Direct I/O / O_DSYNC / Write barriers**

  * Low-level options to control caching and ordering for stronger guarantees.
* **Checksumming and LSNs**

  * Records include LSNs and checksums; pages store page LSNs for idempotent Redo.
* **Segmented WAL + log shipping**

  * WAL is layered into segments to allow safe rotation and replication (Postgres, Oracle).
* **LSM vs B-Tree differences**

  * LSM-based systems (RocksDB) write WAL entries and keep memtables in memory; compaction and memtable flush strategies interact with WAL flushing.

We’ll use simplified patterns inspired by these techniques.

---

## 7.3 Approach 1 - Simple mutex-guarded append (safe & easy)

This is the simplest correct approach: a single lock around file writes. It’s easy to reason about and safe across threads, but it serializes writers and will limit throughput.

```csharp
// SimpleWAL.cs
using System;
using System.IO;
using System.Text;
using System.Threading;

public class SimpleWAL : IDisposable
{
    private readonly FileStream _fs;
    private readonly object _writeLock = new object();

    public SimpleWAL(string path)
    {
        // FileOptions.WriteThrough reduces caching, but platform behavior varies.
        _fs = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.Read, 4096, FileOptions.WriteThrough);
    }

    // Append a single log entry and optionally flush to disk (durable if flush==true).
    public void Append(string jsonRecord, bool flush = true)
    {
        var bytes = Encoding.UTF8.GetBytes(jsonRecord + "\n");
        lock (_writeLock)
        {
            _fs.Write(bytes, 0, bytes.Length);
            if (flush)
            {
                // Ensure persistence. On modern .NET, Flush(true) requests OS-level flush.
                _fs.Flush(true); // flush metadata & data to disk (may throw on unsupported platforms)
            }
        }
    }

    public void Dispose()
    {
        _fs?.Dispose();
    }
}
```

**When to use:** small systems, low concurrency, or as a reference implementation.
**Pros:** trivial correctness.
**Cons:** blocks all writers on IO latency.

---

## 7.4 Approach 2 - Buffering + background flusher (higher throughput, tuned durability)

A more common production pattern: worker threads enqueue log entries into an in-memory queue; a single background thread drains the queue to disk (preserving order) and performs periodic or batched `fsync`s. This gives you high throughput and allows you to implement **group commit** cheaply.

Key design points:

* Writers don't wait on disk I/O (reduced latency).
* Periodic flush or batch-on-commit allows many transactions to share one expensive `fsync`.
* You must decide when a caller is allowed to consider a transaction "committed" (before or after fsync).

Example:

```csharp
// BufferedWAL.cs
using System;
using System.Collections.Concurrent;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public class BufferedWAL : IDisposable
{
    private readonly BlockingCollection<WalEntry> _queue = new BlockingCollection<WalEntry>(new ConcurrentQueue<WalEntry>());
    private readonly FileStream _fs;
    private readonly Thread _flusherThread;
    private readonly TimeSpan _flushInterval;
    private volatile bool _running = true;

    public BufferedWAL(string path, TimeSpan flushInterval)
    {
        _fs = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.Read, 4096, FileOptions.None);
        _flushInterval = flushInterval;
        _flusherThread = new Thread(FlusherLoop) { IsBackground = true };
        _flusherThread.Start();
    }

    public void Enqueue(string record, TaskCompletionSource<bool> tcs = null)
    {
        _queue.Add(new WalEntry { Record = record, Tcs = tcs });
    }

    // Call this for "fire-and-forget". For durability-on-commit you'd provide a TCS and await it.
    public void Append(string jsonRecord)
    {
        Enqueue(jsonRecord);
    }

    // Caller can await this TCS to know when the record has been flushed to disk.
    public Task CommitAsync(string jsonRecord)
    {
        var tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        Enqueue(jsonRecord, tcs);
        return tcs.Task;
    }

    private void FlusherLoop()
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var sb = new StringBuilder();
        while (_running)
        {
            WalEntry entry;
            // Block for a short time to gather entries.
            if (_queue.TryTake(out entry, 50))
            {
                sb.AppendLine(entry.Record);
                // drain any additional ready entries
                while (_queue.TryTake(out entry))
                {
                    sb.AppendLine(entry.Record);
                }
                // write batch
                var bytes = Encoding.UTF8.GetBytes(sb.ToString());
                _fs.Write(bytes, 0, bytes.Length);
                _fs.Flush(true); // flush to disk (durability)
                // mark committed entries
                // (we would mark all enqueued TCS as completed; for brevity handle single entry)
                // In a real impl, track list of TCS in the batch and set them true.
                sb.Clear();
            }
            else
            {
                // Periodic flush in case small amount of data remains
                if (sw.Elapsed >= _flushInterval)
                {
                    // nothing to flush here in this simplified example
                    sw.Restart();
                }
            }
        }
    }

    public void Dispose()
    {
        _running = false;
        _queue.CompleteAdding();
        _flusherThread.Join();
        _fs?.Dispose();
    }

    class WalEntry
    {
        public string Record;
        public TaskCompletionSource<bool> Tcs;
    }
}
```

**Durability note:** The code above calls `_fs.Flush(true)` inside the background thread. If you want the caller to see a commit as durable only after fsync, use `CommitAsync` and complete the `TaskCompletionSource` only after flush completes. If you allow callers to proceed before flush, you adopt asynchronous durability (faster but riskier).

**When to use:** medium to high concurrency workloads, where batching yields better throughput.

---

## 7.5 Approach 3 - Group commit (how Postgres and others batch fsyncs)

**Group commit** is the strategy of batching multiple transaction commits into a single `fsync` call. The orchestrator collects transactions that want to commit, writes all related WAL records (or ensures they are in the buffer), then performs one `fsync`. All waiting transactions are then acknowledged as durable.

This dramatically increases throughput because `fsync` is expensive.

A tiny simulation (conceptual) of group commit in C#:

```csharp
// GroupCommitWAL.cs (conceptual)
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;

public class GroupCommitWAL : IDisposable
{
    private readonly FileStream _fs;
    private readonly object _lock = new object();
    private readonly List<CommitRequest> _pending = new List<CommitRequest>();
    private readonly Timer _timer;

    public GroupCommitWAL(string path, TimeSpan commitWindow)
    {
        _fs = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.Read, 4096, FileOptions.None);
        // Timer ticks to trigger grouped commits periodically
        _timer = new Timer(_ => FlushGroup(), null, commitWindow, commitWindow);
    }

    public void Commit(string walRecord)
    {
        var req = new CommitRequest { Record = walRecord, Completed = new ManualResetEventSlim(false) };
        lock (_lock)
        {
            _pending.Add(req);
        }
        // Wait until group flush completes (durable commit)
        req.Completed.Wait();
    }

    private void FlushGroup()
    {
        List<CommitRequest> toFlush;
        lock (_lock)
        {
            if (_pending.Count == 0) return;
            toFlush = new List<CommitRequest>(_pending);
            _pending.Clear();
        }

        // Write all records in one batch
        var sb = new StringBuilder();
        foreach (var r in toFlush) sb.AppendLine(r.Record);
        var bytes = Encoding.UTF8.GetBytes(sb.ToString());
        lock (_fs) // file write must be atomic wrt other file operations
        {
            _fs.Write(bytes, 0, bytes.Length);
            _fs.Flush(true); // one fsync for many commits
        }

        // Signal all waiting commits that their work is durable
        foreach (var r in toFlush) r.Completed.Set();
    }

    public void Dispose()
    {
        _timer.Dispose();
        FlushGroup();
        _fs.Dispose();
    }

    private class CommitRequest
    {
        public string Record;
        public ManualResetEventSlim Completed;
    }
}
```

**Real systems:** Postgres uses a similar idea but with finer control: backends call `XLogInsert` to add WAL records, then to commit they wait for the WAL to be flushed (or use async commit options). The WAL writer coordinates the flush and wakes the waiting backends.

**Pros:** much higher throughput under many small transactions.
**Cons:** increases worst-case commit latency by up to the group window; more complex coordination.

---

## 7.6 Durability modes and configuration knobs

Databases expose knobs controlling durability behavior; common choices:

* **Synchronous commit** (force WAL to disk before returning commit) - safest; highest latency.
* **Asynchronous commit** (ack before fsync) - fastest; risk of losing recent commits on crash.
* **Group commit window** - time to wait to aggregate commit requests.
* **Periodic flush** - flush WAL every X ms for a compromise.
* **O_DSYNC / O_DIRECT / fdatasync** - lower-level flags to control caching and metadata flushes.

**Examples in real DBs:**

* *Postgres*: `synchronous_commit` can be on/off/local, and Postgres does group commit internally.
* *InnoDB (MySQL)*: `innodb_flush_log_at_trx_commit` = 1 (fsync per commit), 2 (flush to OS buffer but not fsync), 0 (flush every second).
* *SQLite*: can run in WAL mode (append-only WAL file) or rollback journal; durability also depends on `PRAGMA synchronous`.

---

## 7.7 Handling torn/written partial pages & atomicity

Disk writes may be torn (part of a page persisted). Production systems guard against partial writes:

* **Doublewrite buffer** (MySQL InnoDB): write pages first to a contiguous doublewrite area, then to final locations. If a crash causes torn writes, pages can be recovered from the doublewrite area.
* **Checksums + page LSN**: pages include LSN and checksum; corrupted pages detected during recovery and skipped/rewritten.
* **Atomic append for WAL**: appending small WAL records is typically atomic from the file system perspective if the writes are smaller than the atomic write size - but you should not rely on this; instead, rely on WAL + checksums and redo logic.

---

## 7.8 Concurrency and recovery interactions

Concurrency complicates recovery: while WAL is append-only, workers may reorder actions in memory. Two important invariants:

* **Write-Ahead Principle:** WAL record for a change must be durable before the change is made durable in the data file (or before transaction is committed). This is why WAL flush ordering is critical.
* **Page LSN checks during redo:** When reapplying log entries during recovery, databases compare the record LSN against the page’s stored LSN (in-page metadata) to decide whether to reapply - this makes redo idempotent.

When using background flushers, group commit, or batching, ensure that the code that acknowledges commit to the application only does that after the WAL has been persisted according to the chosen durability level.

---

## 7.9 Advanced optimizations (overview)

* **Batch & vectorized writes**: accumulating many small records into a bigger write reduces syscall overhead.
* **Per-thread WAL buffers merged by a writer**: Threads append into thread-local buffers, then merged in order by a single writer with sequence numbers.
* **LSN allocation vs persistence ordering**: Assign LSNs in-memory quickly, but ensure the physical disk order reflects necessary constraints (LSNs are logical; recovery relies on LSN semantics).
* **Partitioned WAL**: split WAL into segments (log files) to rotate, compress, and ship for replication (e.g., Postgres WAL segments).
* **Direct I/O & aligned writes**: reduce kernel cache effects and torn writes, but increases complexity (alignment, buffering).

---

## 7.10 Full illustrative sample - WAL writer with background flusher + commit acknowledgements (C#)

Below is a more fleshed-out sample: workers submit WAL records with a `Task` they can await for durability. The background flusher groups pending records and performs one `Flush` (fsync) for the group. This simulates group commit in a simple way.

```csharp
// GroupedBufferedWAL.cs
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public class GroupedBufferedWAL : IDisposable
{
    private readonly FileStream _fs;
    private readonly BlockingCollection<WalRequest> _queue = new BlockingCollection<WalRequest>(new ConcurrentQueue<WalRequest>());
    private readonly Thread _flusher;
    private readonly int _maxBatchSize;
    private readonly TimeSpan _maxWait;

    public GroupedBufferedWAL(string path, int maxBatchSize = 64, TimeSpan? maxWait = null)
    {
        _fs = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.Read, 8192, FileOptions.None);
        _maxBatchSize = Math.Max(1, maxBatchSize);
        _maxWait = maxWait ?? TimeSpan.FromMilliseconds(10);

        _flusher = new Thread(FlushLoop) { IsBackground = true };
        _flusher.Start();
    }

    // Returns a Task that completes when the record is flushed (durable).
    public Task AppendAsync(string record)
    {
        var req = new WalRequest { Record = record, Tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously) };
        _queue.Add(req);
        return req.Tcs.Task;
    }

    private void FlushLoop()
    {
        var batch = new List<WalRequest>(_maxBatchSize);
        while (!_queue.IsCompleted)
        {
            try
            {
                WalRequest first;
                if (!_queue.TryTake(out first, (int)_maxWait.TotalMilliseconds))
                {
                    // timed out - if we have something in batch, flush it
                    if (batch.Count > 0)
                    {
                        DoFlush(batch);
                        batch.Clear();
                    }
                    continue;
                }

                batch.Add(first);

                // collect up to maxBatchSize quickly
                while (batch.Count < _maxBatchSize && _queue.TryTake(out var r))
                {
                    batch.Add(r);
                }

                DoFlush(batch);
                batch.Clear();
            }
            catch (Exception ex)
            {
                // in production you'd have robust error handling and retry logic
                Console.Error.WriteLine("FlushLoop error: " + ex);
            }
        }

        // flush remaining
        if (batch.Count > 0) DoFlush(batch);
    }

    private void DoFlush(List<WalRequest> batch)
    {
        // Build a single write for the whole batch
        var sb = new StringBuilder();
        foreach (var r in batch) sb.AppendLine(r.Record);
        var bytes = Encoding.UTF8.GetBytes(sb.ToString());

        lock (_fs) // serialize file writes with the file handle
        {
            _fs.Write(bytes, 0, bytes.Length);
            _fs.Flush(true); // ask OS to persist to stable storage
        }

        // mark all tasks as completed (durable)
        foreach (var r in batch) r.Tcs.TrySetResult(true);
    }

    public void Dispose()
    {
        _queue.CompleteAdding();
        _flusher.Join();
        _fs.Dispose();
    }

    private class WalRequest
    {
        public string Record;
        public TaskCompletionSource<bool> Tcs;
    }
}
```

**How to use:**

```csharp
var wal = new GroupedBufferedWAL("wal.log", maxBatchSize: 128, maxWait: TimeSpan.FromMilliseconds(5));

async Task Worker(int id)
{
    for (int i = 0; i < 10; i++)
    {
        string rec = $"{{\"lsn\":null,\"txn\":{id},\"seq\":{i},\"payload\":\"data\"}}";
        await wal.AppendAsync(rec); // returns when durable (fsynced) as implemented
        Console.WriteLine($"Worker {id} committed {i}");
    }
}

var tasks = new List<Task>();
for (int w = 0; w < 8; w++) tasks.Add(Worker(w));
Task.WaitAll(tasks.ToArray());
wal.Dispose();
```

This yields high throughput and provides a per-transaction durability `Task` that resolves after the group `fsync`.

---

## 7.11 Trade-offs recap

* **Lock-per-append**: simple, correct, low concurrency. Good for small systems.
* **Buffered flusher**: better throughput, supports multiple writers without blocking on IO, but requires careful handling to provide correctness when callers need synchronous durability.
* **Group commit**: excellent throughput for many small commits; increases commit latency up to the group window.
* **Doublewrite / checksums**: required when page-level atomicity is a concern.
* **Direct I/O / OS flags**: can increase durability semantics but complicate code (alignment, buffering).
* **Crash correctness guarantee**: must preserve WAL ordering, ensure write-ahead property, and implement predictable recovery semantics (redo/undo with page LSN checks).

---

## 7.12 Practical recommendations

* Start simple: use a mutex-guarded append for correctness early in development.
* If you need throughput, move to an async buffered writer - implement `AppendAsync` that gives callers a `Task` when their entry is durable.
* Implement **group commit** semantics if many small transactions dominate your workload.
* Make durability configurable (sync vs async) so you can tune for latency vs throughput.
* Add checksums and LSNs to WAL records and store page LSNs to make redo idempotent.
* Test crash scenarios: simulate crashes at many points and validate recovery.

---

## 7.13 Summary

Concurrency is the "real world" requirement for any WAL-backed storage engine. The key is deciding the right mix of guarantees and performance for your use case:

* If correctness and strong durability are critical, prefer synchronous commits and conservative flushes.
* If throughput with acceptable bounded durability is acceptable, use group commit or periodic flush.
* Mirror patterns used by mature systems (group commit in Postgres, InnoDB's doublewrite and flush controls, RocksDB's WAL + memtable flushing) to avoid common pitfalls.

With the C# examples above you can prototype safe WAL writers, benchmark them, and evolve toward the durability/throughput mix you need.