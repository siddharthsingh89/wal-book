# Chapter 4: Designing a Minimal WAL

In this chapter, we’ll **build a minimal Write-Ahead Log (WAL)** — the foundation of durability in databases.
You’ll see how a WAL works *internally*, one step at a time, and by the end you’ll have a working implementation in **Rust** that can recover from crashes.

---

## Step 1: Setting the Goal

Our minimal WAL will:

1. Accept a series of “operations” (like inserts or updates).
2. Write each operation to a **log file** before applying it.
3. Ensure that once written and flushed, the data will **survive a crash**.
4. Allow recovery by **replaying** the log.

---

### The Big Picture

```
 ┌──────────────┐        ┌──────────────┐
 │  Operation   │        │   Database   │
 │ (e.g. update)│        │   State      │
 └──────┬───────┘        └──────┬───────┘
        │                        │
        │                        │
        ▼                        │
   Write to WAL File              │
        │                        │
        ▼                        │
   Flush to Disk (Durable)        │
        │                        │
        └────────► Apply to DB ◄──┘
```

The rule is simple:

> **Never modify data before logging it.**

---

## Step 2: Designing the Log Format

We’ll define a simple binary format for each record.

```
+------------+-------------------+
| 4 bytes    | variable length   |
| length (u32) | payload bytes   |
+------------+-------------------+
```

Each entry has:

* A **length prefix** - so we know how much data to read.
* A **payload** - the actual operation or change.

If the system crashes mid-write, we can detect incomplete entries using this prefix.

---

### Example

If we log two updates:

| Operation | Bytes Written                |
| --------- | ---------------------------- |
| `set x=1` | `[06][73 65 74 20 78 3d 31]` |
| `set y=2` | `[06][73 65 74 20 79 3d 32]` |

Visually:

```
┌──────────────────────────────────────────────┐
│ 0x06 set x=1 | 0x06 set y=2                  │
└──────────────────────────────────────────────┘
```

---

## Step 3: Creating the WAL File

We start with the file management code:

```rust
use std::fs::{File, OpenOptions};
use std::io::{Write, Read, Seek, SeekFrom};
use std::path::Path;

pub struct Wal {
    file: File,
}

impl Wal {
    pub fn open<P: AsRef<Path>>(path: P) -> std::io::Result<Self> {
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .read(true)
            .open(path)?;
        Ok(Self { file })
    }
}
```

Now we have an **append-only file** ready to store our operations.

> You’ve created the backbone of your WAL file system.

---

## Step 4: Writing and Flushing Entries

Let’s write entries in a way that ensures **durability**.

```rust
impl Wal {
    pub fn append(&mut self, data: &[u8]) -> std::io::Result<()> {
        let len = data.len() as u32;
        self.file.write_all(&len.to_le_bytes())?;
        self.file.write_all(data)?;
        self.file.flush()?; // Ensures durability
        Ok(())
    }
}
```

### The Process

1. Convert the length to bytes (`u32 → [u8; 4]`)
2. Write the length prefix.
3. Write the payload.
4. Flush to ensure data reaches disk.

---

### On Disk After Two Writes

```
Offset →
0        4        10       14
│        │        │        │
▼        ▼        ▼        ▼
[06][set x=1][06][set y=2]
```

Each `[06]` = 6-byte payload length prefix.

> If we crash right after writing `set y=2` but before flushing,
> only the first record will be replayed — because the second might not be fully on disk.

---

## Step 5: Reading and Replaying the WAL

Now we add the **replay mechanism**, which reads the log after a crash.

```rust
impl Wal {
    pub fn replay<P: AsRef<Path>>(path: P) -> std::io::Result<Vec<Vec<u8>>> {
        let mut file = File::open(path)?;
        let mut entries = Vec::new();

        loop {
            let mut len_buf = [0u8; 4];
            if file.read_exact(&mut len_buf).is_err() {
                break; // EOF or partial record
            }
            let len = u32::from_le_bytes(len_buf);
            let mut data = vec![0u8; len as usize];
            if file.read_exact(&mut data).is_err() {
                break; // incomplete write
            }
            entries.push(data);
        }

        Ok(entries)
    }
}
```

---

### What Replay Does

```
┌────────────────────────────────────────┐
│ WAL File: [len][payload][len][payload] │
└────────────────────────────────────────┘
           │
           ▼
   Read entry by entry
           │
           ▼
   Apply or print each recovered record
```

If a crash cut off an entry halfway, the replay function simply stops reading — keeping recovery **safe and idempotent**.

---

## Step 6: Testing It All Together

```rust
fn main() -> std::io::Result<()> {
    let path = "wal.log";

    // Write
    let mut wal = Wal::open(path)?;
    wal.append(b"insert key1=value1")?;
    wal.append(b"update key1=value2")?;

    // Simulate crash (just reopen)
    let recovered = Wal::replay(path)?;
    for entry in recovered {
        println!("Replayed: {}", String::from_utf8_lossy(&entry));
    }

    Ok(())
}
```

Output:

```
Replayed: insert key1=value1
Replayed: update key1=value2
```

---

### Visualization: Full Lifecycle

```
Write → Flush → Crash → Replay

┌──────────────┐      ┌──────────────┐
│ append(data) │ ---> │ flush()      │
└──────────────┘      └──────────────┘
        │                    │
        │ Crash occurs!      │
        ▼                    ▼
┌──────────────────────────────────────┐
│ WAL file on disk survives crash      │
│ Replay reads all complete entries    │
└──────────────────────────────────────┘
```

> **Congratulations!**
> You’ve implemented a crash-safe, minimal write-ahead log that can recover all committed data.

---

## Step 7: Reflection and Next Steps

You now have:

* A simple append-only log format.
* Durable writes with flushing.
* Replay logic to restore data.
* A practical understanding of what *“write-ahead”* really means.

But this version isn’t perfect — it grows forever and flushes every write, which is slow.

### Coming Up Next

In the next chapters, we’ll:

* **Handle crashes more efficiently** (Chapter 5 - *Crash Recovery*).
* **Compact logs** to free disk space (Chapter 6 - *Checkpointing*).
* **Support concurrent writes safely** (Chapter 7 - *Concurrency*).
* **Build a complete Rust WAL library** (Chapter 8 - *Final Implementation*).

---