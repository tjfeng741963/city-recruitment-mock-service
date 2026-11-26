CREATE TABLE device_group_snapshots (
    device_code TEXT PRIMARY KEY,
    account_id  TEXT NOT NULL,
    synced_at   INTEGER NOT NULL
);
