-- Register the Email agent in the agents table (drives orchestrator discovery,
-- /api/agents deploy dropdown, Health Services card). Backend already built:
-- LXC 110, service email-agent, tables in 001_email.sql. Idempotent.
INSERT INTO agents
  (name, description, lxc_id, lxc_ip, service_name, data_table, settings_table,
   deploy_path, git_branch, service_oneshot, enabled)
VALUES
  ('email',
   'Gmail two-way client + incoming-mail automation (poller → MQTT → rule engine)',
   110, '192.168.1.162', 'email-agent', 'email_messages', 'email_state',
   '/opt/email-agent', 'main', false, true)
ON CONFLICT (name) DO NOTHING;
