## Chapter 15: Distributed Databases

---

### **Introduction: When One WAL Isn’t Enough**

In a single-node system, the **Write-Ahead Log (WAL)** protects us from crashes.
In a replicated cluster, it ensures all nodes agree on what happened.

But what happens when your database isn’t just *replicated* - it’s *distributed* across multiple **regions, continents, and data centers**?

This is the world of **distributed databases**, where WAL evolves into a **global coordination mechanism** that guarantees consistency even across thousands of machines.

Let’s start with a simple idea.

---

### **1. The Big Picture: From Local Logs to Global Logs**

A distributed database is essentially a **network of smaller databases**, called *nodes* or *replicas*, that coordinate through **logs**.

Each node has:

* Its own **local WAL** (for crash recovery)
* And participates in a **distributed WAL** (for global order)

```
        ┌──────────┐
        │ Client   │
        └────┬─────┘
             │
             ▼
   ┌───────────────┐
   │ Distributed   │   (Global WAL / Consensus)
   │   Log Layer   │
   └────┬────┬─────┘
        │    │
        ▼    ▼
 ┌────────┐ ┌────────┐
 │ Node A │ │ Node B │
 │ Local  │ │ Local  │
 │  WAL   │ │  WAL   │
 └────────┘ └────────┘
```

Every write first lands in a **per-node WAL**, but then must be **agreed upon globally** through replication and consensus.

This ensures that:

* Every replica applies changes in the same order
* No node sees “phantom” data or missed writes
* The system recovers even if entire regions fail

---

### **2. Key Principles of Distributed WAL**

| Concept                 | Description                                                            |
| ----------------------- | ---------------------------------------------------------------------- |
| **Local Durability**    | Each node logs changes to its own WAL before applying them             |
| **Replication**         | WAL entries are copied to followers                                    |
| **Consensus**           | A group of nodes agrees on the order of commits                        |
| **Sharding**            | The keyspace is split into ranges or partitions, each with its own WAL |
| **Global Coordination** | Clock or timestamp protocols maintain ordering across shards           |

Distributed databases integrate these layers into a single cohesive system.

---

### **3. WAL at the Shard Level**

Distributed databases don’t use one giant log for the whole system - that would be impossible to scale.

Instead, they split the data into **shards** or **ranges**, each maintaining its **own independent WAL**.

Example:

| Shard | Data Range       | WAL File        | Leader Node |
| ----- | ---------------- | --------------- | ----------- |
| 1     | keys [0-1000)     wal_shard_1.log | Node A       |
| 2     | keys [1000-2000) | wal_shard_2.log | Node B      |
| 3     | keys [2000-3000) | wal_shard_3.log | Node C      |


Each WAL is replicated and managed by its own mini-consensus group (like Raft).

This design is called **Multi-Raft** - and is used in **CockroachDB**, **TiDB**, and **YugabyteDB**.

---

### **4. Example: Multi-Raft in Action**

Let’s visualize it:

```
Shard 1: Keys 0–1000
   A(Leader)
   /     \
  B       C

Shard 2: Keys 1000–2000
   B(Leader)
   /     \
  A       C

Shard 3: Keys 2000–3000
   C(Leader)
   /     \
  A       B
```

Each shard’s WAL operates independently:

* Writes to shard 1 only affect `wal_1`
* Writes to shard 2 affect `wal_2`

This allows **parallel replication and recovery**.

If Node B fails, only the shards it leads are impacted.

---

### **5. Global Transactions and Distributed WAL Coordination**

Now comes the tricky part - what if a transaction touches **multiple shards**?

Example:

```sql
BEGIN;
UPDATE accounts SET balance = balance - 100 WHERE id = 42;   -- Shard 1
UPDATE accounts SET balance = balance + 100 WHERE id = 900;   -- Shard 2
COMMIT;
```

This is a **distributed transaction** - and the WAL needs to ensure atomicity across multiple logs.

That’s where **two-phase commit (2PC)** and **timestamp ordering** protocols come in.

---

### **6. Two-Phase Commit (2PC) and WAL**

2PC ensures that either *all* shards commit or *none* do.
It works as follows:

#### Step 1: Prepare Phase

* Coordinator sends “prepare” to all shards.
* Each shard appends a “prepare” record to its WAL and replies “ready”.

#### Step 2: Commit Phase

* If all shards are ready, coordinator sends “commit”.
* Each shard appends a “commit” record to WAL and applies the transaction.

**Example WAL Entries:**

| Shard | WAL Entries                 |
| ----- | --------------------------- |
| 1     | prepare(tx42), commit(tx42) |
| 2     | prepare(tx42), commit(tx42) |

If a crash happens mid-way, the WAL tells each shard exactly what phase it was in - ensuring recovery consistency.

---

### **7. Global Timestamps and WAL Ordering**

Some modern databases, like **Google Spanner**, avoid traditional 2PC by assigning **globally synchronized timestamps** using atomic clocks and GPS.

Each transaction gets a unique commit timestamp `Tcommit`, and WAL entries are ordered accordingly.

**Spanner WAL Structure (simplified):**

```
Tcommit=10001: UPDATE accounts SET balance=...
Tcommit=10002: INSERT INTO transfers ...
```

Because every node’s clock is synchronized within microseconds, Spanner can ensure that:

* All replicas agree on commit order
* Reads at timestamp T see a consistent snapshot

This turns WAL into a **time-ordered global log**.

---

### **8. WAL and Snapshot Isolation**

Many distributed databases provide **Snapshot Isolation (SI)** or **Serializable Isolation**.

They use WAL + MVCC (multi-version concurrency control):

* Each write appends a new version to WAL
* Readers can choose a consistent timestamp
* No global locking is needed

**Example:**

| Version | Key | Value | CommitTS |
| ------- | --- | ----- | -------- |
| v1      | x   | 10    | 1001     |
| v2      | x   | 12    | 1005     |

A read at T=1002 sees v1.
A read at T=1006 sees v2.

WAL entries store both value and version metadata.

---

### **9. Recovery Across Nodes**

In distributed systems, recovery means two things:

1. **Local recovery:** replay local WAL to restore node’s last known state.
2. **Global recovery:** reconcile with cluster to ensure no stale commits.

Steps during node restart:

1. Node replays its WAL → rebuilds local store.
2. Node contacts peers → requests missing entries (log catch-up).
3. Consensus layer ensures log alignment.
4. Node rejoins replication group safely.

This process guarantees both **durability** and **consistency**.

---

### **10. Checkpoints and Compaction in Distributed Systems**

Just like single-node WALs, distributed logs grow indefinitely.

Hence, each shard periodically:

* Takes a **snapshot**
* Stores the latest applied index
* Truncates logs up to that point

Example:

```
snapshot_at_index=5000
truncate WAL <= 5000
```

For distributed consistency, all nodes in the group must agree on truncation boundaries.

In Raft:

```text
InstallSnapshot RPC
```

transfers the snapshot to lagging followers to catch them up efficiently.

---

### **11. Real Systems: How They Use Distributed WALs**

| System             | WAL Type                       | Consensus | Notes                          |
| ------------------ | ------------------------------ | --------- | ------------------------------ |
| **Google Spanner** | Global WAL (timestamp ordered) | Paxos     | True global consistency        |
| **CockroachDB**    | Multi-Raft WALs                | Raft      | SQL on key-value store         |
| **TiDB**           | Region-based WAL               | Raft      | Each “region” has its own log  |
| **YugabyteDB**     | Tablet WAL                     | Raft      | Compatible with PostgreSQL     |
| **MongoDB**        | Oplog (logical WAL)            | Raft-like | Eventual or strong consistency |
| **FoundationDB**   | Deterministic Global Log       | Custom    | Centralized log replication    |

Let’s look at two examples in more depth.

---

### **12. Example 1: CockroachDB’s Distributed WAL Design**

CockroachDB runs a Raft consensus group per range.

* Each range = independent WAL
* Range leaders replicate logs to followers
* The KV store (RocksDB) persists them locally

When you run:

```sql
INSERT INTO users VALUES (1, 'Alice');
```

It becomes a Raft log entry in a specific range’s WAL.

CockroachDB guarantees **linearizable consistency** because each Raft log represents a serial history of operations for its range.

**Recovery:** If a leader crashes, followers’ WALs elect a new leader and resume from last committed index.

---

### **13. Example 2: Google Spanner’s TrueTime + WAL**

Spanner maintains a **globally consistent WAL** across continents using atomic clocks.

Each mutation:

1. Is assigned a timestamp `t`
2. Replicated via Paxos
3. Committed when majority acknowledges
4. Applied in timestamp order

Diagram:

```
Clients ---> Leaders ---> Paxos Replicas ---> Global WAL
         (assign t)       (commit)           (apply in order)
```

This gives **serializability** with **no central coordinator**, thanks to globally synchronized clocks.

---

### **14. Challenges in Distributed WALs**

Distributed WALs are complex due to:

| Challenge                  | Description                                              |
| -------------------------- | -------------------------------------------------------- |
| **Network Partition**      | Some nodes unreachable - consensus required              |
| **Clock Skew**             | Causes misordered commits without proper synchronization |
| **Log Divergence**         | Crashed nodes may have partial logs                      |
| **Rebalancing**            | Moving shards = moving WAL ownership                     |
| **Latency vs Consistency** | Global ordering can slow writes                          |

Most systems balance these via tunable consistency levels.

---

### **15. Visual Summary: Layers of a Distributed Database**

```
          ┌───────────────────────────┐
          │ Application / SQL Layer   │
          └────────────┬──────────────┘
                       │
          ┌────────────▼──────────────┐
          │ Transaction Coordinator   │
          └────────────┬──────────────┘
                       │
          ┌────────────▼──────────────┐
          │ Consensus / Raft Groups   │  → distributed WALs
          └────────────┬──────────────┘
                       │
          ┌────────────▼──────────────┐
          │ Local Storage Engines     │  → local WAL
          └───────────────────────────┘
```

Each layer extends the previous one - from local WAL to global durability.

---

### **16. The Future: Global Logs Beyond Databases**

The concept of WAL-based consensus isn’t limited to databases.
Modern systems like **Kafka**, **Pulsar**, and **Redpanda** use distributed logs as their *primary abstraction*.

* Kafka topics = distributed WALs for event streaming
* Etcd = distributed WAL for configuration
* Temporal.io = distributed WAL for workflow state

WAL has evolved from a recovery mechanism into a **core synchronization primitive** for the distributed world.

---

### **17. Recap: The Journey of WAL**

| Stage                    | Use of WAL                     |
| ------------------------ | ------------------------------ |
| **Single Node**          | Crash recovery                 |
| **Replicated Cluster**   | Log-based replication          |
| **Consensus System**     | Agreement on log order         |
| **Distributed Database** | Coordinated global commit      |
| **Global Database**      | Time-synchronized WAL ordering |

From a humble recovery tool, WAL has become the **heartbeat of distributed consistency**.

---

### **18. Closing Thoughts**

In distributed databases, WAL isn’t just a *local crash log* - it’s the **unifying thread** connecting:

* Replication
* Consensus
* Transactions
* Global ordering

Each layer builds upon it to deliver **durability, atomicity, and consistency** across space and time.

When you look at a distributed system, beneath the complex machinery of shards, leaders, clocks, and consensus, there is always one quiet hero -
the **Write-Ahead Log**,
faithfully recording the world, one entry at a time.

