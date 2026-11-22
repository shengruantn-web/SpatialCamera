// Applies the Drizzle SQL migrations in ./drizzle to a D1 database.
//
// The API never runs DDL at request time (spec §6 T6); the schema comes only from these
// migrations. The hosting platform applies `drizzle/` on deploy (it is packaged into
// dist/.openai/drizzle by build/sites-vite-plugin.ts). This module is used by the
// Miniflare tests and, run directly, migrates the local `vinext dev` database:
//
//   node db/migrate.mjs                 # .wrangler/state/v3 (the dev server's state)
//   node db/migrate.mjs --persist <dir> # another persisted state root
//
// Applied migrations are recorded in `d1_migrations` (the same table and naming that
// `wrangler d1 migrations apply` uses), so the two tools agree about what has run.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = resolve(here, "..", "drizzle");
// Must match the placeholder database_id in vite.config.ts so we open the dev server's file.
const LOCAL_DATABASE_ID = "00000000-0000-4000-8000-000000000000";

/** Migrations in journal order: [{ name: "0000_x.sql", statements: string[] }]. */
export async function readMigrations(dir = MIGRATIONS_DIR) {
  const journal = JSON.parse(await readFile(resolve(dir, "meta", "_journal.json"), "utf8"));
  return Promise.all(journal.entries.map(async ({ tag }) => {
    const sql = await readFile(resolve(dir, `${tag}.sql`), "utf8");
    const statements = sql.split("--> statement-breakpoint").map(s => s.trim()).filter(s => s.replace(/^--.*$/gm, "").trim());
    return { name: `${tag}.sql`, statements };
  }));
}

// Schema objects a migration creates, as parsed from its DDL. Migrations are schema-only
// (no backfills), so these fully describe what applying one does.
const CREATES = [
  [/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?`([^`]+)`/i, ([table]) => ({ kind: "table", table })],
  [/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF NOT EXISTS\s+)?`([^`]+)`/i, ([index]) => ({ kind: "index", index })],
  [/^ALTER TABLE\s+`([^`]+)`\s+ADD\s+(?:COLUMN\s+)?`([^`]+)`/i, ([table, column]) => ({ kind: "column", table, column })],
];
export function schemaObjects(statements) {
  return statements.flatMap(statement => {
    const sql = statement.replace(/^--.*$/gm, "").trim();
    for (const [pattern, toObject] of CREATES) { const m = sql.match(pattern); if (m) return [toObject(m.slice(1))]; }
    return [];
  });
}
async function exists(db, object) {
  if (object.kind === "column") {
    const columns = (await db.prepare(`PRAGMA table_info(\`${object.table}\`)`).all()).results;
    return columns.some(c => c.name === object.column);
  }
  const name = object.kind === "table" ? object.table : object.index;
  return Boolean(await db.prepare("SELECT 1 FROM sqlite_master WHERE type=? AND name=?").bind(object.kind, name).first());
}
const describe = o => o.kind === "column" ? `column ${o.table}.${o.column}` : `${o.kind} ${o.table ?? o.index}`;

/**
 * Applies pending migrations. Returns `{ applied, adopted }`: `adopted` are migrations whose schema
 * objects all already existed without a `d1_migrations` row (e.g. a database created by the pre-migration
 * runtime DDL, or a file run with `wrangler d1 execute --file`); they are recorded, not re-run.
 * A migration that is only partly present is an error: it needs a manual decision. Safe to run repeatedly.
 */
export async function migrate(db, dir = MIGRATIONS_DIR) {
  await db.prepare("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)").run();
  const migrations = await readMigrations(dir);
  const done = new Set((await db.prepare("SELECT name FROM d1_migrations").all()).results.map(r => r.name));
  const applied = [], adopted = [];
  for (const migration of migrations) {
    if (done.has(migration.name)) continue;
    const record = db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(migration.name);
    const objects = schemaObjects(migration.statements);
    const present = [];
    for (const object of objects) if (await exists(db, object)) present.push(object);
    if (objects.length && present.length === objects.length) {
      await record.run();
      adopted.push(migration.name);
      continue;
    }
    if (present.length) {
      const missing = objects.filter(o => !present.includes(o));
      throw new Error(`Migration ${migration.name} is partially applied but not recorded in d1_migrations.\n` +
        `  Already present: ${present.map(describe).join(", ")}\n  Missing: ${missing.map(describe).join(", ")}\n` +
        `Create the missing objects by hand (see drizzle/${migration.name}) and then run\n` +
        `  INSERT INTO d1_migrations (name) VALUES ('${migration.name}');\n` +
        `or, for a disposable local database, delete .wrangler/state/v3/d1 and run npm run db:migrate:local again.`);
    }
    // D1 batches are transactional: a migration and its bookkeeping row land together.
    await db.batch([...migration.statements.map(s => db.prepare(s)), record]);
    applied.push(migration.name);
  }
  return { applied, adopted };
}
/** Applies pending migrations; returns the names applied (not those adopted). */
export async function applyMigrations(db, dir = MIGRATIONS_DIR) {
  return (await migrate(db, dir)).applied;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { Miniflare } = await import("miniflare");
  const flag = process.argv.indexOf("--persist");
  const persistRoot = resolve(flag > -1 ? process.argv[flag + 1] : ".wrangler/state/v3");
  const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response(null, { status: 204 }); } }", compatibilityDate: "2026-01-01", d1Databases: { DB: LOCAL_DATABASE_ID }, defaultPersistRoot: persistRoot });
  try {
    const { applied, adopted } = await migrate(await mf.getD1Database("DB"));
    if (adopted.length) console.log(`Recorded ${adopted.join(", ")} as applied (schema already present) in ${persistRoot}`);
    console.log(applied.length ? `Applied ${applied.join(", ")} to ${persistRoot}` : `No pending migrations in ${persistRoot}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await mf.dispose();
  }
}
