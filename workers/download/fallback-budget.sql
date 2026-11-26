-- Manual daily allowance only after checking the ROS plan and remaining transfer.
CREATE TABLE ros_fallback_budget (utc_day TEXT PRIMARY KEY, remaining INTEGER NOT NULL CHECK(remaining BETWEEN 0 AND 32000000)) WITHOUT ROWID;
