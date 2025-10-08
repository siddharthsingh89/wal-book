# The WAL Book

**The WAL Book** is a beginner-friendly, practical guide to understanding **Write-Ahead Logging (WAL)**-one of the core mechanisms that make modern databases durable and crash-resilient.

This book explains the **core concepts**, **architecture**, and **implementation techniques** of WAL with clear diagrams, examples, and code snippets (in Rust and pseudocode).  
It is built using [mdBook](https://github.com/rust-lang/mdBook).

View it [here](https://siddharthsingh89.github.io/wal-book/)
---

##  Prerequisites

Before you start, make sure you have the following installed:

- [Rust](https://www.rust-lang.org/tools/install)
- [mdBook](https://rust-lang.github.io/mdBook/guide/installation.html)

You can install mdBook using Cargo:

```powershell
cargo install mdbook
```

### Building the Book (Windows)

Run the following commands in PowerShell or Command Prompt:

```
mdbook build
```

### To start a local server (auto reload on edits):
```
mdbook serve
```

Then open http://localhost:3000  in your browser.


## License

This project is licensed under the MIT License.
