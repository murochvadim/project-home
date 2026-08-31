-- Group metadata for the WhatsApp tab's "all groups + owner + participants" view.
-- owner_jid + participant_count come from Baileys groupFetchAllParticipating (updated
-- on connect); the full participant list is fetched on-demand per group via the API.
-- Idempotent.
ALTER TABLE whatsapp_chats ADD COLUMN IF NOT EXISTS owner_jid          TEXT;
ALTER TABLE whatsapp_chats ADD COLUMN IF NOT EXISTS participant_count  INTEGER;
