## Chapter 14: Replication & Consensus

### **Introduction**

When databases grow beyond a single machine, **durability and correctness** become a team sport.
A single crash can be recovered using WAL, but what happens when your database runs across **multiple machines**?

How do all replicas agree on *which transactions were committed*?
How do we ensure that a follower node doesn’t replay half-written data?
And how do we make sure that every replica applies the same log entries in the same order?

These questions are answered by the combination of **Write-Ahead Logs (WAL)** and **Consensus Protocols** like **Raft**, **Paxos**, or **ZAB** (used by ZooKeeper).

Replication + Consensus = *Durability & Availability across machines*.

---

## **1. The Journey from Single Node to Distributed WAL**

Let’s recall how WAL works in a single node:

```
+--------------------+
|  User Transaction  |
+--------------------+
          |
          v
  +------------------+
  | Write to WAL Log |   (sequential disk write)
  +------------------+
          |
          v
  +------------------+
  | Update Data Page |
  +------------------+
```

When power fails, we recover from WAL by replaying committed transactions.

But in a **distributed setup**, we want *multiple replicas* to have the same log - so that if one node dies, another can take over.

This requires **replication of WAL entries**.

---

## **2. Replicating the WAL**

In distributed databases like **PostgreSQL**, **MongoDB**, **CockroachDB**, and **Etcd**, replication happens at the **log level**.

Instead of sending the final data pages, the system sends **WAL entries** - the smallest, most atomic units of change.

This makes replication:

* **Lightweight** (logs are small)
* **Deterministic** (everyone replays the same sequence)
* **Efficient** (sequential write + sequential replay)

### Example: Log Replication Timeline

| Time | Leader (Node A)                  | Follower (Node B) |
| ---- | -------------------------------- | ----------------- |
| T1   | Receives `UPDATE x=5`            |                   |
| T2   | Appends to WAL: `log[1] = "x=5"` |                   |
| T3   | Sends log[1] to follower         | Receives log[1]   |
| T4   | Both mark log[1] as committed    | Replays to data   |

After this, both nodes have:

```
WAL = [log1: x=5]
Data = x=5
```

Thus, replication ensures *consistency* and *fault tolerance*.

---

## **3. Synchronous vs Asynchronous Replication**

Replication can occur in different modes:

| Type                   | Description                                   | Tradeoff                                   |
| ---------------------- | --------------------------------------------- | ------------------------------------------ |
| **Synchronous**        | Leader waits until all replicas confirm write | Safer but slower                           |
| **Asynchronous**       | Leader commits locally, sends later           | Faster but may lose data if leader crashes |
| **Semi-sync (Hybrid)** | Wait for at least one replica                 | Middle ground                              |

Example in PostgreSQL:

```sql
synchronous_commit = on
```

ensures the transaction waits until at least one standby writes WAL to disk.

---

### **Diagram: WAL Replication Modes**

```
User ----> Leader WAL ----> Follower WAL
            |                    |
         Commit wait         Commit async
```

Synchronous = strong consistency
Asynchronous = eventual consistency

---

## **4. The Need for Consensus**

Simple replication works well - until the leader crashes.

Imagine three nodes: A, B, C.
A is the leader. It appends a new WAL entry (`log[5]`), sends it to B and C, but crashes before committing.

Now who decides if `log[5]` is valid?

If B and C disagree, we risk **split-brain** - where two leaders think they are correct.

That’s where **consensus protocols** like **Raft** and **Paxos** come in.

They ensure:

1. All nodes agree on the same WAL order.
2. No committed log entry is lost.
3. Only one leader can exist at a time.

---

## **5. WAL + Raft: A Simple Analogy**

Think of Raft as a **distributed WAL controller**.

Each Raft node maintains a **replicated log**.
Every client command becomes a **log entry**, replicated to all nodes before it’s committed.

```
Client Command -> Log Entry -> Append to WAL on all replicas -> Commit
```

### **Raft Log Example**

| Index | Term | Command    | State     |
| ----- | ---- | ---------- | --------- |
| 1     | 1    | `SET x=5`  | Committed |
| 2     | 1    | `SET y=10` | Committed |
| 3     | 2    | `DELETE y` | Pending   |

Each node’s WAL might look like:

```
Node A WAL: [1, 2, 3]
Node B WAL: [1, 2]
Node C WAL: [1, 2, 3]
```

Once a majority (2/3) of nodes acknowledge entry 3 → it’s **committed**.

Then all replicas replay it in order.

---

### **Diagram: Raft Commit Flow**

```
Client
   |
   v
+----------+
|  Leader  |---- AppendEntries ---> [Follower 1]
| (WAL Log)|---- AppendEntries ---> [Follower 2]
+----------+
       |
       +--> Commit if majority ack
```

---

## **6. Log Matching & Term Rules**

Raft ensures safety using **two key rules**:

1. **Log Matching Property**
   If two logs have the same index and term, their entire prefix is identical.
   → Prevents divergent history.

2. **Leader Completeness Property**
   A newly elected leader must contain all committed entries.

These rules ensure that WALs never “fork” or contain partial transactions.

---

## **7. Leader Election**

When a node crashes, others detect a timeout and hold an **election**.

Each node:

1. Increments its term
2. Votes for itself
3. Requests votes from others
4. First to reach majority becomes the **leader**

Once a leader is elected, it resumes WAL replication from the last known index.

### **Diagram: Election Timeline**

```
[A] --crash--> [B,C] start election
[B] term=3 votes=2 --> new leader
[C] term=3 follows B
```

Then replication continues from `lastLogIndex`.

---

## **8. Checkpoints and Snapshots in Distributed WAL**

As the WAL grows, keeping all entries forever is expensive.

To solve this, systems periodically take **snapshots** or **checkpoints**, truncating old logs that are already applied everywhere.

Example:

```
WAL: [1..10000]
Snapshot: State after log 10000
Truncate logs <= 10000
```

On recovery, a node loads the latest snapshot, then replays newer WAL entries.

---

## **9. How Consensus Prevents Split-Brain**

Let’s revisit the crash scenario:

* Node A (leader) had WAL up to entry #5
* Node B, C had entries up to #4

A crashes before committing #5.

Without consensus, B might become leader and commit different #5.
Now, A and B have divergent WALs → **split-brain**.

Raft prevents this:

* New leader election requires **majority agreement**.
* Majority never acknowledged #5 → new leader’s log excludes it.
* When A rejoins, it **rolls back** entry #5 to match majority.

Thus, WALs converge to a single, agreed-upon sequence.

---

## **10. Real-World Implementations**

| System          | Consensus              | WAL Layer             | Notes                     |
| --------------- | ---------------------- | --------------------- | ------------------------- |
| **Etcd**        | Raft                   | BoltDB WAL            | Key-value store for k8s   |
| **CockroachDB** | Raft                   | RocksDB WAL           | Distributed SQL database  |
| **TiDB**        | Raft                   | Custom WAL            | Multi-raft per region     |
| **PostgreSQL**  | None (primary/standby) | Physical WAL shipping | Optional synchronous mode |
| **MongoDB**     | Custom (Raft-like)     | Oplog (logical WAL)   | High availability         |

---

### Example: PostgreSQL Streaming Replication

Postgres replicates *WAL segments* over TCP using a background process (`walsender` → `walreceiver`).

```
Primary (WAL Writer) ---> Standby (WAL Receiver)
      write WAL                store and replay
```

Command to check replication status:

```sql
SELECT * FROM pg_stat_replication;
```

This form of replication is *physical* - byte-for-byte log shipping.
Systems like MongoDB use *logical replication* (replicating operations instead).

---

## **11. Summary: WAL as the Foundation of Distributed Consensus**

At this point, we can summarize the key takeaways:

| Concept     | Description                               |
| ----------- | ----------------------------------------- |
| WAL         | Source of truth for state changes         |
| Replication | Copies WAL to other nodes                 |
| Consensus   | Ensures all replicas agree on WAL order   |
| Checkpoint  | Compact form of stable state              |
| Recovery    | Reapply committed WAL entries after crash |

Together, these ensure that no matter which node fails, the system can **recover**, **agree**, and **continue**.

---

## **12. Mini Example: A Raft-Like WAL Simulation**

Let’s simulate a mini system in pseudocode:

```python
class Node:
    def __init__(self):
        self.log = []
        self.commit_index = 0

    def append(self, entry):
        self.log.append(entry)

    def replicate_to(self, peers):
        for p in peers:
            p.log = self.log.copy()

    def commit(self):
        self.commit_index = len(self.log)

# Leader appends and replicates
leader = Node()
f1, f2 = Node(), Node()

leader.append("SET x=10")
leader.replicate_to([f1, f2])
leader.commit()

print(f1.log, f2.log)
```

Output:

```
['SET x=10'] ['SET x=10']
```

This is the essence of replication - distributed agreement on log entries.

---

## **13. Visual Recap: WAL + Consensus = Reliability**

```
[ Client ]
    |
    v
[ Leader ]
   |
   +--> Append to WAL
   +--> Replicate to followers
   +--> Wait for majority ACK
   |
   +--> Commit
   |
   +--> Apply to state machine
```

When any node crashes:

* WAL ensures *no local data is lost*
* Consensus ensures *no global order is broken*

---

## **14. Closing Thoughts**

In single-node databases, WAL protects against **crashes**.
In distributed systems, it protects against **disagreement**.

Replication spreads the WAL.
Consensus ensures *everyone sees it the same way*.

In the next chapter, we’ll explore how distributed databases like **CockroachDB**, **Spanner**, and **Etcd** extend these ideas - combining WAL, replication, and consensus into **globally consistent transactional systems**.

---