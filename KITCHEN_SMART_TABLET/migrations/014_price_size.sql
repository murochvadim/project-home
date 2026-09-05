-- KITCHEN_SMART_TABLET — remember how big a pinned item is.
-- Applied: scp to LXC 104 -> psql -h 192.168.1.219 -U postgres -d home_data (trust auth).
-- Re-runnable.
--
-- WHY: the picker showed price + name + maker but NOT the size, and that is exactly what made three
-- wrong picks look reasonable: "לימון בלאדי ₪17.10" reads like a bag of lemons until you see it is a
-- 250 gram packet (₪68/kg), and "ליקר בטעם בננה ₪70.90" is a 500 ml bottle. Size is the field that
-- makes a wrong item obvious at a glance, so it is shown in the picker and kept on the pinned row.
ALTER TABLE kitchen_product_items ADD COLUMN IF NOT EXISTS size_text TEXT;
