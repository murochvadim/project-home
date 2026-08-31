-- Register the WhatsApp agent in the agents table (orchestrator discovery,
-- /api/agents deploy dropdown, Health Services card). Idempotent.
--
-- data_table / settings_table are NULL ON PURPOSE: like the email agent, this is a
-- service cache, NOT a boiler-style decision loop. Pointing the orchestrator's
-- schedule check at a cache table (no ts/next_ts/agent_enabled) raises
-- `agent_schedule_check_failed`. Same shape as email / ingest / player.
-- NOTE: LXC 114 must have the orchestrator's (LXC 105 root) pubkey in
-- authorized_keys so its per-agent service SSH check passes (else service_ssh_failed).
INSERT INTO agents
  (name, description, lxc_id, lxc_ip, service_name, data_table, settings_table,
   deploy_path, git_branch, service_oneshot, enabled)
VALUES
  ('whatsapp',
   'WhatsApp personal-account agent (Baileys → MQTT + HTTP API → dashboard/rules)',
   114, '192.168.1.228', 'whatsapp-agent', NULL, NULL,
   '/opt/whatsapp-agent', 'main', false, true)
ON CONFLICT (name) DO NOTHING;
