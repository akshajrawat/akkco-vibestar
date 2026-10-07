export const migrations = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS repositories(id TEXT PRIMARY KEY,owner TEXT NOT NULL,name TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(owner,name));
CREATE TABLE IF NOT EXISTS issues(repo_id TEXT NOT NULL REFERENCES repositories(id),number INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(repo_id,number));
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,repo_id TEXT NOT NULL REFERENCES repositories(id),status TEXT NOT NULL,stage INTEGER NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS task_queue ON tasks(status,created_at);
CREATE TABLE IF NOT EXISTS agent_runs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),stage INTEGER NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,effort TEXT NOT NULL,prompt TEXT NOT NULL,status TEXT NOT NULL,started_at TEXT NOT NULL,ended_at TEXT,exit_code INTEGER,pid INTEGER,process_identity TEXT,conversation_id TEXT,output TEXT,error TEXT);
CREATE TABLE IF NOT EXISTS agent_events(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES agent_runs(id),task_id TEXT NOT NULL REFERENCES tasks(id),timestamp TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL,raw TEXT NOT NULL,stream TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS task_events ON agent_events(task_id,id);
CREATE TABLE IF NOT EXISTS task_messages(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),role TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS task_artifacts(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),stage INTEGER NOT NULL,kind TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS test_runs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),command TEXT NOT NULL,status TEXT NOT NULL,started_at TEXT NOT NULL,ended_at TEXT,exit_code INTEGER,duration_ms INTEGER,stdout TEXT NOT NULL DEFAULT '',stderr TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT OR IGNORE INTO schema_migrations VALUES(1,strftime('%Y-%m-%dT%H:%M:%SZ','now'));
`,
  },
  {
    version: 2,
    sql: "ALTER TABLE test_runs ADD COLUMN pid INTEGER; ALTER TABLE test_runs ADD COLUMN process_identity TEXT;",
  },
  {
    version: 3,
    sql: `
CREATE TABLE scheduled_jobs(id TEXT PRIMARY KEY,data TEXT NOT NULL);
CREATE TABLE scheduled_attention(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,created_at TEXT NOT NULL,summary TEXT NOT NULL,changes TEXT NOT NULL,analysis TEXT,refinement TEXT,error TEXT,dismissed INTEGER NOT NULL DEFAULT 0);
ALTER TABLE agent_runs ADD COLUMN purpose TEXT NOT NULL DEFAULT 'pipeline';
`,
  },
  {
    version: 4,
    sql: `CREATE TABLE task_review_notes(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,path TEXT NOT NULL,side TEXT NOT NULL,line_start INTEGER NOT NULL,line_end INTEGER NOT NULL,content TEXT NOT NULL,source_hash TEXT NOT NULL,created_at TEXT NOT NULL);CREATE INDEX task_review_notes_by_task ON task_review_notes(task_id,created_at);`,
  },
  {
    version: 5,
    sql: `CREATE TABLE terminal_sessions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,status TEXT NOT NULL,started_at TEXT NOT NULL,ended_at TEXT,pid INTEGER,process_identity TEXT,exit_code INTEGER);`,
  },
  {
    version: 6,
    sql: `
ALTER TABLE tasks ADD COLUMN scope_mode TEXT NOT NULL DEFAULT 'partial' CHECK(scope_mode IN ('whole_issue','partial'));
UPDATE tasks SET data=json_set(data,'$.scope_mode','partial');
CREATE TABLE task_activity(id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,kind TEXT NOT NULL,data TEXT NOT NULL,timestamp TEXT NOT NULL);
CREATE TABLE github_repositories(id INTEGER PRIMARY KEY,full_name TEXT NOT NULL UNIQUE,data TEXT NOT NULL,synced_at TEXT NOT NULL);
CREATE TABLE github_pull_requests(url TEXT PRIMARY KEY,data TEXT NOT NULL,updated_at TEXT NOT NULL);
`,
  },
  {
    version: 7,
    sql: `CREATE TABLE scheduled_agent_runs(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,stage INTEGER NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,effort TEXT NOT NULL,prompt TEXT NOT NULL,status TEXT NOT NULL,started_at TEXT NOT NULL,ended_at TEXT,exit_code INTEGER,pid INTEGER,process_identity TEXT,conversation_id TEXT,output TEXT,error TEXT,purpose TEXT NOT NULL DEFAULT 'scheduled');`,
  },
];
