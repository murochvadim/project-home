-- Register the Email agent in the agents table (drives orchestrator discovery,
-- /api/agents deploy dropdown, Health Services card). Backend already built:
-- LXC 110, service email-agent, tables in 001_email.sql. Idempotent.
--
-- data_table / settings_table are NULL ON PURPOSE: email is a service agent but
-- NOT a boiler-style decision loop. The orchestrator runs a schedule check
-- (SELECT next_ts FROM <data_table>) + settings check on agents that declare
-- those, and the Gmail-cache tables have no ts/next_ts/agent_enabled columns —
-- pointing at them raised `agent_schedule_check_failed`. Same shape as the other
-- non-loop service agents (ingest / player / whisper-http).
-- NOTE: the orchestrator also SSHes to lxc_ip to check the service — LXC 110 must
-- have the orchestrator's (LXC 105 root@MainAgent) pubkey in authorized_keys.
INSERT INTO agents
  (name, description, lxc_id, lxc_ip, service_name, data_table, settings_table,
   deploy_path, git_branch, service_oneshot, enabled)
VALUES
  ('email',
   'Gmail two-way client + incoming-mail automation (poller → MQTT → rule engine)',
   110, '192.168.1.162', 'email-agent', NULL, NULL,
   '/opt/email-agent', 'main', false, true)
ON CONFLICT (name) DO NOTHING;
