# Intro to Data Durability

## The Data Behind Everyday Applications

Every day, we interact with dozens of applications that silently manage and store our data - from social media platforms and email clients to banking apps and cloud drives.
When you:

* Send a message on WhatsApp,
* Save a photo to Google Photos,
* Stream a playlist on Spotify, or
* Check your balance on a banking app,

you’re relying on a massive network of servers and databases to **store and retrieve your data reliably**.

This data isn’t trivial - it represents our:

* **Personal memories** (photos, messages, notes),
* **Financial records** (transactions, bills, receipts),
* **Business assets** (customer data, analytics, and product information), and
* **System states** (user sessions, cache, logs, etc.).

Losing this data can be catastrophic - imagine a bank losing transaction records or a social platform losing years of messages.
That’s why **data durability** is one of the most critical guarantees that storage systems and databases strive to achieve.

---

## What Is Durability?

### **General Definition**

**Durability** refers to the **ability of a system to preserve information even in the face of failures** - such as crashes, power loss, or hardware damage.

In simple terms:

> Once data is written and confirmed as “saved,” it should **never disappear** unexpectedly.

For example, if you write a document and click “Save,” you expect that file to still exist tomorrow, even if your computer restarts or the application crashes.

### **Importance of Durability**

Durability is not just a technical property - it’s a **promise of trust** between the system and its users:

* It ensures that **once a transaction is complete**, it will remain intact.
* It allows systems to **recover from crashes** without losing state.
* It forms one of the key pillars of the **ACID** properties in databases (Atomicity, Consistency, Isolation, **Durability**).

Without durability, all other guarantees collapse - a perfectly consistent and atomic system means little if it forgets its data after a reboot.

---

## Durability in Storage and Databases

To understand durability in databases, we must look at how computers store data at different layers.

### **Volatile vs Non-Volatile Storage**

| Type                     | Description                         | Example                          | Durability    |
| ------------------------ | ----------------------------------- | -------------------------------- | ------------- |
| **Volatile Storage**     | Loses data when power is lost       | RAM (Random Access Memory)       | Not durable |
| **Non-Volatile Storage** | Persists data even after power loss | SSDs, Hard Drives, Flash Storage | Durable     |

When you run a database query or modify a record, the changes first happen in **memory (RAM)** for speed. But memory is volatile - if the machine crashes before changes reach disk, data is lost.

Therefore, databases must ensure that **critical data is safely written to durable storage (disk or SSD)** before confirming a successful operation.

---

# How Computers Lose Data

Even the most powerful computers and databases are vulnerable to one simple truth:
**hardware and software can fail.**

To understand why durability is so important - and how techniques like Write-Ahead Logging (WAL) were invented - we first need to see *how* computers actually lose data.

---

## 1. The Fragile Path of Data

When an application writes data - say, saving a user’s profile or recording a transaction - that data travels through several layers before reaching permanent storage:

```
Application → Database Engine → OS Cache → Disk Controller → Disk/SSD
```

Each layer plays a role in speed and reliability, but also introduces **points of failure**.

Let’s see what can go wrong.

---

## 2. Common Causes of Data Loss

### **a. Power Failures**

Power outages or system crashes can occur at any moment - even in the middle of a write.

If data is still in **volatile memory (RAM)** or **OS buffers**, it disappears instantly when power is lost.

> Example:
> A database acknowledges a successful write, but the data never made it from cache to disk. After reboot, the record is gone.

This is why true durability requires **flushing writes to non-volatile storage** and verifying that the data has been persisted.

---

### **b. Software Crashes**

Applications and databases are complex. A crash during write operations can leave files **partially written** or **corrupted**.

For example:

* A database might crash midway through updating an index.
* File metadata may be inconsistent, leaving “dangling” data blocks.

Such **inconsistent states** make recovery difficult - unless the system maintains an ordered log of what was being done (hint: WAL helps here).

---

### **c. Hardware Failures**

Disks and SSDs, despite their reliability, **wear out** over time.

* Hard disks can develop **bad sectors** or **head crashes**.
* SSDs have **limited write cycles** and can suffer from controller failures.

If data is stored on a single disk with no replication, its loss may be **irrecoverable**.

Modern systems counter this with:

* RAID configurations,
* Replication to multiple nodes, and
* Checksums to detect bit rot or silent corruption.

---

### **d. Operating System or File System Errors**

Even if hardware works fine, **file systems** (like NTFS, ext4, or APFS) can introduce risk:

* The OS might reorder or batch writes for performance.
* Filesystem journaling might not complete before a crash.
* Metadata (like directory entries) may get corrupted.

When this happens, data might physically exist on disk but be **logically inaccessible**.

---

### **e. Human Error**

Not all failures are mechanical.
Developers and administrators also delete, overwrite, or misconfigure systems accidentally.

Examples:

* Running `rm -rf /data` on the wrong server.
* Misapplying a database migration.
* Restoring from an outdated backup.

Human mistakes are among the **most frequent causes** of data loss - and durability mechanisms can only help if changes are logged before they’re lost.

---

## 3. Data Corruption: The Silent Enemy

Sometimes, data doesn’t vanish - it **changes silently**.
Corruption can happen due to:

* Bit flips caused by cosmic radiation or faulty RAM,
* Disk write interruptions,
* Transmission errors across hardware buses.

The danger is that these errors might **go undetected for months** until a read operation fails.
Databases therefore use **checksums** and **redundant copies** to detect and repair corruption early.

---

## How Durability Mechanisms Protect Against Loss

Let’s revisit the durability techniques introduced earlier - now through the lens of failure scenarios:

| Failure Type        | Without Durability     | With WAL/Durable Design                              |
| ------------------- | ---------------------- | ---------------------------------------------------- |
| Power Loss          | Incomplete writes lost | Changes logged before crash; can replay after reboot |
| Crash During Update | Corrupted data         | Atomic recovery using log                            |
| Disk Failure        | Data gone              | Replication or backup recovers state                 |
| Software Bug        | Inconsistent state     | Logs enable rollback or reapply                      |
| Human Error         | Permanent deletion     | Point-in-time recovery via logs                      |

---

## The Limits of Durability

No system can promise **absolute** durability - disks fail, data centers burn, and bugs slip through.
However, systems aim for **practical durability**, often expressed as:

> *“The probability of data loss is less than 1 in 10¹⁵ writes.”*

In practice, this means data is:

* Written to **durable media** (disk/SSD),
* Logged before application,
* Replicated across machines or regions,
* Verified with checksums, and
* Periodically backed up.

These layers together form a **defense-in-depth** strategy against data loss.

---

## Setting the Stage for Write-Ahead Logging

Write-Ahead Logging was designed as a **structured response** to the chaos of system failures.
It ensures that **every change is recorded in a durable log before modifying the main data**, allowing systems to recover exactly where they left off.

In essence:

> *If computers can lose data at any moment, WAL ensures they can always find their way back.*

In the next chapter, we’ll dive into **the core idea and key principles of Write-Ahead Logging** - how it works, why it’s fast despite being durable, and how databases like PostgreSQL, SQLite, and RocksDB rely on it every second.

---