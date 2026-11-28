-- [fork] W22: 10-minute per-model activity per organization, recomputed from
-- request_metrics by the cron rollup. A model is one (provider, method) pair.
-- busy is the average number of the pair's requests running in the bucket
-- (busy_max: the peak 10 s value), requests counts the ones that finished in
-- it. Never pruned.
CREATE TABLE model_activity_rollups (
  organization_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  method TEXT NOT NULL,
  ts INTEGER NOT NULL,
  busy REAL NOT NULL,
  busy_max REAL NOT NULL,
  requests INTEGER NOT NULL,
  errors INTEGER NOT NULL,
  latency_ms_sum INTEGER NOT NULL,
  tokens_input INTEGER NOT NULL,
  tokens_output INTEGER NOT NULL,
  units INTEGER NOT NULL,
  PRIMARY KEY (organization_id, provider, method, ts)
) WITHOUT ROWID;
