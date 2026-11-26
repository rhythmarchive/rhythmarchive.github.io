-- Seed only after verifying the account-wide allowance. No automatic reset.
CREATE TABLE download_read_budget (utc_month TEXT PRIMARY KEY, remaining INTEGER NOT NULL CHECK (remaining BETWEEN 0 AND 500000)) WITHOUT ROWID;
