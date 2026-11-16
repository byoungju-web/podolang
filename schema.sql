-- 🍇 포도랑 지갑 · 로그인 · 결제 · 동시통역 방 (v9.0)
-- Cloudflare 대시보드 → Storage & Databases → D1 → podolang → Console 에 통째로 붙여넣고 Execute.
-- 여러 번 실행해도 괜찮습니다 (이미 있으면 건너뜀).

CREATE TABLE IF NOT EXISTS pl_users (
  id TEXT PRIMARY KEY,
  google_sub TEXT UNIQUE,
  email TEXT,
  name TEXT,
  tenths INTEGER NOT NULL DEFAULT 0,      -- 크레딧 × 10 (0.1 크레딧 = 1)
  created_at INTEGER,
  last_at INTEGER
);

CREATE TABLE IF NOT EXISTS pl_sessions (
  token_hash TEXT PRIMARY KEY,            -- 로그인 키(pl.…)의 SHA-256 (키 자체는 저장하지 않음)
  user_id TEXT NOT NULL,
  created_at INTEGER,
  last_at INTEGER
);
CREATE INDEX IF NOT EXISTS pl_sessions_user ON pl_sessions(user_id);

CREATE TABLE IF NOT EXISTS pl_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  delta INTEGER,                          -- + 충전·선물·환불 / - 사용 (tenths)
  kind TEXT,
  memo TEXT,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS pl_ledger_user ON pl_ledger(user_id, id);

CREATE TABLE IF NOT EXISTS pl_orders (
  order_id TEXT PRIMARY KEY,
  user_id TEXT,
  product TEXT,
  amount INTEGER,                         -- 원
  tenths INTEGER,                         -- 넣어줄 크레딧 × 10
  status TEXT,                            -- ready · paying · paid
  payment_key TEXT,
  method TEXT,
  created_at INTEGER,
  paid_at INTEGER,
  raw TEXT
);
CREATE INDEX IF NOT EXISTS pl_orders_user ON pl_orders(user_id, status);

CREATE TABLE IF NOT EXISTS pl_rooms (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE,
  kind TEXT,                              -- one · multi
  name TEXT,
  owner TEXT,
  last_body TEXT,
  last_nick TEXT,
  last_at INTEGER,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS pl_members (
  room_id TEXT,
  user_id TEXT,
  nick TEXT,
  lang TEXT,
  joined_at INTEGER,
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS pl_members_user ON pl_members(user_id);

CREATE TABLE IF NOT EXISTS pl_msgs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT,
  user_id TEXT,
  nick TEXT,
  lang TEXT,
  body TEXT,
  tr TEXT,                                -- 번역 JSON { "EN": "...", ... }
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS pl_msgs_room ON pl_msgs(room_id, id);

CREATE TABLE IF NOT EXISTS pl_blocks (
  user_id TEXT,
  blocked TEXT,
  nick TEXT,
  created_at INTEGER,
  PRIMARY KEY (user_id, blocked)
);

CREATE TABLE IF NOT EXISTS pl_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT,
  msg_id INTEGER,
  reporter TEXT,
  target TEXT,
  body TEXT,
  reason TEXT,
  created_at INTEGER
);
