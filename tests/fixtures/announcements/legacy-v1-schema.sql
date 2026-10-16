-- Announcement schema copied read-only from checkpoint 9f6189d3581f24a1b63c8a265b8cb66659b7ab1c.
-- This fixture contains schema only; every row is fabricated by the rehearsal test.
PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY); INSERT OR IGNORE INTO schema_version VALUES(1);
      CREATE TABLE IF NOT EXISTS gmail_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,guild TEXT NOT NULL,account TEXT NOT NULL,message_id TEXT NOT NULL,hash TEXT NOT NULL,metadata TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,UNIQUE(account,message_id));
      CREATE TABLE IF NOT EXISTS source_attachments(id TEXT PRIMARY KEY,source TEXT NOT NULL REFERENCES sources(id),hash TEXT NOT NULL,mime TEXT NOT NULL,bytes INTEGER NOT NULL,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_evidence(source TEXT PRIMARY KEY REFERENCES sources(id),evidence_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_holds(source TEXT NOT NULL REFERENCES sources(id),event_key TEXT NOT NULL REFERENCES events(event_key),PRIMARY KEY(source,event_key));
      CREATE TABLE IF NOT EXISTS candidate_batches(id TEXT PRIMARY KEY,source TEXT NOT NULL REFERENCES sources(id),hash TEXT NOT NULL,UNIQUE(source,hash));
      CREATE TABLE IF NOT EXISTS candidate_events(id TEXT PRIMARY KEY,guild TEXT NOT NULL,batch TEXT NOT NULL REFERENCES candidate_batches(id),event_key TEXT NOT NULL,event_json TEXT NOT NULL,catalog_json TEXT NOT NULL,issues_json TEXT NOT NULL,confidence TEXT NOT NULL,base_revision INTEGER NOT NULL,review_version INTEGER NOT NULL DEFAULT 1,state TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS candidate_holds ON candidate_events(guild,event_key,state);
      CREATE TABLE IF NOT EXISTS candidate_sources(candidate TEXT NOT NULL REFERENCES candidate_events(id),source TEXT NOT NULL REFERENCES sources(id),PRIMARY KEY(candidate,source));
      CREATE TABLE IF NOT EXISTS events(event_key TEXT PRIMARY KEY,guild TEXT NOT NULL,revision INTEGER NOT NULL,event_json TEXT NOT NULL,catalog_json TEXT NOT NULL,approved_by TEXT NOT NULL,approved_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS event_revisions(event_key TEXT NOT NULL REFERENCES events(event_key),revision INTEGER NOT NULL,event_json TEXT NOT NULL,catalog_json TEXT NOT NULL,actor TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(event_key,revision));
      CREATE TABLE IF NOT EXISTS announcement_assets(id TEXT PRIMARY KEY,guild TEXT NOT NULL,hash TEXT NOT NULL,path TEXT NOT NULL,mime TEXT NOT NULL,bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS announcement_jobs(id TEXT PRIMARY KEY,guild TEXT NOT NULL,event_key TEXT NOT NULL REFERENCES events(event_key),revision INTEGER NOT NULL,policy TEXT NOT NULL,channel TEXT NOT NULL,role TEXT,due INTEGER NOT NULL,expires INTEGER NOT NULL,major INTEGER NOT NULL,asset_policy TEXT NOT NULL,asset TEXT REFERENCES announcement_assets(id),payload_json TEXT NOT NULL,state TEXT NOT NULL,message TEXT,approved_by TEXT,held_from TEXT,UNIQUE(event_key,revision,policy,channel));
      CREATE INDEX IF NOT EXISTS announcement_due ON announcement_jobs(state,due);
      CREATE TABLE IF NOT EXISTS announcement_drafts(job TEXT PRIMARY KEY REFERENCES announcement_jobs(id),state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS delivery_attempts(job TEXT PRIMARY KEY REFERENCES announcement_jobs(id),state TEXT NOT NULL,message TEXT,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY,guild TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,snapshot TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS staff_alerts(id TEXT PRIMARY KEY,guild TEXT NOT NULL,kind TEXT NOT NULL,target TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',message TEXT,at INTEGER NOT NULL,UNIQUE(guild,kind,target));
      CREATE TABLE IF NOT EXISTS operational_incidents(guild TEXT NOT NULL,provider TEXT NOT NULL,episode TEXT NOT NULL,active INTEGER NOT NULL,last_notice INTEGER NOT NULL,count INTEGER NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(guild,provider));
      CREATE TABLE IF NOT EXISTS source_failures(source TEXT PRIMARY KEY REFERENCES sources(id),provider TEXT NOT NULL,reason TEXT NOT NULL,at INTEGER NOT NULL);
