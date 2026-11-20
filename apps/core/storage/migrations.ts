export const migrations = [
  {
    version: 0,
    foreign_keys_off: true,
    sql: `
CREATE TABLE IF NOT EXISTS schema_migrations(
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repositories(
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS repositories_checkout ON repositories(
  lower(owner),
  lower(name),
  CASE WHEN json_valid(data) THEN json_extract(CASE WHEN json_valid(data) THEN data END,'$.path') END
);

CREATE TABLE IF NOT EXISTS local_repositories(
  path TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  indexed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS persistence_diagnostics(
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  column_name TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY(table_name, record_id, column_name)
);

CREATE TABLE IF NOT EXISTS agent_profiles(
  id TEXT PRIMARY KEY,
  current_revision INTEGER NOT NULL CHECK(current_revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(id, current_revision) REFERENCES agent_profile_revisions(profile_id, revision) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS agent_profile_revisions(
  profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  data TEXT NOT NULL CHECK(json_valid(data)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(profile_id, revision)
);

CREATE TABLE IF NOT EXISTS retired_viber_profiles(
  profile_id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS viber_computers(
  profile_id TEXT PRIMARY KEY REFERENCES agent_profiles(id)
);

CREATE TABLE IF NOT EXISTS viber_sessions(
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
  title TEXT NOT NULL,
  selection TEXT NOT NULL CHECK(json_valid(selection)),
  configuration TEXT NOT NULL CHECK(json_valid(configuration)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  repository_id TEXT REFERENCES repositories(id),
  workspace TEXT CHECK(workspace IS NULL OR json_valid(workspace)),
  thread TEXT CHECK(thread IS NULL OR json_valid(thread)),
  threads TEXT CHECK(threads IS NULL OR json_valid(threads))
);

CREATE INDEX IF NOT EXISTS viber_profile_sessions ON viber_sessions(profile_id, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS viber_profile_single_session ON viber_sessions(profile_id);
CREATE UNIQUE INDEX IF NOT EXISTS viber_native_thread ON viber_sessions(
  json_extract(thread, '$.provider'),
  json_extract(thread, '$.thread_id')
) WHERE thread IS NOT NULL;

CREATE TABLE IF NOT EXISTS utility_runs(
  id TEXT PRIMARY KEY,
  stage INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  exit_code INTEGER,
  pid INTEGER,
  process_identity TEXT,
  conversation_id TEXT,
  output TEXT,
  error TEXT,
  purpose TEXT NOT NULL,
  execution TEXT CHECK(execution IS NULL OR json_valid(execution)),
  viber_session_id TEXT REFERENCES viber_sessions(id) ON DELETE CASCADE,
  viber_message_id TEXT REFERENCES viber_messages(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS viber_message_run ON utility_runs(viber_message_id);
CREATE INDEX IF NOT EXISTS viber_session_runs ON utility_runs(viber_session_id, started_at);

CREATE TABLE IF NOT EXISTS utility_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES utility_runs(id) ON DELETE CASCADE,
  timestamp TEXT NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)),
  raw TEXT NOT NULL,
  stream TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS viber_messages(
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES viber_sessions(id),
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','completed','failed','cancelled','interrupted')),
  run_id TEXT REFERENCES utility_runs(id),
  configuration TEXT CHECK(configuration IS NULL OR json_valid(configuration)),
  created_at TEXT NOT NULL,
  error TEXT,
  effects TEXT NOT NULL DEFAULT 'possible' CHECK(effects IN ('none','possible'))
);

CREATE UNIQUE INDEX IF NOT EXISTS viber_pending_message ON viber_messages(session_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS viber_session_messages ON viber_messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS ai_usage(
  id TEXT PRIMARY KEY,
  viber_session_id TEXT REFERENCES viber_sessions(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER,
  status TEXT NOT NULL,
  input_tokens INTEGER,
  cached_input_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_tokens INTEGER,
  total_tokens INTEGER,
  error TEXT,
  provider_session_id TEXT,
  subscription_limits TEXT,
  subscription_limits_after TEXT
);

CREATE INDEX IF NOT EXISTS viber_usage ON ai_usage(viber_session_id, started_at);

CREATE TRIGGER IF NOT EXISTS viber_message_snapshot_immutable BEFORE UPDATE OF id,session_id,role,content,configuration,created_at ON viber_messages BEGIN SELECT RAISE(ABORT,'Viber message snapshots are immutable'); END;

CREATE TRIGGER IF NOT EXISTS viber_repository_immutable BEFORE UPDATE OF repository_id ON viber_sessions BEGIN SELECT RAISE(ABORT,'Viber repository ownership is immutable'); END;

CREATE TRIGGER IF NOT EXISTS viber_session_owner_immutable BEFORE UPDATE OF id,profile_id,configuration,created_at ON viber_sessions BEGIN SELECT RAISE(ABORT,'Viber session ownership is immutable'); END;

CREATE TRIGGER IF NOT EXISTS viber_workspace_owner_immutable BEFORE UPDATE OF workspace ON viber_sessions WHEN json_extract(OLD.workspace,'$.id') IS NOT json_extract(NEW.workspace,'$.id') OR json_extract(OLD.workspace,'$.repo_id') IS NOT json_extract(NEW.workspace,'$.repo_id') BEGIN SELECT RAISE(ABORT,'Viber workspace ownership is immutable'); END;
`,
  },
];
