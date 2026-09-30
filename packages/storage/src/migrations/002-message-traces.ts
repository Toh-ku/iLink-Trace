export const messageTraceMigration = `
  CREATE TABLE message_traces (
    id TEXT PRIMARY KEY REFERENCES protocol_events(id) ON DELETE CASCADE,
    account_id TEXT,
    source TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    context_fingerprint TEXT,
    run_id TEXT,
    client_id TEXT,
    user_id TEXT,
    summary_json TEXT NOT NULL
  );
  CREATE INDEX idx_message_traces_page ON message_traces(started_at DESC, id DESC);
  CREATE INDEX idx_message_traces_context ON message_traces(account_id, source, context_fingerprint);
  CREATE INDEX idx_message_traces_run ON message_traces(account_id, source, run_id);
  CREATE INDEX idx_message_traces_client ON message_traces(account_id, source, client_id);
  CREATE INDEX idx_message_traces_user ON message_traces(account_id, source, user_id, started_at);
  CREATE TABLE trace_spans (
    event_id TEXT PRIMARY KEY REFERENCES protocol_events(id) ON DELETE CASCADE,
    trace_id TEXT REFERENCES message_traces(id) ON DELETE CASCADE,
    confidence TEXT NOT NULL,
    reason TEXT NOT NULL,
    candidates_json TEXT NOT NULL
  );
  CREATE INDEX idx_trace_spans_trace ON trace_spans(trace_id);
`;
