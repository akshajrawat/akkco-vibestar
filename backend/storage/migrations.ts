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
  {
    version: 8,
    sql: `
CREATE TABLE local_repositories(path TEXT PRIMARY KEY,data TEXT NOT NULL,indexed_at TEXT NOT NULL);
CREATE TABLE ai_usage(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,job_id TEXT REFERENCES scheduled_jobs(id) ON DELETE SET NULL,repository TEXT,purpose TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,effort TEXT NOT NULL,started_at TEXT NOT NULL,ended_at TEXT,duration_ms INTEGER,status TEXT NOT NULL,input_tokens INTEGER,cached_input_tokens INTEGER,output_tokens INTEGER,reasoning_tokens INTEGER,total_tokens INTEGER,error TEXT);
CREATE INDEX ai_usage_time ON ai_usage(started_at);
ALTER TABLE task_messages ADD COLUMN status TEXT NOT NULL DEFAULT 'delivered';
ALTER TABLE task_messages ADD COLUMN configuration TEXT;
ALTER TABLE task_messages ADD COLUMN run_id TEXT;
CREATE TABLE utility_runs(id TEXT PRIMARY KEY,stage INTEGER NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,effort TEXT NOT NULL,prompt TEXT NOT NULL,status TEXT NOT NULL,started_at TEXT NOT NULL,ended_at TEXT,exit_code INTEGER,pid INTEGER,process_identity TEXT,conversation_id TEXT,output TEXT,error TEXT,purpose TEXT NOT NULL);
`,
  },
  {
    version: 9,
    sql: `
INSERT OR IGNORE INTO ai_usage(id,task_id,repository,purpose,provider,model,effort,started_at,ended_at,duration_ms,status,error)
SELECT a.id,a.task_id,r.owner||'/'||r.name,CASE WHEN a.purpose='pipeline' THEN CASE a.stage WHEN 1 THEN 'Antigravity Plan' WHEN 2 THEN 'Codex Plan Refinement' ELSE 'Codex Implementation' END ELSE a.purpose END,a.provider,a.model,a.effort,a.started_at,a.ended_at,CASE WHEN a.ended_at IS NOT NULL THEN MAX(0,CAST(ROUND((julianday(a.ended_at)-julianday(a.started_at))*86400000) AS INTEGER)) END,a.status,a.error FROM agent_runs a JOIN tasks t ON t.id=a.task_id JOIN repositories r ON r.id=t.repo_id;
INSERT OR IGNORE INTO ai_usage(id,job_id,purpose,provider,model,effort,started_at,ended_at,duration_ms,status,error)
SELECT id,job_id,CASE stage WHEN 1 THEN 'PR Review Analysis' ELSE 'Scheduler Verification' END,provider,model,effort,started_at,ended_at,CASE WHEN ended_at IS NOT NULL THEN MAX(0,CAST(ROUND((julianday(ended_at)-julianday(started_at))*86400000) AS INTEGER)) END,status,error FROM scheduled_agent_runs;
`,
  },
  {
    version: 10,
    sql: "ALTER TABLE ai_usage ADD COLUMN subscription_limits TEXT;",
  },
  {
    version: 11,
    sql: `
UPDATE scheduled_attention SET dismissed=1 WHERE error='Cannot read properties of undefined (reading ''slice'')' AND job_id IN (
SELECT id FROM scheduled_jobs WHERE json_extract(data,'$.status')='error' AND json_extract(data,'$.error')='Cannot read properties of undefined (reading ''slice'')' AND json_type(data,'$.pending_snapshot')='object' AND json_type(data,'$.action')='object' AND (json_type(data,'$.action.outstandingRequests') IS NULL OR json_type(data,'$.action.alreadyAddressed') IS NULL)
);
UPDATE scheduled_jobs SET data=json_set(data,'$.status','pending','$.error',NULL,'$.next_run_at',strftime('%Y-%m-%dT%H:%M:%SZ','now'))
WHERE json_extract(data,'$.status')='error' AND json_extract(data,'$.error')='Cannot read properties of undefined (reading ''slice'')' AND json_type(data,'$.pending_snapshot')='object' AND json_type(data,'$.action')='object' AND (json_type(data,'$.action.outstandingRequests') IS NULL OR json_type(data,'$.action.alreadyAddressed') IS NULL);
UPDATE scheduled_jobs SET data=json_insert(data,'$.action.conversationState','neutral','$.action.outstandingRequests',json('[]'),'$.action.alreadyAddressed',json('[]'),'$.action.newActivity',json('[]')) WHERE json_type(data,'$.action')='object';
UPDATE scheduled_jobs SET data=json_insert(data,'$.conversation_action.conversationState','neutral','$.conversation_action.outstandingRequests',json('[]'),'$.conversation_action.alreadyAddressed',json('[]'),'$.conversation_action.newActivity',json('[]')) WHERE json_type(data,'$.conversation_action')='object';
`,
  },
  {
    version: 12,
    foreign_keys_off: true,
    sql: `
CREATE TABLE repositories_new(id TEXT PRIMARY KEY,owner TEXT NOT NULL,name TEXT NOT NULL,data TEXT NOT NULL);
INSERT INTO repositories_new SELECT id,owner,name,json_insert(data,'$.connected',json('true')) FROM repositories;
DROP TABLE repositories;
ALTER TABLE repositories_new RENAME TO repositories;
CREATE UNIQUE INDEX repositories_checkout ON repositories(lower(owner),lower(name),json_extract(data,'$.path'));
`,
  },
];
