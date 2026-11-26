CREATE TABLE download_source_daily (
  stat_date TEXT NOT NULL, resource_id TEXT NOT NULL, source TEXT NOT NULL,
  events INTEGER NOT NULL, logical_bytes INTEGER NOT NULL, manual INTEGER NOT NULL, automatic INTEGER NOT NULL,
  PRIMARY KEY(stat_date,resource_id,source)
) WITHOUT ROWID;
