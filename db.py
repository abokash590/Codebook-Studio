import sqlite3
import time
from pathlib import Path

DB_PATH = Path(__file__).parent / "data" / "codebook.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS topics (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS snippets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    deleted_at INTEGER,
    FOREIGN KEY (topic_id) REFERENCES topics (id)
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""

DEFAULT_TOPICS = [
    ("data-structures", "Data Structures", "#1D9E75", 10),
    ("graph", "Graph", "#378ADD", 20),
    ("dp", "Dynamic Programming", "#7F77DD", 30),
    ("string", "String", "#D4537E", 40),
    ("number-theory", "Number Theory", "#BA7517", 50),
]

DEFAULT_SNIPPETS = [
    dict(title="Segment tree", subtitle="Range sum, point update", complexity="O(log n)",
         topic_id="data-structures", sort_order=10, verified=1, tested_on="Codeforces 1234A",
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
};"""),
    dict(title="DSU", subtitle="Union by size, path compression", complexity="O(a(n))",
         topic_id="data-structures", sort_order=20, verified=1, tested_on="Codeforces 25D",
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
};"""),
    dict(title="Dijkstra", subtitle="Single source shortest path, non-negative weights", complexity="O((V+E) log V)",
         topic_id="graph", sort_order=10, verified=1, tested_on="Codeforces 20C",
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
}"""),
    dict(title="KMP", subtitle="Pattern matching via prefix function", complexity="O(n + m)",
         topic_id="string", sort_order=10, verified=1, tested_on="Codeforces 126B",
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
}"""),
]


def get_db():
    DB_PATH.parent.mkdir(exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _migrate(conn):
    """CREATE TABLE IF NOT EXISTS won't add new columns to a snippets table
    that already existed from before this version -- add them by hand if
    missing, so upgrading doesn't require deleting the old database."""
    existing_cols = {r["name"] for r in conn.execute("PRAGMA table_info(snippets)")}
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
    if "deleted_at" not in existing_topic_cols:
        conn.execute("ALTER TABLE topics ADD COLUMN deleted_at INTEGER")


TRASH_RETENTION_SECONDS = 30 * 24 * 60 * 60  # 30 days, see P1.5


def purge_expired_trash(conn):
    """Hard-deletes anything that's been soft-deleted for more than 30 days.
    Called on every init_db() / trash fetch so nothing needs a cron job."""
    cutoff = int(time.time()) - TRASH_RETENTION_SECONDS
    conn.execute("DELETE FROM snippets WHERE deleted_at IS NOT NULL AND deleted_at < ?", (cutoff,))
    conn.execute("DELETE FROM topics WHERE deleted_at IS NOT NULL AND deleted_at < ?", (cutoff,))


def init_db():
    conn = get_db()
    conn.executescript(SCHEMA)
    _migrate(conn)
    purge_expired_trash(conn)

    row = conn.execute("SELECT COUNT(*) c FROM topics").fetchone()
    if row["c"] == 0:
        conn.executemany(
            "INSERT INTO topics (id, name, color, sort_order) VALUES (?,?,?,?)",
            DEFAULT_TOPICS,
        )
        for s in DEFAULT_SNIPPETS:
            conn.execute(
                """INSERT INTO snippets
                   (title, subtitle, complexity, topic_id, sort_order, verified, tested_on, code)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (s["title"], s["subtitle"], s["complexity"], s["topic_id"],
                 s["sort_order"], s["verified"], s["tested_on"], s["code"]),
            )

    row = conn.execute("SELECT value FROM settings WHERE key='team_name'").fetchone()
    if row is None:
        conn.execute("INSERT INTO settings (key, value) VALUES ('team_name', 'MEC_batasa')")
        conn.execute("INSERT INTO settings (key, value) VALUES ('book_title', 'Contest Codebook')")

    defaults = {
        "code_font": "JetBrains Mono",
        "page_size": "A4",
        "accent_color": "#2C2C2A",
        "show_team_footer": "1",
        "institution_name": "",
        "boilerplate_code": "",
        "show_boilerplate": "1",
        "cover_style": "minimal",
        "template_accent_color": "#2C2C2A",
    }
    for key, value in defaults.items():
        row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        if row is None:
            conn.execute("INSERT INTO settings (key, value) VALUES (?, ?)", (key, value))

    conn.commit()
    conn.close()
