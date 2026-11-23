import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './paths.js';

let db: DatabaseSync;

export function database(): DatabaseSync {
  return db;
}

export function openDatabase(): void {
  mkdirSync(dataDir, { recursive: true });
  db = new DatabaseSync(join(dataDir, 'yard.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 3000;
    PRAGMA cache_size = -16000;
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      mapping_name TEXT NOT NULL DEFAULT '',
      retention_json TEXT NOT NULL DEFAULT '{}',
      mqtt_json TEXT NOT NULL DEFAULT '{}',
      customer_json TEXT NOT NULL DEFAULT '{}',
      last_real_at TEXT,
      last_real_action TEXT,
      last_real_area TEXT,
      last_real_x INTEGER,
      last_real_y INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS areas (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL,
      area_code TEXT NOT NULL,
      area_name TEXT NOT NULL,
      filename TEXT NOT NULL,
      rows INTEGER NOT NULL,
      cols INTEGER NOT NULL,
      matrix_json TEXT NOT NULL,
      UNIQUE(project_id, area_code)
    );
    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL,
      area_id INTEGER NOT NULL,
      device_code TEXT NOT NULL,
      device_name TEXT NOT NULL,
      UNIQUE(project_id, device_code)
    );
    CREATE TABLE IF NOT EXISTS cells (
      project_id INTEGER NOT NULL,
      area_id INTEGER NOT NULL,
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      sandbox INTEGER NOT NULL,
      layers INTEGER NOT NULL DEFAULT 0,
      unknown INTEGER NOT NULL DEFAULT 0,
      issue TEXT NOT NULL DEFAULT '',
      last_event_at TEXT,
      photos_json TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (project_id, area_id, x, y, sandbox)
    );
    CREATE TABLE IF NOT EXISTS raw_messages (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL,
      sandbox INTEGER NOT NULL,
      received_at TEXT NOT NULL,
      device_code TEXT NOT NULL,
      action TEXT NOT NULL,
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      event_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      reason TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      source TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_raw_proj ON raw_messages(project_id, sandbox, id DESC);
    CREATE TABLE IF NOT EXISTS business_events (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL,
      sandbox INTEGER NOT NULL,
      event_id TEXT NOT NULL,
      event_time TEXT NOT NULL,
      area_code TEXT NOT NULL,
      area_name TEXT NOT NULL,
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      action TEXT NOT NULL,
      before_layers INTEGER NOT NULL,
      after_layers INTEGER NOT NULL,
      device_code TEXT NOT NULL,
      source TEXT NOT NULL,
      push_status TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evt_proj ON business_events(project_id, sandbox, id DESC);
    CREATE TABLE IF NOT EXISTS seen_ids (
      project_id INTEGER NOT NULL,
      sandbox INTEGER NOT NULL,
      event_id TEXT NOT NULL,
      PRIMARY KEY (project_id, sandbox, event_id)
    );
    CREATE TABLE IF NOT EXISTS op_logs (
      id INTEGER PRIMARY KEY,
      project_id INTEGER,
      at TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      object TEXT NOT NULL,
      result TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_logs_proj ON op_logs(project_id, id DESC);
    CREATE TABLE IF NOT EXISTS test_state (
      project_id INTEGER PRIMARY KEY,
      running INTEGER NOT NULL DEFAULT 0,
      viewing INTEGER NOT NULL DEFAULT 0,
      count INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL DEFAULT 0,
      last_at TEXT,
      last_action TEXT NOT NULL DEFAULT '',
      interval_sec INTEGER NOT NULL DEFAULT 20
    );
  `);
  const columns = db.prepare(`PRAGMA table_info(test_state)`).all() as { name: string }[];
  if (!columns.some((column) => column.name === 'interval_sec')) {
    db.exec(`ALTER TABLE test_state ADD COLUMN interval_sec INTEGER NOT NULL DEFAULT 20`);
  }
}

export function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = fn();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* already closed */ }
    throw error;
  }
}
