# Chapter 4: Designing a Minimal WAL (C# Version)

I got a request to write the chapter in C#. So, I rewrote this using LLMs. If needed, will add a Java version as well later. If you understand the concept explained in the previous
Rust version, you can skip this chapter as this is just the same chapater copy pasted with C# code.

In this tutorial, we’ll build a **minimal Write-Ahead Log (WAL)** in **C#**, step by step.

By the end, you’ll have:

* A durable log file that survives crashes.
* Append and replay functionality.
* A foundation for recovery, checkpoints, and concurrency in later chapters.

---

## Step 1: Understanding the Goal

A Write-Ahead Log ensures that **every change is recorded to disk before being applied**.

Think of it as your safety net:

```
┌──────────────┐        ┌──────────────┐
│  Operation   │        │   Database   │
│ (e.g. update)│        │   State      │
└──────┬───────┘        └──────┬───────┘
        │                        │
        ▼                        │
   Write to WAL File              │
        │                        │
        ▼                        │
   Flush to Disk (Durable)        │
        │                        │
        └────────► Apply to DB ◄──┘
```

Rule:

> **No modification happens unless it’s safely logged first.**

---

## Step 2: Log Record Format

We’ll store each record with a **4-byte length prefix** followed by the actual payload bytes.

```
+------------+-------------------+
| 4 bytes    | variable length   |
| length (u32) | payload bytes   |
+------------+-------------------+
```

This allows us to detect incomplete entries after a crash.

---

### Example

If we write two entries: `set x=1` and `set y=2`,
the file might look like this (in conceptual view):

```
┌──────────────────────────────────────────────┐
│ [06][set x=1][06][set y=2]                  │
└──────────────────────────────────────────────┘
```

---

## Step 3: Implementing the WAL Class

Let’s start with the class definition and basic setup.

```csharp
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

public class WriteAheadLog : IDisposable
{
    private readonly FileStream _fileStream;
    private readonly BinaryWriter _writer;

    public string FilePath { get; }

    public WriteAheadLog(string path)
    {
        FilePath = path;
        _fileStream = new FileStream(
            path,
            FileMode.OpenOrCreate,
            FileAccess.ReadWrite,
            FileShare.Read,
            4096,
            FileOptions.WriteThrough // ensures OS-level durability
        );
        _fileStream.Seek(0, SeekOrigin.End); // append mode
        _writer = new BinaryWriter(_fileStream, Encoding.UTF8, leaveOpen: true);
    }

    public void Dispose()
    {
        _writer?.Dispose();
        _fileStream?.Dispose();
    }
}
```

> You’ve built the foundation:
> an append-only, durable file with OS-level write-through mode.

---

## Step 4: Appending Entries

Now we add the `Append()` method.

```csharp
public void Append(string data)
{
    var bytes = Encoding.UTF8.GetBytes(data);
    var length = (uint)bytes.Length;

    // Write length prefix
    _writer.Write(length);

    // Write payload
    _writer.Write(bytes);

    // Flush ensures data hits disk
    _writer.Flush();
    _fileStream.Flush(true); // flush to physical media
}
```

Each append guarantees:

1. Length prefix and payload are written atomically.
2. Flush ensures durability.

---

### File Layout After Two Appends

```
Offset →
0        4        10       14
│        │        │        │
▼        ▼        ▼        ▼
[06][set x=1][06][set y=2]
```

> **Now you have a WAL that guarantees data won’t be lost even if the app crashes.**

---

## Step 5: Replaying the WAL

Recovery works by reading each complete entry from the file.

```csharp
public static IEnumerable<string> Replay(string path)
{
    var results = new List<string>();
    if (!File.Exists(path))
        return results;

    using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
    using var reader = new BinaryReader(fs, Encoding.UTF8);

    while (fs.Position < fs.Length)
    {
        try
        {
            uint len = reader.ReadUInt32();
            byte[] data = reader.ReadBytes((int)len);

            // if data is incomplete, stop replay
            if (data.Length < len)
                break;

            results.Add(Encoding.UTF8.GetString(data));
        }
        catch (EndOfStreamException)
        {
            break; // crashed mid-write
        }
    }

    return results;
}
```

---

### Recovery Visualization

```
┌────────────────────────────────────────┐
│ WAL File: [len][payload][len][payload] │
└────────────────────────────────────────┘
           │
           ▼
   Read entry by entry
           │
           ▼
   Replay operations in order
```

If a crash occurred mid-write, the partial record at the end is safely ignored.

> You’ve implemented **crash-safe recovery** logic.

---

## Step 6: Testing It All Together

Let’s test everything in a simple `Main()`:

```csharp
public static void Main()
{
    const string path = "wal.log";

    // Step 1: Write some entries
    using (var wal = new WriteAheadLog(path))
    {
        wal.Append("insert key1=value1");
        wal.Append("update key1=value2");
    }

    // Step 2: Simulate crash → reopen and replay
    var recovered = WriteAheadLog.Replay(path);
    foreach (var entry in recovered)
    {
        Console.WriteLine($"Replayed: {entry}");
    }
}
```

**Output:**

```
Replayed: insert key1=value1
Replayed: update key1=value2
```

---

## Step 7: Visualizing the Full Lifecycle

```
Write → Flush → Crash → Replay

┌──────────────┐      ┌──────────────┐
│ wal.Append() │ ---> │ Flush to Disk│
└──────────────┘      └──────────────┘
        │                    │
        │  Crash occurs!     │
        ▼                    ▼
┌──────────────────────────────────────┐
│ WAL file on disk survives crash      │
│ Replay reads all complete entries    │
└──────────────────────────────────────┘
```

> **At this point:**
> You’ve built a fully functional minimal WAL in **C#** — durable, replay-safe, and extendable.

---

## Step 8: Reflection and Next Steps

What you’ve accomplished:

*  Built a minimal append-only WAL file.
*  Achieved durability using `Flush()` and `FileOptions.WriteThrough`.
*  Implemented safe crash recovery via replay.

### What’s Next

In the coming chapters, we’ll:

* **Chapter 5:** Implement structured crash recovery and consistency checks.
* **Chapter 6:** Add checkpointing and log compaction to manage file growth.
* **Chapter 7:** Handle concurrent writes safely.
* **Chapter 8:** Build a full-featured WAL in Rust (and compare with this C# version).

---