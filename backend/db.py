import os
import sqlite3
import time
from pathlib import Path

DB_PATH = Path(os.environ.get("CODEBOOK_DB_PATH", Path(__file__).parent / "data" / "codebook.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    avatar_color TEXT DEFAULT '#0071E3',
    avatar_url TEXT DEFAULT '',
    provider TEXT DEFAULT 'local',
    provider_id TEXT DEFAULT '',
    role TEXT NOT NULL DEFAULT 'user',
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS build_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'guest',
    user_name TEXT DEFAULT '',
    user_email TEXT DEFAULT '',
    institution_name TEXT DEFAULT '',
    team_name TEXT DEFAULT '',
    engine TEXT NOT NULL DEFAULT 'chrome',
    page_count INTEGER NOT NULL DEFAULT 0,
    render_duration_ms INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'success',
    error_message TEXT DEFAULT '',
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_build_logs_created_at ON build_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_build_logs_user_id ON build_logs(user_id);

CREATE TABLE IF NOT EXISTS institutions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    short_name TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'approved',
    use_count INTEGER NOT NULL DEFAULT 0,
    build_count INTEGER NOT NULL DEFAULT 0,
    workspace_count INTEGER NOT NULL DEFAULT 0,
    suggested_by TEXT DEFAULT '',
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_institutions_status_counts ON institutions(status, build_count DESC, workspace_count DESC);

CREATE TABLE IF NOT EXISTS institution_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'guest',
    user_name TEXT DEFAULT '',
    institution_name TEXT NOT NULL,
    team_name TEXT DEFAULT '',
    action TEXT NOT NULL DEFAULT 'type',
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS site_visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visitor_id TEXT NOT NULL,
    user_id TEXT NOT NULL DEFAULT 'guest',
    ip_hash TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    device_type TEXT NOT NULL DEFAULT 'desktop',
    path TEXT NOT NULL DEFAULT '/',
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_site_visits_created_at ON site_visits(created_at);
CREATE INDEX IF NOT EXISTS idx_site_visits_visitor_id ON site_visits(visitor_id);

CREATE TABLE IF NOT EXISTS topics (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL DEFAULT 'guest',
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER,
    PRIMARY KEY (id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_topics_user_order ON topics(user_id, deleted_at, sort_order);

CREATE TABLE IF NOT EXISTS snippets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'guest',
    title TEXT NOT NULL,
    subtitle TEXT DEFAULT '',
    complexity TEXT DEFAULT '',
    topic_id TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 100,
    verified INTEGER NOT NULL DEFAULT 0,
    tested_on TEXT DEFAULT '',
    code TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    formulas TEXT NOT NULL DEFAULT '[]',
    language TEXT NOT NULL DEFAULT 'cpp',
    kind TEXT NOT NULL DEFAULT 'code',
    deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_snippets_lookup ON snippets(user_id, topic_id, deleted_at, sort_order);
CREATE INDEX IF NOT EXISTS idx_snippets_user_deleted ON snippets(user_id, deleted_at);

CREATE TABLE IF NOT EXISTS settings (
    user_id TEXT NOT NULL DEFAULT 'guest',
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'guest',
    user_name TEXT DEFAULT '',
    user_email TEXT DEFAULT '',
    institution_name TEXT DEFAULT '',
    team_name TEXT DEFAULT '',
    rating INTEGER NOT NULL,
    comment TEXT DEFAULT '',
    tags TEXT DEFAULT '[]',
    is_public INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'approved',
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_rating ON reviews(rating);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status);
CREATE INDEX IF NOT EXISTS idx_reviews_created_at ON reviews(created_at);

CREATE TABLE IF NOT EXISTS codebook_snapshots (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'guest',
    user_type TEXT NOT NULL DEFAULT 'guest',
    user_name TEXT DEFAULT '',
    user_email TEXT DEFAULT '',
    institution_name TEXT DEFAULT '',
    team_name TEXT DEFAULT '',
    book_title TEXT DEFAULT 'Contest Codebook',
    page_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    created_at_iso TEXT NOT NULL,
    content_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_team ON codebook_snapshots(institution_name, team_name);
CREATE INDEX IF NOT EXISTS idx_snapshots_user ON codebook_snapshots(user_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_created ON codebook_snapshots(created_at);
"""

DEFAULT_TOPICS = [
    ("data-structures", "Data Structures", "#1D9E75", 10),
    ("graph", "Graph", "#378ADD", 20),
    ("dp", "Dynamic Programming", "#7F77DD", 30),
    ("string", "String", "#D4537E", 40),
    ("number-theory", "Number Theory", "#BA7517", 50),
]

DEFAULT_BOILERPLATE_CODE = """#include <bits/stdc++.h>
using namespace std;

// High-speed competitive programming I/O
#define FAST_IO ios_base::sync_with_stdio(false); cin.tie(NULL);

using ll = long long;
using ld = long double;
const ll INF = 1e18;
const int MOD = 1e9 + 7;

void solve() {
    // Write your contest solution here
}

int main() {
    FAST_IO;
    int t = 1;
    // cin >> t;
    while (t--) {
        solve();
    }
    return 0;
}
"""

DEFAULT_SNIPPETS = [
    dict(
        title="Guide: Markdown Notes & Reference Cards",
        subtitle="How to write formulas, edge-case checklists & notes",
        complexity="Card Guide",
        topic_id="data-structures",
        sort_order=5,
        verified=1,
        kind="note",
        notes="""### How to Use Reference Cards & Notes
* **What are Note Cards?** Note cards let you store theoretical formulas, edge-case checklists, and algorithm cheat-sheets directly in your codebook.
* **Markdown Formatting:** Write in clean markdown with **bold**, *italics*, bulleted checklists, and code snippets.
* **Math Formulas:** Supports mathematical notations like $O(N \\log N)$, $\\sum_{i=1}^n i = \\frac{n(n+1)}{2}$, and modular equations.
* **Card Themes:** Switch between **Craft.do** (clean, tactile), **IDE Window** (macOS terminal styling), and **Academic** (IEEE monograph) in the Styles tab!""",
    ),
    dict(
        title="Segment tree",
        subtitle="Range sum, point update",
        complexity="O(log n)",
        topic_id="data-structures",
        sort_order=10,
        verified=1,
        kind="code",
        language="cpp",
        code="""struct SegTree {
  int n; vector<ll> t;
  SegTree(int n): n(n), t(4*n) {}
  void upd(int p,int v,int x,int lo,int hi){
    if(lo==hi){ t[x]=v; return; }
    int m=(lo+hi)/2;
    p<=m ? upd(p,v,2*x,lo,m)
         : upd(p,v,2*x+1,m+1,hi);
    t[x]=t[2*x]+t[2*x+1];
  }
  ll qry(int l,int r,int x,int lo,int hi){
    if(r<lo||hi<l) return 0;
    if(l<=lo&&hi<=r) return t[x];
    int m=(lo+hi)/2;
    return qry(l,r,2*x,lo,m)+qry(l,r,2*x+1,m+1,hi);
  }
};""",
    ),
    dict(
        title="DSU",
        subtitle="Union by size, path compression",
        complexity="O(a(n))",
        topic_id="data-structures",
        sort_order=20,
        verified=1,
        kind="code",
        language="cpp",
        code="""struct DSU {
  vector<int> p, sz;
  DSU(int n): p(n), sz(n,1) {
    iota(p.begin(),p.end(),0);
  }
  int find(int x){
    return p[x]==x ? x : p[x]=find(p[x]);
  }
  bool unite(int a,int b){
    a=find(a); b=find(b);
    if(a==b) return false;
    if(sz[a]<sz[b]) swap(a,b);
    p[b]=a; sz[a]+=sz[b];
    return true;
  }
};""",
    ),
    dict(
        title="Contest Checklist & Edge Cases",
        subtitle="Pre-submit sanity checks & common traps",
        complexity="Cheat-Sheet",
        topic_id="data-structures",
        sort_order=30,
        verified=1,
        kind="note",
        notes="""### Pre-Submit Sanity Checklist
* **Integer Overflow:** Check if $N \\cdot M$ or running sum exceeds $2 \\cdot 10^9$. Use `1LL << k`, cast `1LL * a * b % MOD`.
* **Array Bounds:** 1-indexed vs 0-indexed vectors; verify max bounds (e.g. $N \\le 2 \\cdot 10^5$).
* **Graph Traps:** Disconnected graph, multiple edges between same pair, self-loops, $N = 1$ or empty components.
* **Floating Point:** Use `1e-9` epsilon tolerance; avoid direct `==` with `double`.
* **Interactive Problems:** Always flush output with `cout << endl;` or `cout.flush();`.""",
    ),
    dict(
        title="Anti-Hash Defense (splitmix64)",
        subtitle="Safe custom hash for unordered_map",
        complexity="O(1)",
        topic_id="data-structures",
        sort_order=40,
        verified=1,
        kind="code",
        language="cpp",
        code="""struct custom_hash {
  static uint64_t splitmix64(uint64_t x) {
    x += 0x9e3779b97f4a7c15;
    x = (x ^ (x >> 30)) * 0xbf58476d1ce4e5b9;
    x = (x ^ (x >> 27)) * 0x94d049bb133111eb;
    return x ^ (x >> 31);
  }
  size_t operator()(uint64_t x) const {
    static const uint64_t FIXED_RANDOM =
      chrono::steady_clock::now().time_since_epoch().count();
    return splitmix64(x + FIXED_RANDOM);
  }
};
// unordered_map<long long, int, custom_hash> safe_map;""",
    ),
    dict(
        title="Dijkstra",
        subtitle="Single source shortest path, non-negative weights",
        complexity="O((V+E) log V)",
        topic_id="graph",
        sort_order=10,
        verified=1,
        kind="code",
        language="cpp",
        code="""vector<ll> dijkstra(int src, vector<vector<pair<int,ll>>>& adj){
  int n = adj.size();
  vector<ll> dist(n, LLONG_MAX);
  priority_queue<pair<ll,int>, vector<pair<ll,int>>, greater<>> pq;
  dist[src]=0; pq.push({0,src});
  while(!pq.empty()){
    auto [d,u]=pq.top(); pq.pop();
    if(d>dist[u]) continue;
    for(auto [v,w]: adj[u]){
      if(dist[u]+w<dist[v]){
        dist[v]=dist[u]+w;
        pq.push({dist[v],v});
      }
    }
  }
  return dist;
}""",
    ),
    dict(
        title="Dynamic Programming Patterns",
        subtitle="Common state designs & optimization tricks",
        complexity="Cheat-Sheet",
        topic_id="dp",
        sort_order=10,
        verified=1,
        kind="note",
        notes="""* **Coordinate Compression:** Map large sparse coordinates into $[0, N)$ via `std::lower_bound`.
* **Bitmask DP:** State `dp[mask][u]` for visiting subsets of vertices ($N \\le 20$).
* **Contribution Technique:** Instead of counting valid subarrays, count how many subarrays each element $A[i]$ is min/max of via monotonic stacks.
* **Knapsack 0/1 vs Unbounded:** Reverse iteration `for (int w = W; w >= weight; --w)` for 0/1; forward iteration for unbounded.""",
    ),
    dict(
        title="KMP",
        subtitle="Pattern matching via prefix function",
        complexity="O(n + m)",
        topic_id="string",
        sort_order=10,
        verified=1,
        kind="code",
        language="cpp",
        code="""vector<int> prefix_fn(string& s){
  int n=s.size();
  vector<int> pi(n);
  for(int i=1;i<n;i++){
    int j=pi[i-1];
    while(j>0 && s[i]!=s[j]) j=pi[j-1];
    if(s[i]==s[j]) j++;
    pi[i]=j;
  }
  return pi;
}""",
    ),
    dict(
        title="Modulo Arithmetic Quick Reference",
        subtitle="Formulas, modular inverse, and prime identities",
        complexity="Math Note",
        topic_id="number-theory",
        sort_order=10,
        verified=1,
        kind="note",
        notes="""* **Addition:** $(a + b) \\pmod m = ((a \\pmod m) + (b \\pmod m)) \\pmod m$
* **Multiplication:** $(a \\cdot b) \\pmod m = ((a \\pmod m) \\cdot (b \\pmod m)) \\pmod m$
* **Modular Inverse (Prime $m$):** By Fermat's Little Theorem, $a^{m-1} \\equiv 1 \\pmod m$:
  $$a^{-1} \\equiv a^{m-2} \\pmod m$$
* **Division:** $(a / b) \\pmod m = (a \\cdot b^{m-2}) \\pmod m$
* **Modular Exponentiation:** Compute $a^b \\pmod m$ in $O(\\log b)$ via binary exponentiation.""",
    ),
]

DEFAULT_SETTINGS = {
    "team_name": "",
    "book_title": "Contest Codebook",
    "code_font": "JetBrains Mono",
    "code_theme": "nord",
    "page_size": "A4",
    "accent_color": "#2C2C2A",
    "show_team_footer": "1",
    "institution_name": "",
    "boilerplate_code": DEFAULT_BOILERPLATE_CODE,
    "show_boilerplate": "1",
    "cover_style": "sketch",
    "card_style": "craft",
    "template_accent_color": "#2C2C2A",
    "template_title": "Template",
    "snippets_after_template": "1",
}


class _RequestContextDb:
    """Wraps sqlite3.Connection during an active Flask request.
    Allows existing route code to call conn.close() safely as a no-op,
    while guaranteeing the underlying connection is closed when the request ends."""
    def __init__(self, conn):
        self._conn = conn

    def __getattr__(self, name):
        return getattr(self._conn, name)

    def close(self):
        # In request context, closing is deferred to Flask teardown
        pass

    def _force_close(self):
        try:
            self._conn.close()
        except Exception:
            pass


def get_db():
    DB_PATH.parent.mkdir(exist_ok=True)
    try:
        from flask import g, has_request_context
        if has_request_context():
            if "_database" not in g or g._database is None:
                raw_conn = sqlite3.connect(DB_PATH, timeout=30.0)
                raw_conn.row_factory = sqlite3.Row
                raw_conn.execute("PRAGMA foreign_keys = ON")
                raw_conn.execute("PRAGMA journal_mode = WAL")
                g._database = _RequestContextDb(raw_conn)
            return g._database
    except Exception:
        pass

    conn = sqlite3.connect(DB_PATH, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def _migrate(conn):
    """CREATE TABLE IF NOT EXISTS won't add new columns to existing tables.
    Migrate them dynamically to preserve existing data."""
    existing_cols = {r["name"] for r in conn.execute("PRAGMA table_info(snippets)")}
    if "user_id" not in existing_cols:
        conn.execute("ALTER TABLE snippets ADD COLUMN user_id TEXT NOT NULL DEFAULT 'guest'")
    if "notes" not in existing_cols:
        conn.execute("ALTER TABLE snippets ADD COLUMN notes TEXT NOT NULL DEFAULT ''")
    if "formulas" not in existing_cols:
        conn.execute("ALTER TABLE snippets ADD COLUMN formulas TEXT NOT NULL DEFAULT '[]'")
    if "language" not in existing_cols:
        conn.execute("ALTER TABLE snippets ADD COLUMN language TEXT NOT NULL DEFAULT 'cpp'")
    if "deleted_at" not in existing_cols:
        conn.execute("ALTER TABLE snippets ADD COLUMN deleted_at INTEGER")
    if "kind" not in existing_cols:
        conn.execute("ALTER TABLE snippets ADD COLUMN kind TEXT NOT NULL DEFAULT 'code'")

    existing_topic_cols = {r["name"] for r in conn.execute("PRAGMA table_info(topics)")}
    if "user_id" not in existing_topic_cols:
        conn.execute("ALTER TABLE topics ADD COLUMN user_id TEXT NOT NULL DEFAULT 'guest'")
    if "deleted_at" not in existing_topic_cols:
        conn.execute("ALTER TABLE topics ADD COLUMN deleted_at INTEGER")

    existing_setting_cols = {r["name"] for r in conn.execute("PRAGMA table_info(settings)")}
    if "user_id" not in existing_setting_cols:
        conn.execute("ALTER TABLE settings ADD COLUMN user_id TEXT NOT NULL DEFAULT 'guest'")

    # Ensure settings table has compound PRIMARY KEY (user_id, key)
    settings_sql = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='settings'").fetchone()
    if settings_sql and "PRIMARY KEY (user_id, key)" not in settings_sql["sql"] and "PRIMARY KEY (key, user_id)" not in settings_sql["sql"]:
        conn.execute("DROP TABLE IF EXISTS settings_v2")
        conn.execute("""
            CREATE TABLE settings_v2 (
                user_id TEXT NOT NULL DEFAULT 'guest',
                key TEXT NOT NULL,
                value TEXT,
                PRIMARY KEY (user_id, key)
            )
        """)
        conn.execute("INSERT OR IGNORE INTO settings_v2 (user_id, key, value) SELECT user_id, key, value FROM settings")
        conn.execute("DROP TABLE settings")
        conn.execute("ALTER TABLE settings_v2 RENAME TO settings")

    existing_user_cols = {r["name"] for r in conn.execute("PRAGMA table_info(users)")}
    if "role" not in existing_user_cols:
        try:
            conn.execute("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'")
        except sqlite3.OperationalError:
            pass

    for col_sql in [
        "ALTER TABLE users ADD COLUMN provider TEXT NOT NULL DEFAULT 'local'",
        "ALTER TABLE users ADD COLUMN provider_id TEXT DEFAULT ''",
        "ALTER TABLE users ADD COLUMN avatar_url TEXT DEFAULT ''",
        "ALTER TABLE build_logs ADD COLUMN institution_name TEXT DEFAULT ''",
        "ALTER TABLE build_logs ADD COLUMN team_name TEXT DEFAULT ''",
    ]:
        try:
            conn.execute(col_sql)
        except sqlite3.OperationalError:
            pass

    conn.execute("""
        CREATE TABLE IF NOT EXISTS institution_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL DEFAULT 'guest',
            user_name TEXT DEFAULT '',
            institution_name TEXT NOT NULL,
            team_name TEXT DEFAULT '',
            action TEXT NOT NULL DEFAULT 'type',
            created_at INTEGER NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS site_visits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            visitor_id TEXT NOT NULL,
            user_id TEXT NOT NULL DEFAULT 'guest',
            ip_hash TEXT NOT NULL DEFAULT '',
            user_agent TEXT NOT NULL DEFAULT '',
            device_type TEXT NOT NULL DEFAULT 'desktop',
            path TEXT NOT NULL DEFAULT '/',
            created_at INTEGER NOT NULL
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_site_visits_created_at ON site_visits(created_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_site_visits_visitor_id ON site_visits(visitor_id)")

    conn.execute("""
        CREATE TABLE IF NOT EXISTS reviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL DEFAULT 'guest',
            user_name TEXT DEFAULT '',
            user_email TEXT DEFAULT '',
            institution_name TEXT DEFAULT '',
            team_name TEXT DEFAULT '',
            rating INTEGER NOT NULL,
            comment TEXT DEFAULT '',
            tags TEXT DEFAULT '[]',
            is_public INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'approved',
            created_at INTEGER NOT NULL
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_reviews_rating ON reviews(rating)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_reviews_created_at ON reviews(created_at)")

    conn.execute("""
        CREATE TABLE IF NOT EXISTS codebook_snapshots (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL DEFAULT 'guest',
            user_type TEXT NOT NULL DEFAULT 'guest',
            user_name TEXT DEFAULT '',
            user_email TEXT DEFAULT '',
            institution_name TEXT DEFAULT '',
            team_name TEXT DEFAULT '',
            book_title TEXT DEFAULT 'Contest Codebook',
            page_count INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL,
            created_at_iso TEXT NOT NULL,
            content_json TEXT NOT NULL
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_snapshots_team ON codebook_snapshots(institution_name, team_name)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_snapshots_user ON codebook_snapshots(user_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_snapshots_created ON codebook_snapshots(created_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_topics_user_order ON topics(user_id, deleted_at, sort_order)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_snippets_lookup ON snippets(user_id, topic_id, deleted_at, sort_order)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_snippets_user_deleted ON snippets(user_id, deleted_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_build_logs_created_at ON build_logs(created_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_build_logs_user_id ON build_logs(user_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_institutions_status_counts ON institutions(status, build_count DESC, workspace_count DESC)")

    # Clean up any historic accidental partial-typed pending institutions (e.g. 'my', 'dh')
    try:
        conn.execute("DELETE FROM institutions WHERE status = 'pending' AND (length(name) < 6 OR name NOT LIKE '% %')")
        conn.execute("DELETE FROM institution_logs WHERE length(institution_name) < 4")
        # Reset legacy global 'guest' row to clean empty defaults so no stale server data leaks
        conn.execute("UPDATE settings SET value = '' WHERE user_id = 'guest' AND key IN ('institution_name', 'team_name')")
        conn.execute("UPDATE settings SET value = 'nord' WHERE user_id = 'guest' AND key = 'code_theme'")
    except Exception:
        pass
    conn.commit()


TRASH_RETENTION_SECONDS = 30 * 24 * 60 * 60  # 30 days, see P1.5
GUEST_RETENTION_SECONDS = 30 * 24 * 60 * 60  # 30 days


def purge_expired_trash(conn):
    """Hard-deletes anything that's been soft-deleted for more than 30 days.
    Called on every init_db() / trash fetch so nothing needs a cron job."""
    cutoff = int(time.time()) - TRASH_RETENTION_SECONDS
    conn.execute("DELETE FROM snippets WHERE deleted_at IS NOT NULL AND deleted_at < ?", (cutoff,))
    conn.execute("DELETE FROM topics WHERE deleted_at IS NOT NULL AND deleted_at < ?", (cutoff,))
    conn.commit()


def purge_expired_guest_workspaces(conn):
    """Prunes abandoned guest workspace drafts older than 30 days to keep the database lightweight.
    Important: Leaves all university analytics, institution_logs, site_visits, and codebook_snapshots completely intact."""
    cutoff = int(time.time()) - GUEST_RETENTION_SECONDS
    try:
        active_guests = {r[0] for r in conn.execute(
            "SELECT DISTINCT user_id FROM site_visits WHERE user_id LIKE 'guest_%' AND created_at >= ?", (cutoff,)
        ).fetchall()}

        guest_ids = [r[0] for r in conn.execute(
            "SELECT DISTINCT user_id FROM topics WHERE user_id LIKE 'guest_%'"
        ).fetchall() if r[0] not in active_guests]

        output_dir = Path(__file__).resolve().parent.parent / "output"
        for gid in guest_ids:
            conn.execute("DELETE FROM snippets WHERE user_id = ?", (gid,))
            conn.execute("DELETE FROM topics WHERE user_id = ?", (gid,))
            conn.execute("DELETE FROM settings WHERE user_id = ?", (gid,))
            try:
                guest_pdf = output_dir / f"codebook_{gid}.pdf"
                if guest_pdf.exists():
                    guest_pdf.unlink()
            except Exception:
                pass
        conn.commit()
    except Exception:
        pass


def init_db():
    conn = get_db()
    conn.executescript(SCHEMA)
    _migrate(conn)
    purge_expired_trash(conn)
    purge_expired_guest_workspaces(conn)

    # Ensure super admin emails have role='admin'
    admin_emails = (
        'ahmeds89thdoc1@gmail.com',
        'ahmeds89thdoc@gmail.com',
        'ahmeds89thdoc2@gmail.com',
        'ahmedsextraone@gmail.com',
        'admin@codebook.io',
    )
    for ae in admin_emails:
        conn.execute("UPDATE users SET role = 'admin' WHERE email = ?", (ae,))

    row = conn.execute("SELECT COUNT(*) c FROM topics WHERE user_id = 'guest'").fetchone()
    if row["c"] == 0:
        for t_id, name, color, sort_order in DEFAULT_TOPICS:
            conn.execute(
                "INSERT OR IGNORE INTO topics (id, user_id, name, color, sort_order) VALUES (?, 'guest', ?, ?, ?)",
                (t_id, name, color, sort_order),
            )
        for s in DEFAULT_SNIPPETS:
            conn.execute(
                """INSERT INTO snippets
                   (user_id, title, subtitle, complexity, topic_id, sort_order, verified, tested_on, code, notes, formulas, language, kind)
                   VALUES ('guest', ?, ?, ?, ?, ?, 1, '', ?, ?, ?, ?, ?)""",
                (s["title"], s.get("subtitle", ""), s.get("complexity", ""), s["topic_id"],
                 s.get("sort_order", 100), s.get("code", ""), s.get("notes", ""),
                 s.get("formulas", "[]"), s.get("language", "cpp"), s.get("kind", "code")),
            )

    # Seed default settings for guest
    for key, value in DEFAULT_SETTINGS.items():
        conn.execute(
            "INSERT OR IGNORE INTO settings (user_id, key, value) VALUES ('guest', ?, ?)",
            (key, value),
        )
    # Ensure guest boilerplate_code has DEFAULT_BOILERPLATE_CODE if empty
    bp_row = conn.execute("SELECT value FROM settings WHERE user_id = 'guest' AND key = 'boilerplate_code'").fetchone()
    if not bp_row or not (bp_row["value"] or "").strip():
        conn.execute(
            "INSERT OR REPLACE INTO settings (user_id, key, value) VALUES ('guest', 'boilerplate_code', ?)",
            (DEFAULT_BOILERPLATE_CODE,),
        )

    # Ensure sample notes and template snippets are present for guest AND all registered users
    all_users = ["guest"] + [r["id"] for r in conn.execute("SELECT id FROM users").fetchall()]
    for uid in all_users:
        for s in DEFAULT_SNIPPETS:
            if s.get("kind") == "note" or "splitmix" in s.get("title", "").lower():
                exists = conn.execute(
                    "SELECT 1 FROM snippets WHERE user_id = ? AND title = ? AND deleted_at IS NULL",
                    (uid, s["title"])
                ).fetchone()
                if not exists:
                    top_row = conn.execute(
                        "SELECT id FROM topics WHERE user_id = ? AND (id = ? OR id = ?) AND deleted_at IS NULL",
                        (uid, s["topic_id"], f"{uid}_{s['topic_id']}")
                    ).fetchone()
                    first_top = conn.execute("SELECT id FROM topics WHERE user_id = ? AND deleted_at IS NULL LIMIT 1", (uid,)).fetchone()
                    target_top_id = top_row["id"] if top_row else (first_top["id"] if first_top else None)
                    if target_top_id:
                        conn.execute(
                            """INSERT INTO snippets
                               (user_id, title, subtitle, complexity, topic_id, sort_order, verified, tested_on, code, notes, formulas, language, kind)
                               VALUES (?, ?, ?, ?, ?, ?, 1, '', ?, ?, ?, ?, ?)""",
                            (uid, s["title"], s.get("subtitle", ""), s.get("complexity", ""), target_top_id,
                             s.get("sort_order", 100), s.get("code", ""), s.get("notes", ""),
                             s.get("formulas", "[]"), s.get("language", "cpp"), s.get("kind", "code")),
                        )

    # Seed institutions from JSON if missing
    import json
    names_path = Path(__file__).parent / "data" / "institution_names.json"
    short_path = Path(__file__).parent / "data" / "institution_short_names.json"
    names = []
    short_map = {}
    if names_path.exists():
        try:
            names = json.loads(names_path.read_text(encoding="utf-8"))
        except Exception:
            pass
    if short_path.exists():
        try:
            short_map = json.loads(short_path.read_text(encoding="utf-8"))
        except Exception:
            pass
    # Ensure build_count & workspace_count columns exist in institutions
    inst_cols = [c[1] for c in conn.execute("PRAGMA table_info(institutions)").fetchall()]
    if "build_count" not in inst_cols:
        conn.execute("ALTER TABLE institutions ADD COLUMN build_count INTEGER NOT NULL DEFAULT 0")
    if "workspace_count" not in inst_cols:
        conn.execute("ALTER TABLE institutions ADD COLUMN workspace_count INTEGER NOT NULL DEFAULT 0")

    # Sync / backfill build_count from actual build_logs for accuracy
    try:
        conn.execute("""
            UPDATE institutions
            SET build_count = (
                SELECT COUNT(*) FROM build_logs
                WHERE LOWER(build_logs.institution_name) = LOWER(institutions.name)
                   OR (institutions.short_name != '' AND LOWER(build_logs.institution_name) = LOWER(institutions.short_name))
            )
            WHERE build_count = 0
        """)
        # Backfill workspace_count from use_count - build_count if use_count > 0
        conn.execute("""
            UPDATE institutions
            SET workspace_count = MAX(0, use_count - build_count)
            WHERE workspace_count = 0 AND use_count > 0
        """)
    except Exception:
        pass

    now = int(time.time())
    for n in names:
        short = short_map.get(n, "")
        conn.execute(
            """INSERT OR IGNORE INTO institutions
               (name, short_name, status, use_count, build_count, workspace_count, suggested_by, created_at, last_used_at)
               VALUES (?, ?, 'approved', 0, 0, 0, 'system', ?, ?)""",
            (n.strip(), short.strip(), now, now)
        )

    conn.commit()
    conn.close()

