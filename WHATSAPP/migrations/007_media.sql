-- The message node for MEDIA messages, kept as protobuf bytes.
-- Why: WhatsApp media is encrypted; without the node (mediaKey / directPath /
-- fileEncSha256 / mimetype) the bytes can never be fetched. Protobuf, NOT JSON —
-- every binary field is a Uint8Array that JSON.stringify would mangle.
-- Also holds the small embedded jpegThumbnail, so previews cost no WhatsApp traffic.
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS media_proto BYTEA;
