-- מרוצי יעד לדוגמה — מוסיף לכל המשתמשים הקיימים (הריצו אחרי שנרשמתם לאפליקציה).
insert into public.races (user_id, name, race_date, distance_km, target_time_s, priority)
select u.id, r.name, r.race_date, r.distance_km, r.target_time_s, r.priority
from auth.users u
cross join (values
  ('חצי מרתון — נובמבר', date '2026-11-27', 21.0975, 6300,  'B'),  -- 1:45:00
  ('מרתון מלא — פברואר', date '2027-02-26', 42.195,  13500, 'A')   -- 3:45:00
) as r(name, race_date, distance_km, target_time_s, priority)
on conflict do nothing;
