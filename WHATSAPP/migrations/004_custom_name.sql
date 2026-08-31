-- Per-chat custom label (dashboard-only). Lets the user rename any chat — most
-- useful for anonymized @lid chats that resolve to no name/number. Kept in its OWN
-- column so the Baileys sync (which only writes `name`) never clobbers it; the
-- /chats resolver puts custom_name FIRST in the display chain. Idempotent.
ALTER TABLE whatsapp_chats ADD COLUMN IF NOT EXISTS custom_name TEXT;
