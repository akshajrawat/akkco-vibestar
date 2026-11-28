export const prWatchSchema = `
CREATE TABLE IF NOT EXISTS viber_pr_watches(
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES viber_sessions(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pull_number INTEGER NOT NULL,
  title TEXT,
  status TEXT NOT NULL CHECK(status IN ('active','completed','cancelled','failed')),
  cursor TEXT,
  last_checked_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS viber_pr_watches_active_unique ON viber_pr_watches(
  session_id,
  lower(owner),
  lower(repo),
  pull_number
) WHERE status='active';
CREATE INDEX IF NOT EXISTS viber_pr_watches_session ON viber_pr_watches(session_id, status);
`;

export const sharedComputerSchema = `
CREATE TABLE IF NOT EXISTS shared_computer(
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  socket TEXT NOT NULL,
  daemon_id TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  reset_pending INTEGER NOT NULL DEFAULT 0 CHECK(reset_pending IN (0,1))
);
`;

export const schemaVersion = 0;

export const baselineSchema = `
CREATE TABLE schema_migrations(
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE repositories(
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE UNIQUE INDEX repositories_checkout ON repositories(
  lower(owner),
  lower(name),
  CASE WHEN json_valid(data) THEN json_extract(CASE WHEN json_valid(data) THEN data END,'$.path') END
);

CREATE TABLE local_repositories(
  path TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  indexed_at TEXT NOT NULL
);

CREATE TABLE persistence_diagnostics(
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  column_name TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY(table_name, record_id, column_name)
);

CREATE TABLE agent_profiles(
  id TEXT PRIMARY KEY,
  current_revision INTEGER NOT NULL CHECK(current_revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(id, current_revision) REFERENCES agent_profile_revisions(profile_id, revision) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE agent_profile_revisions(
  profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  data TEXT NOT NULL CHECK(json_valid(data)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(profile_id, revision)
);

CREATE TABLE retired_viber_profiles(
  profile_id TEXT PRIMARY KEY
);

CREATE TABLE viber_sessions(
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

CREATE INDEX viber_profile_sessions ON viber_sessions(profile_id, updated_at);
CREATE UNIQUE INDEX viber_profile_single_session ON viber_sessions(profile_id);
CREATE UNIQUE INDEX viber_native_thread ON viber_sessions(
  json_extract(thread, '$.provider'),
  json_extract(thread, '$.thread_id')
) WHERE thread IS NOT NULL;

CREATE TABLE utility_runs(
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

CREATE UNIQUE INDEX viber_message_run ON utility_runs(viber_message_id);
CREATE INDEX viber_session_runs ON utility_runs(viber_session_id, started_at);

CREATE TABLE utility_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES utility_runs(id) ON DELETE CASCADE,
  timestamp TEXT NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)),
  raw TEXT NOT NULL,
  stream TEXT NOT NULL
);

CREATE TABLE viber_messages(
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

CREATE UNIQUE INDEX viber_pending_message ON viber_messages(session_id) WHERE status='pending';
CREATE INDEX viber_session_messages ON viber_messages(session_id, created_at);

CREATE TABLE ai_usage(
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

CREATE INDEX viber_usage ON ai_usage(viber_session_id, started_at);

CREATE TRIGGER viber_message_snapshot_immutable BEFORE UPDATE OF id,session_id,role,content,configuration,created_at ON viber_messages BEGIN SELECT RAISE(ABORT,'Viber message snapshots are immutable'); END;

CREATE TRIGGER viber_repository_immutable BEFORE UPDATE OF repository_id ON viber_sessions BEGIN SELECT RAISE(ABORT,'Viber repository ownership is immutable'); END;

CREATE TRIGGER viber_session_owner_immutable BEFORE UPDATE OF id,profile_id,configuration,created_at ON viber_sessions BEGIN SELECT RAISE(ABORT,'Viber session ownership is immutable'); END;

CREATE TRIGGER viber_workspace_owner_immutable BEFORE UPDATE OF workspace ON viber_sessions WHEN json_extract(OLD.workspace,'$.id') IS NOT json_extract(NEW.workspace,'$.id') OR json_extract(OLD.workspace,'$.repo_id') IS NOT json_extract(NEW.workspace,'$.repo_id') BEGIN SELECT RAISE(ABORT,'Viber workspace ownership is immutable'); END;

CREATE TABLE viber_memory_facts(
  profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
  id TEXT NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY(profile_id, id)
);

CREATE TABLE viber_memory_details(
  profile_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  repository_id TEXT,
  topic TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  source_message_id TEXT,
  source_session_id TEXT,
  source_at TEXT,
  evidence TEXT,
  subject TEXT,
  needs_review INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(profile_id,fact_id),
  FOREIGN KEY(profile_id,fact_id) REFERENCES viber_memory_facts(profile_id,id) ON DELETE CASCADE
);
CREATE INDEX viber_memory_scope ON viber_memory_details(profile_id,repository_id,topic);

CREATE TABLE viber_memory_vectors(
  profile_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  model TEXT NOT NULL,
  digest TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector BLOB NOT NULL,
  topic_vector BLOB,
  PRIMARY KEY(profile_id,fact_id),
  FOREIGN KEY(profile_id,fact_id) REFERENCES viber_memory_details(profile_id,fact_id) ON DELETE CASCADE
);

CREATE TABLE viber_memory_shares(
  profile_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  session_id TEXT NOT NULL REFERENCES viber_sessions(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  in_context INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(profile_id,fact_id,revision,session_id,provider,thread_id),
  FOREIGN KEY(profile_id,fact_id) REFERENCES viber_memory_facts(profile_id,id) ON DELETE CASCADE
);
CREATE INDEX viber_memory_share_thread ON viber_memory_shares(session_id,provider,thread_id);

CREATE TABLE viber_memory_private_runs(
  run_id TEXT PRIMARY KEY REFERENCES utility_runs(id) ON DELETE CASCADE
);
${sharedComputerSchema}
${prWatchSchema}
`;
