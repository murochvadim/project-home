-- KITCHEN_SMART_TABLET — realistic starter catalog (Hebrew names + emoji).
-- Re-runnable: only inserts a product whose name doesn't already exist.
INSERT INTO kitchen_products (name, name_en, category, emoji, unit, price, sort_order)
SELECT v.name, v.name_en, v.category, v.emoji, v.unit, v.price, v.sort_order
FROM (VALUES
  -- produce
  ('עגבניות',      'Tomatoes',      'produce',  '🍅', 'kg',    7.9,  1),
  ('מלפפונים',     'Cucumbers',     'produce',  '🥒', 'kg',    6.9,  2),
  ('בצל',          'Onion',         'produce',  '🧅', 'kg',    4.9,  3),
  ('תפוחי אדמה',   'Potatoes',      'produce',  '🥔', 'kg',    5.9,  4),
  ('גזר',          'Carrots',       'produce',  '🥕', 'kg',    5.5,  5),
  ('פלפל אדום',    'Red pepper',    'produce',  '🫑', 'kg',    12.9, 6),
  ('תפוחים',       'Apples',        'produce',  '🍎', 'kg',    9.9,  7),
  ('בננות',        'Bananas',       'produce',  '🍌', 'kg',    8.9,  8),
  ('לימון',        'Lemon',         'produce',  '🍋', 'kg',    9.9,  9),
  ('אבוקדו',       'Avocado',       'produce',  '🥑', 'piece', 4.5,  10),
  -- dairy
  ('גבינה צהובה',  'Yellow cheese', 'dairy',    '🧀', 'pack',  18.9, 12),
  ('קוטג''',        'Cottage',       'dairy',    '🥛', 'tub',   6.9,  13),
  ('ביצים',        'Eggs',          'dairy',    '🥚', 'pack',  14.9, 14),
  ('יוגורט',       'Yogurt',        'dairy',    '🥛', 'pack',  4.5,  15),
  ('חמאה',         'Butter',        'dairy',    '🧈', 'pack',  8.9,  16),
  -- bakery
  ('לחם',          'Bread',         'bakery',   '🍞', 'loaf',  7.5,  17),
  ('פיתות',        'Pita',          'bakery',   '🫓', 'pack',  6.9,  18),
  ('חלה',          'Challah',       'bakery',   '🥖', 'piece', 9.9,  19),
  -- meat & fish
  ('חזה עוף',      'Chicken breast','meat',     '🍗', 'kg',    34.9, 20),
  ('בשר טחון',     'Ground beef',   'meat',     '🥩', 'kg',    49.9, 21),
  ('סלמון',        'Salmon',        'meat',     '🐟', 'kg',    89.9, 22),
  -- pantry
  ('אורז',         'Rice',          'pantry',   '🍚', 'pack',  9.9,  23),
  ('פסטה',         'Pasta',         'pantry',   '🍝', 'pack',  6.9,  24),
  ('שמן זית',      'Olive oil',     'pantry',   '🫒', 'bottle',34.9, 25),
  ('קמח',          'Flour',         'pantry',   '🌾', 'pack',  5.9,  26),
  ('סוכר',         'Sugar',         'pantry',   '🍬', 'pack',  5.5,  27),
  ('טחינה',        'Tahini',        'pantry',   '🥣', 'jar',   16.9, 28),
  ('חומוס',        'Hummus',        'pantry',   '🫘', 'tub',   7.9,  29),
  ('קפה',          'Coffee',        'beverage', '☕', 'pack',  24.9, 31),
  ('מיץ תפוזים',   'Orange juice',  'beverage', '🧃', 'bottle',8.9,  32),
  ('מים',          'Water 6-pack',  'beverage', '💧', 'pack',  11.9, 33),
  ('שוקולד',       'Chocolate',     'snack',    '🍫', 'bar',   5.9,  35),
  ('ביסקוויטים',   'Biscuits',      'snack',    '🍪', 'pack',  6.9,  36),
  ('גלידה',        'Ice cream',     'frozen',   '🍦', 'tub',   24.9, 37)
) AS v(name, name_en, category, emoji, unit, price, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM kitchen_products p WHERE p.name = v.name);

-- put the existing Milk demo in its dairy slot
UPDATE kitchen_products SET category='dairy', unit='L', sort_order=11 WHERE name='חלב';
