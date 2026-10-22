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
UPDATE tasks SET data=json_set(data,'$.scope_mode','partial') WHERE json_valid(data);
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
SELECT id FROM scheduled_jobs WHERE json_extract(CASE WHEN json_valid(data) THEN data END,'$.status')='error' AND json_extract(CASE WHEN json_valid(data) THEN data END,'$.error')='Cannot read properties of undefined (reading ''slice'')' AND json_type(CASE WHEN json_valid(data) THEN data END,'$.pending_snapshot')='object' AND json_type(CASE WHEN json_valid(data) THEN data END,'$.action')='object' AND (json_type(CASE WHEN json_valid(data) THEN data END,'$.action.outstandingRequests') IS NULL OR json_type(CASE WHEN json_valid(data) THEN data END,'$.action.alreadyAddressed') IS NULL)
);
UPDATE scheduled_jobs SET data=json_set(data,'$.status','pending','$.error',NULL,'$.next_run_at',strftime('%Y-%m-%dT%H:%M:%SZ','now'))
WHERE json_extract(CASE WHEN json_valid(data) THEN data END,'$.status')='error' AND json_extract(CASE WHEN json_valid(data) THEN data END,'$.error')='Cannot read properties of undefined (reading ''slice'')' AND json_type(CASE WHEN json_valid(data) THEN data END,'$.pending_snapshot')='object' AND json_type(CASE WHEN json_valid(data) THEN data END,'$.action')='object' AND (json_type(CASE WHEN json_valid(data) THEN data END,'$.action.outstandingRequests') IS NULL OR json_type(CASE WHEN json_valid(data) THEN data END,'$.action.alreadyAddressed') IS NULL);
UPDATE scheduled_jobs SET data=json_insert(data,'$.action.conversationState','neutral','$.action.outstandingRequests',json('[]'),'$.action.alreadyAddressed',json('[]'),'$.action.newActivity',json('[]')) WHERE json_type(CASE WHEN json_valid(data) THEN data END,'$.action')='object';
UPDATE scheduled_jobs SET data=json_insert(data,'$.conversation_action.conversationState','neutral','$.conversation_action.outstandingRequests',json('[]'),'$.conversation_action.alreadyAddressed',json('[]'),'$.conversation_action.newActivity',json('[]')) WHERE json_type(CASE WHEN json_valid(data) THEN data END,'$.conversation_action')='object';
`,
  },
  {
    version: 12,
    foreign_keys_off: true,
    sql: `
CREATE TABLE repositories_new(id TEXT PRIMARY KEY,owner TEXT NOT NULL,name TEXT NOT NULL,data TEXT NOT NULL);
INSERT INTO repositories_new SELECT id,owner,name,CASE WHEN json_valid(data) THEN json_insert(data,'$.connected',json('true')) ELSE data END FROM repositories;
DROP TABLE repositories;
ALTER TABLE repositories_new RENAME TO repositories;
CREATE UNIQUE INDEX repositories_checkout ON repositories(lower(owner),lower(name),json_extract(CASE WHEN json_valid(data) THEN data END,'$.path'));
`,
  },
  {
    version: 13,
    sql: `
ALTER TABLE ai_usage ADD COLUMN subscription_limits_after TEXT;
ALTER TABLE ai_usage ADD COLUMN provider_session_id TEXT;
UPDATE ai_usage SET provider_session_id=COALESCE((SELECT conversation_id FROM agent_runs WHERE agent_runs.id=ai_usage.id),(SELECT conversation_id FROM scheduled_agent_runs WHERE scheduled_agent_runs.id=ai_usage.id),(SELECT conversation_id FROM utility_runs WHERE utility_runs.id=ai_usage.id));
CREATE TABLE task_reviewed_files(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,path TEXT NOT NULL,source_hash TEXT NOT NULL,reviewed_at TEXT NOT NULL,PRIMARY KEY(task_id,path));
CREATE TABLE code_questions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,path TEXT NOT NULL,old_path TEXT,side TEXT NOT NULL,line_start INTEGER NOT NULL,line_end INTEGER NOT NULL,selected_code TEXT NOT NULL,source_hash TEXT NOT NULL,question TEXT NOT NULL,answer TEXT,status TEXT NOT NULL,error TEXT,run_id TEXT,created_at TEXT NOT NULL);
CREATE INDEX code_questions_task ON code_questions(task_id,created_at);
`,
  },
  {
    version: 14,
    sql: `UPDATE tasks SET stage=6,data=json_set(data,'$.stage',6) WHERE json_valid(data) AND stage=5 AND status IN ('ready_for_review','completed');`,
  },
  {
    version: 15,
    sql: `UPDATE tasks SET status='awaiting_approval',stage=5,data=json_set(data,'$.status','awaiting_approval','$.stage',5,'$.approval_gate','implementation') WHERE json_valid(data) AND status='ready_for_review' AND NOT EXISTS(SELECT 1 FROM task_artifacts a WHERE a.task_id=tasks.id AND a.stage=5 AND a.kind='plan');`,
  },
  {
    version: 16,
    sql: `ALTER TABLE test_runs ADD COLUMN run_id TEXT;
ALTER TABLE test_runs ADD COLUMN call_id TEXT;
ALTER TABLE test_runs ADD COLUMN output_truncated INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX test_runs_provider_call ON test_runs(task_id,run_id,call_id);`,
  },
  {
    version: 17,
    sql: `
UPDATE settings SET value=json_set(value,'$.auto_watch',json('false')) WHERE key='github_watch' AND json_valid(value);
UPDATE scheduled_jobs SET data=json_set(data,'$.enabled',json('false'),'$.check_once',json('false'),'$.status',CASE WHEN json_extract(CASE WHEN json_valid(data) THEN data END,'$.status') IN ('polling','pending','analyzing') THEN 'interrupted' ELSE COALESCE(json_extract(CASE WHEN json_valid(data) THEN data END,'$.status'),'idle') END) WHERE json_valid(data);
INSERT OR REPLACE INTO settings VALUES('pr_execution_policy','"manual_only_v1"');
`,
  },
  {
    version: 18,
    sql: `
CREATE TABLE pr_analyses(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,status TEXT NOT NULL,started_at TEXT NOT NULL,ended_at TEXT,data TEXT NOT NULL);
CREATE INDEX pr_analyses_job ON pr_analyses(job_id,started_at);
CREATE TABLE pr_review_actions(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,anchor TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(job_id,anchor));
CREATE TABLE pr_action_assessments(analysis_id TEXT NOT NULL REFERENCES pr_analyses(id) ON DELETE CASCADE,action_id TEXT NOT NULL REFERENCES pr_review_actions(id) ON DELETE CASCADE,data TEXT NOT NULL,PRIMARY KEY(analysis_id,action_id));
ALTER TABLE scheduled_agent_runs ADD COLUMN analysis_id TEXT REFERENCES pr_analyses(id) ON DELETE SET NULL;
ALTER TABLE ai_usage ADD COLUMN analysis_id TEXT REFERENCES pr_analyses(id) ON DELETE SET NULL;
`,
  },
  {
    version: 19,
    sql: `
CREATE TABLE pr_repairs(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES scheduled_jobs(id),repo_id TEXT NOT NULL REFERENCES repositories(id),analysis_id TEXT NOT NULL REFERENCES pr_analyses(id),status TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE INDEX pr_repairs_job ON pr_repairs(job_id,created_at);
CREATE TABLE repair_messages(id TEXT PRIMARY KEY,repair_id TEXT NOT NULL REFERENCES pr_repairs(id),role TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE repair_activity(id INTEGER PRIMARY KEY AUTOINCREMENT,repair_id TEXT NOT NULL REFERENCES pr_repairs(id),kind TEXT NOT NULL,data TEXT NOT NULL,timestamp TEXT NOT NULL);
CREATE TABLE repair_publications(id TEXT PRIMARY KEY,repair_id TEXT NOT NULL REFERENCES pr_repairs(id),status TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE INDEX repair_publications_session ON repair_publications(repair_id,created_at);
CREATE TABLE repair_reviewed_files(repair_id TEXT NOT NULL REFERENCES pr_repairs(id),path TEXT NOT NULL,source_hash TEXT NOT NULL,reviewed_at TEXT NOT NULL,PRIMARY KEY(repair_id,path));
`,
  },
  {
    version: 20,
    foreign_keys_off: true,
    sql: `
CREATE TABLE agent_runs_new(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),stage INTEGER NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,effort TEXT NOT NULL,prompt TEXT NOT NULL,status TEXT NOT NULL,started_at TEXT NOT NULL,ended_at TEXT,exit_code INTEGER,pid INTEGER,process_identity TEXT,conversation_id TEXT,output TEXT,error TEXT,purpose TEXT NOT NULL DEFAULT 'pipeline',repair_id TEXT REFERENCES pr_repairs(id),CHECK((task_id IS NOT NULL)+(repair_id IS NOT NULL)=1));
INSERT INTO agent_runs_new(id,task_id,stage,provider,model,effort,prompt,status,started_at,ended_at,exit_code,pid,process_identity,conversation_id,output,error,purpose) SELECT id,task_id,stage,provider,model,effort,prompt,status,started_at,ended_at,exit_code,pid,process_identity,conversation_id,output,error,purpose FROM agent_runs;
DROP TABLE agent_runs;
ALTER TABLE agent_runs_new RENAME TO agent_runs;
CREATE INDEX repair_runs ON agent_runs(repair_id,started_at);
CREATE TABLE agent_events_new(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES agent_runs(id),task_id TEXT REFERENCES tasks(id),timestamp TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL,raw TEXT NOT NULL,stream TEXT NOT NULL,repair_id TEXT REFERENCES pr_repairs(id),CHECK((task_id IS NOT NULL)+(repair_id IS NOT NULL)=1));
INSERT INTO agent_events_new(id,run_id,task_id,timestamp,kind,data,raw,stream) SELECT id,run_id,task_id,timestamp,kind,data,raw,stream FROM agent_events;
DROP TABLE agent_events;
ALTER TABLE agent_events_new RENAME TO agent_events;
CREATE INDEX task_events ON agent_events(task_id,id);
CREATE INDEX repair_events ON agent_events(repair_id,id);
CREATE TABLE test_runs_new(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),command TEXT NOT NULL,status TEXT NOT NULL,started_at TEXT NOT NULL,ended_at TEXT,exit_code INTEGER,duration_ms INTEGER,stdout TEXT NOT NULL DEFAULT '',stderr TEXT NOT NULL DEFAULT '',pid INTEGER,process_identity TEXT,run_id TEXT,call_id TEXT,output_truncated INTEGER NOT NULL DEFAULT 0,repair_id TEXT REFERENCES pr_repairs(id),CHECK((task_id IS NOT NULL)+(repair_id IS NOT NULL)=1));
INSERT INTO test_runs_new(id,task_id,command,status,started_at,ended_at,exit_code,duration_ms,stdout,stderr,pid,process_identity,run_id,call_id,output_truncated) SELECT id,task_id,command,status,started_at,ended_at,exit_code,duration_ms,stdout,stderr,pid,process_identity,run_id,call_id,output_truncated FROM test_runs;
DROP TABLE test_runs;
ALTER TABLE test_runs_new RENAME TO test_runs;
CREATE UNIQUE INDEX test_runs_provider_call ON test_runs(run_id,call_id);
CREATE INDEX repair_tests ON test_runs(repair_id,started_at);
CREATE TABLE terminal_sessions_new(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,status TEXT NOT NULL,started_at TEXT NOT NULL,ended_at TEXT,pid INTEGER,process_identity TEXT,exit_code INTEGER,repair_id TEXT REFERENCES pr_repairs(id),CHECK((task_id IS NOT NULL)+(repair_id IS NOT NULL)=1));
INSERT INTO terminal_sessions_new(id,task_id,status,started_at,ended_at,pid,process_identity,exit_code) SELECT id,task_id,status,started_at,ended_at,pid,process_identity,exit_code FROM terminal_sessions;
DROP TABLE terminal_sessions;
ALTER TABLE terminal_sessions_new RENAME TO terminal_sessions;
ALTER TABLE ai_usage ADD COLUMN repair_id TEXT REFERENCES pr_repairs(id) ON DELETE SET NULL;
CREATE INDEX repair_usage ON ai_usage(repair_id,started_at);
`,
  },
  {
    version: 21,
    sql: `
CREATE TABLE persistence_diagnostics(table_name TEXT NOT NULL,record_id TEXT NOT NULL,column_name TEXT NOT NULL,source_hash TEXT NOT NULL,first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,resolved_at TEXT,PRIMARY KEY(table_name,record_id,column_name));
CREATE TABLE task_requests(request_id TEXT PRIMARY KEY,digest TEXT NOT NULL,task_id TEXT UNIQUE REFERENCES tasks(id) ON DELETE SET NULL,created_at TEXT NOT NULL);
DROP INDEX IF EXISTS repositories_checkout;
CREATE UNIQUE INDEX repositories_checkout ON repositories(lower(owner),lower(name),CASE WHEN json_valid(data) THEN json_extract(CASE WHEN json_valid(data) THEN data END,'$.path') END);
`,
  },
  {
    version: 22,
    sql: `
CREATE TABLE issue_watches(id TEXT PRIMARY KEY,name TEXT NOT NULL,repository_id TEXT NOT NULL,repository_full_name TEXT NOT NULL,current_revision INTEGER NOT NULL CHECK(current_revision>0),archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN(0,1)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,last_complete_scan_id TEXT REFERENCES issue_watch_scans(id),data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE issue_watch_revisions(watch_id TEXT NOT NULL REFERENCES issue_watches(id),revision INTEGER NOT NULL CHECK(revision>0),request_id TEXT NOT NULL UNIQUE,request_digest TEXT NOT NULL,created_at TEXT NOT NULL,rules_digest TEXT NOT NULL,compiler_version INTEGER NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,effort TEXT NOT NULL,timeout_secs INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(watch_id,revision));
CREATE TABLE issue_watch_scans(id TEXT PRIMARY KEY,watch_id TEXT NOT NULL,revision INTEGER NOT NULL,request_id TEXT NOT NULL UNIQUE,request_digest TEXT NOT NULL,parent_scan_id TEXT REFERENCES issue_watch_scans(id),intent TEXT NOT NULL CHECK(intent IN('scan','retry','continue','recheck')),status TEXT NOT NULL CHECK(status IN('running','cancelling','completed','partial','blocked','failed','cancelled','interrupted')),phase TEXT NOT NULL,started_at TEXT NOT NULL,ended_at TEXT,semantic_attempts INTEGER NOT NULL DEFAULT 0 CHECK(semantic_attempts IN(0,1)),utility_run_id TEXT REFERENCES utility_runs(id),data TEXT NOT NULL CHECK(json_valid(data)),FOREIGN KEY(watch_id,revision) REFERENCES issue_watch_revisions(watch_id,revision));
CREATE UNIQUE INDEX issue_watch_active ON issue_watch_scans(watch_id) WHERE status IN('running','cancelling');
CREATE INDEX issue_watch_scan_history ON issue_watch_scans(watch_id,started_at);
CREATE TABLE issue_watch_sources(scan_id TEXT NOT NULL REFERENCES issue_watch_scans(id),source_key TEXT NOT NULL,kind TEXT NOT NULL,url TEXT NOT NULL,revision_digest TEXT NOT NULL,fetched_at TEXT NOT NULL,complete INTEGER NOT NULL CHECK(complete IN(0,1)),data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(scan_id,source_key));
CREATE TABLE issue_watch_candidates(scan_id TEXT NOT NULL REFERENCES issue_watch_scans(id),issue_id TEXT NOT NULL,repository_id TEXT NOT NULL,number INTEGER NOT NULL CHECK(number>0),claim_state TEXT NOT NULL,semantic_state TEXT NOT NULL,checked_at TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(scan_id,issue_id));
CREATE INDEX issue_watch_candidate_state ON issue_watch_candidates(scan_id,claim_state);
CREATE INDEX issue_watch_candidate_identity ON issue_watch_candidates(repository_id,number);
CREATE TABLE issue_watch_results(watch_id TEXT NOT NULL REFERENCES issue_watches(id),issue_id TEXT NOT NULL,last_evaluated_scan_id TEXT NOT NULL REFERENCES issue_watch_scans(id),last_complete_match_scan_id TEXT REFERENCES issue_watch_scans(id),classification TEXT NOT NULL,dismissed_at TEXT,first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(watch_id,issue_id));
`,
  },
  {
    version: 23,
    sql: `
ALTER TABLE utility_runs ADD COLUMN watch_id TEXT REFERENCES issue_watches(id) ON DELETE SET NULL;
ALTER TABLE utility_runs ADD COLUMN scan_id TEXT REFERENCES issue_watch_scans(id) ON DELETE SET NULL;
CREATE INDEX utility_scan_runs ON utility_runs(scan_id,started_at);
ALTER TABLE ai_usage ADD COLUMN watch_id TEXT REFERENCES issue_watches(id) ON DELETE SET NULL;
ALTER TABLE ai_usage ADD COLUMN scan_id TEXT REFERENCES issue_watch_scans(id) ON DELETE SET NULL;
CREATE INDEX issue_watch_usage ON ai_usage(watch_id,scan_id,started_at);
CREATE TABLE utility_events(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES utility_runs(id) ON DELETE CASCADE,timestamp TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),raw TEXT NOT NULL,stream TEXT NOT NULL);
CREATE INDEX utility_run_events ON utility_events(run_id,id);
`,
  },
];
