// Populate the sidebar
//
// This is a script, and not included directly in the page, to control the total size of the book.
// The TOC contains an entry for each page, so if each page includes a copy of the TOC,
// the total size of the page becomes O(n**2).
class MDBookSidebarScrollbox extends HTMLElement {
    constructor() {
        super();
    }
    connectedCallback() {
        this.innerHTML = '<ol class="chapter"><li class="chapter-item expanded "><a href="preface.html"><strong aria-hidden="true">1.</strong> Preface</a></li><li class="chapter-item expanded "><a href="part1_intro.html"><strong aria-hidden="true">2.</strong> Part I: Foundations of Write-Ahead Logging</a></li><li><ol class="section"><li class="chapter-item expanded "><a href="ch1_intro_to_durability.html"><strong aria-hidden="true">2.1.</strong> Chapter 1 : Introduction to Data Durability</a></li><li class="chapter-item expanded "><a href="ch2_core_idea.html"><strong aria-hidden="true">2.2.</strong> Chapter 2 : The Core Idea of WAL</a></li><li class="chapter-item expanded "><a href="ch3_architecture.html"><strong aria-hidden="true">2.3.</strong> Chapter 3 : WAL Architecture and Components</a></li></ol></li><li class="chapter-item expanded "><a href="part2_implementation.html"><strong aria-hidden="true">3.</strong> Part II: Implementing WAL</a></li><li><ol class="section"><li class="chapter-item expanded "><a href="ch4_design.html"><strong aria-hidden="true">3.1.</strong> Chapter 4 : Designing a Minimal WAL</a></li><li class="chapter-item expanded "><a href="ch4_design_csharp.html"><strong aria-hidden="true">3.2.</strong> Chapter 4.1 : Designing a Minimal WAL in C#</a></li><li class="chapter-item expanded "><a href="ch5_recovery.html"><strong aria-hidden="true">3.3.</strong> Chapter 5 : Crash Recovery</a></li><li class="chapter-item expanded "><a href="ch6_checkpoint.html"><strong aria-hidden="true">3.4.</strong> Chapter 6 : Checkpointing and Log Compaction</a></li><li class="chapter-item expanded "><a href="ch7_concurrency.html"><strong aria-hidden="true">3.5.</strong> Chapter 7 : Concurrency and WAL</a></li><li class="chapter-item expanded "><a href="ch8_rust_project.html"><strong aria-hidden="true">3.6.</strong> Chapter 8 : Building a WAL in Rust</a></li></ol></li><li class="chapter-item expanded "><a href="part3_real_world.html"><strong aria-hidden="true">4.</strong> Part III: WAL in Real Databases</a></li><li><ol class="section"><li class="chapter-item expanded "><a href="ch9_postgres.html"><strong aria-hidden="true">4.1.</strong> PostgreSQL WAL</a></li><li class="chapter-item expanded "><a href="ch10_sqlite.html"><strong aria-hidden="true">4.2.</strong> SQLite WAL Mode</a></li><li class="chapter-item expanded "><a href="ch11_innodb.html"><strong aria-hidden="true">4.3.</strong> InnoDB Redo/Undo</a></li><li class="chapter-item expanded "><a href="ch12_rocksdb.html"><strong aria-hidden="true">4.4.</strong> RocksDB WAL</a></li><li class="chapter-item expanded "><a href="ch13_lmdb.html"><strong aria-hidden="true">4.5.</strong> LMDB and Embedded Systems</a></li></ol></li><li class="chapter-item expanded "><a href="part4_distributed.html"><strong aria-hidden="true">5.</strong> Part IV: WAL in Distributed Systems</a></li><li><ol class="section"><li class="chapter-item expanded "><a href="ch14_raft.html"><strong aria-hidden="true">5.1.</strong> Replication &amp; Consensus</a></li><li class="chapter-item expanded "><a href="ch15_distributed_dbs.html"><strong aria-hidden="true">5.2.</strong> Distributed Databases</a></li></ol></li><li class="chapter-item expanded "><a href="part5_advanced.html"><strong aria-hidden="true">6.</strong> Part V: Advanced Topics</a></li><li><ol class="section"><li class="chapter-item expanded "><a href="ch16_performance.html"><strong aria-hidden="true">6.1.</strong> Performance Optimizations</a></li><li class="chapter-item expanded "><a href="ch17_debugging.html"><strong aria-hidden="true">6.2.</strong> Debugging &amp; Visualization</a></li><li class="chapter-item expanded "><a href="ch18_modern_engines.html"><strong aria-hidden="true">6.3.</strong> Modern Storage Engines</a></li></ol></li><li class="chapter-item expanded "><a href="appendices.html"><strong aria-hidden="true">7.</strong> Appendices</a></li><li class="chapter-item expanded "><a href="author_note.html"><strong aria-hidden="true">8.</strong> Author&#39;s note</a></li></ol>';
        // Set the current, active page, and reveal it if it's hidden
        let current_page = document.location.href.toString().split("#")[0].split("?")[0];
        if (current_page.endsWith("/")) {
            current_page += "index.html";
        }
        var links = Array.prototype.slice.call(this.querySelectorAll("a"));
        var l = links.length;
        for (var i = 0; i < l; ++i) {
            var link = links[i];
            var href = link.getAttribute("href");
            if (href && !href.startsWith("#") && !/^(?:[a-z+]+:)?\/\//.test(href)) {
                link.href = path_to_root + href;
            }
            // The "index" page is supposed to alias the first chapter in the book.
            if (link.href === current_page || (i === 0 && path_to_root === "" && current_page.endsWith("/index.html"))) {
                link.classList.add("active");
                var parent = link.parentElement;
                if (parent && parent.classList.contains("chapter-item")) {
                    parent.classList.add("expanded");
                }
                while (parent) {
                    if (parent.tagName === "LI" && parent.previousElementSibling) {
                        if (parent.previousElementSibling.classList.contains("chapter-item")) {
                            parent.previousElementSibling.classList.add("expanded");
                        }
                    }
                    parent = parent.parentElement;
                }
            }
        }
        // Track and set sidebar scroll position
        this.addEventListener('click', function(e) {
            if (e.target.tagName === 'A') {
                sessionStorage.setItem('sidebar-scroll', this.scrollTop);
            }
        }, { passive: true });
        var sidebarScrollTop = sessionStorage.getItem('sidebar-scroll');
        sessionStorage.removeItem('sidebar-scroll');
        if (sidebarScrollTop) {
            // preserve sidebar scroll position when navigating via links within sidebar
            this.scrollTop = sidebarScrollTop;
        } else {
            // scroll sidebar to current active section when navigating via "next/previous chapter" buttons
            var activeSection = document.querySelector('#sidebar .active');
            if (activeSection) {
                activeSection.scrollIntoView({ block: 'center' });
            }
        }
        // Toggle buttons
        var sidebarAnchorToggles = document.querySelectorAll('#sidebar a.toggle');
        function toggleSection(ev) {
            ev.currentTarget.parentElement.classList.toggle('expanded');
        }
        Array.from(sidebarAnchorToggles).forEach(function (el) {
            el.addEventListener('click', toggleSection);
        });
    }
}
window.customElements.define("mdbook-sidebar-scrollbox", MDBookSidebarScrollbox);
