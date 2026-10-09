import { createClient, type Client, type InValue } from "@libsql/client";

let client: Client | null = null;
let migrated: Promise<void> | null = null;

function getClient(): Client {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL || "file:local.db";
    client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN || undefined });
  }
  return client;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    preview_url TEXT NOT NULL,
    live_url TEXT,
    duda_site_id TEXT,
    jira_key TEXT,
    status TEXT NOT NULL DEFAULT 'not_started',
    assignee_id INTEGER,
    notes TEXT,
    facts_json TEXT,
    facts_source TEXT,
    facts_raw_text TEXT,
    last_run_id INTEGER,
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    started_by INTEGER,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    page_count INTEGER NOT NULL DEFAULT 0,
    finding_count INTEGER NOT NULL DEFAULT 0,
    ai_enabled INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    site_id INTEGER NOT NULL,
    url TEXT NOT NULL,
    path TEXT NOT NULL,
    title TEXT,
    meta_description TEXT,
    status_code INTEGER,
    blocks_json TEXT,
    images_json TEXT,
    links_json TEXT,
    error TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS pages_run ON pages(run_id)`,
  `CREATE TABLE IF NOT EXISTS findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    run_id INTEGER,
    page_path TEXT NOT NULL,
    page_url TEXT,
    selector TEXT,
    category TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'warning',
    rule TEXT NOT NULL,
    message TEXT NOT NULL,
    expected TEXT,
    found TEXT,
    source TEXT NOT NULL DEFAULT 'rule',
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    assignee_id INTEGER,
    note TEXT,
    done_by INTEGER,
    done_at TEXT,
    stale INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(site_id, fingerprint)
  )`,
  `CREATE INDEX IF NOT EXISTS findings_site ON findings(site_id, status)`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,               -- SHA-256 of the cookie token; the raw token is never stored
    user_id INTEGER NOT NULL,
    mfa_ok INTEGER NOT NULL DEFAULT 0, -- 0 = password checked, waiting for the 2FA code
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS security_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    user_id INTEGER,
    event TEXT NOT NULL,
    ip TEXT,
    detail TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS security_events_at ON security_events(at)`,
  // Background research runs (keep going when the person leaves the page)
  `CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    steps TEXT NOT NULL,
    idx INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'queued',
    log TEXT NOT NULL DEFAULT '[]',
    token_hash TEXT NOT NULL,
    lease_until INTEGER NOT NULL DEFAULT 0,
    user_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS jobs_site ON jobs(site_id, id)`,
  // All Websites (imported from Duda's site list export) + domain health monitoring
  `CREATE TABLE IF NOT EXISTS websites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alias TEXT NOT NULL UNIQUE,
    site_name TEXT NOT NULL DEFAULT '',
    external_uid TEXT,
    domain TEXT NOT NULL DEFAULT '',
    duda_status TEXT NOT NULL DEFAULT '',
    created_at TEXT, first_publish TEXT, last_publish TEXT,
    auto_renew TEXT, next_renewal TEXT, subscription TEXT, billing_failed INTEGER NOT NULL DEFAULT 0,
    labels TEXT NOT NULL DEFAULT '',
    imported_at TEXT NOT NULL DEFAULT (datetime('now')),
    refreshed_at TEXT,
    last_seen_import INTEGER NOT NULL DEFAULT 0,
    health TEXT NOT NULL DEFAULT 'unchecked',
    health_detail TEXT NOT NULL DEFAULT '',
    health_flags TEXT NOT NULL DEFAULT '[]',
    health_json TEXT,
    checked_at TEXT,
    prev_health TEXT,
    health_changed_at TEXT,
    rdap_checked_at TEXT,
    domain_expires TEXT,
    ssl_expires TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS websites_health ON websites(health)`,
  // "What changed" feed for All Websites (went down, back up, new warnings)
  `CREATE TABLE IF NOT EXISTS website_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    website_id INTEGER NOT NULL,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    kind TEXT NOT NULL,
    health TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS website_events_at ON website_events (id DESC)`,
  // Browser push subscriptions (each person turns alerts on in their own browser)
  `CREATE TABLE IF NOT EXISTS push_subs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_ok_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS health_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL DEFAULT 'queued',
    scope TEXT NOT NULL DEFAULT 'published',
    total INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0,
    cursor_id INTEGER NOT NULL DEFAULT 0,
    started_by TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    token_hash TEXT NOT NULL,
    lease_until INTEGER NOT NULL DEFAULT 0
  )`,
];

// Columns added after the first release. Each is applied once if missing.
const COLUMNS: [table: string, column: string, ddl: string][] = [
  ["users", "mfa_enabled", "INTEGER NOT NULL DEFAULT 0"],
  ["users", "can_history", "INTEGER NOT NULL DEFAULT 1"],
  ["users", "mfa_secret_enc", "TEXT"],
  ["users", "mfa_last_step", "INTEGER NOT NULL DEFAULT 0"],
  ["users", "recovery_codes", "TEXT"],
  ["users", "failed_logins", "INTEGER NOT NULL DEFAULT 0"],
  ["users", "locked_until", "TEXT"],
  ["users", "must_change_password", "INTEGER NOT NULL DEFAULT 0"],
  ["users", "password_changed_at", "TEXT"],
  ["users", "last_login_at", "TEXT"],
  // Projects (Data Collection)
  ["sites", "project_type", "TEXT"],
  ["sites", "template", "TEXT"],
  ["sites", "jira_json", "TEXT"],
  ["sites", "editor_url", "TEXT"],
  ["sites", "collection_json", "TEXT"],
  ["sites", "research_json", "TEXT"],
  ["sites", "tekmetric_id", "TEXT"],
  ["sessions", "remember", "INTEGER NOT NULL DEFAULT 0"],
  ["sites", "homepage_json", "TEXT"],
  // What a member may open: all | projects | websites (Super Admins always see everything)
  ["users", "access", "TEXT NOT NULL DEFAULT 'all'"],
  // Location / FAQ / Meta / Service pages / URL redirects generated from the Prompts tab
  ["sites", "prompts_json", "TEXT"],
  // All Websites monitoring: uptime history, incidents, GBP website check
  ["websites", "uptime_json", "TEXT"],
  ["websites", "incidents_json", "TEXT"],
  ["websites", "gbp_json", "TEXT"],
  ["websites", "gbp_checked_at", "TEXT"],
  // small summary of uptime_json/incidents_json for the list (the full history is only read for one site)
  ["websites", "uptime_pct", "REAL"],
  ["websites", "uptime_checks", "INTEGER NOT NULL DEFAULT 0"],
  ["websites", "uptime_recent", "TEXT NOT NULL DEFAULT ''"],
  ["websites", "open_incident", "TEXT"],
  // site history chart: when a site that had been live stopped being published / left Duda's export (seen on import)
  ["websites", "unpublished_at", "TEXT"],
  ["websites", "removed_at", "TEXT"],
];

async function migrate() {
  const c = getClient();
  for (const stmt of SCHEMA) await c.execute(stmt);
  const cols = new Map<string, Set<string>>();
  for (const [table, column, ddl] of COLUMNS) {
    if (!cols.has(table)) {
      const r = await c.execute(`PRAGMA table_info(${table})`);
      cols.set(table, new Set(r.rows.map((x) => String(x.name))));
    }
    if (!cols.get(table)!.has(column)) {
      await c.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
      cols.get(table)!.add(column);
    }
  }
}

export async function db(): Promise<Client> {
  if (!migrated) migrated = migrate().catch((e) => { migrated = null; throw e; });
  await migrated;
  return getClient();
}

export async function all<T = Record<string, unknown>>(sql: string, args: InValue[] = []): Promise<T[]> {
  const c = await db();
  const r = await c.execute({ sql, args });
  return r.rows.map((row) => ({ ...row }) as T);
}

export async function one<T = Record<string, unknown>>(sql: string, args: InValue[] = []): Promise<T | null> {
  const rows = await all<T>(sql, args);
  return rows[0] ?? null;
}

export async function run(sql: string, args: InValue[] = []) {
  const c = await db();
  const r = await c.execute({ sql, args });
  return { lastId: r.lastInsertRowid ? Number(r.lastInsertRowid) : 0, changes: r.rowsAffected };
}

export async function batch(stmts: { sql: string; args: InValue[] }[]) {
  if (!stmts.length) return;
  const c = await db();
  await c.batch(stmts, "write");
}
