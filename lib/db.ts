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
];

// Columns added after the first release. Each is applied once if missing.
const COLUMNS: [table: string, column: string, ddl: string][] = [
  ["users", "mfa_enabled", "INTEGER NOT NULL DEFAULT 0"],
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
