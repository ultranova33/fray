-- ==========================================================================
-- Fray: Supabase setup (v2: private accounts)
-- Run once in Supabase Dashboard > SQL Editor. Safe to re-run.
--
-- Also do this once in the Dashboard:
--   Authentication > Sign In / Providers > Email: turn OFF "Confirm email".
--   (Fray accounts use a username; no real email is ever sent.)
-- ==========================================================================

create extension if not exists pgcrypto;

-- --------------------------------------------------------------------------
-- 0. Keep any tables from the first (username-only) version as backups.
--    Nothing is deleted; they're renamed to *_v1_backup.
-- --------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'tasks' and column_name = 'owner')
     and not exists (select 1 from information_schema.tables
                     where table_schema = 'public' and table_name = 'tasks_v1_backup') then
    if exists (select 1 from pg_publication_tables
               where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tasks') then
      alter publication supabase_realtime drop table public.tasks;
    end if;
    alter table public.tasks rename to tasks_v1_backup;
  end if;

  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'push_subscriptions' and column_name = 'owner')
     and not exists (select 1 from information_schema.tables
                     where table_schema = 'public' and table_name = 'push_subscriptions_v1_backup') then
    alter table public.push_subscriptions rename to push_subscriptions_v1_backup;
  end if;
end $$;

drop function if exists public.save_push_subscription(text, text, text, text, text);
drop function if exists public.delete_push_subscription(text);

-- --------------------------------------------------------------------------
-- 1. Profiles: one per account, created automatically on sign-up.
-- --------------------------------------------------------------------------
create table if not exists public.profiles (
  id             uuid primary key references auth.users (id) on delete cascade,
  username       text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  tz             text not null default 'UTC',
  rollover       boolean not null default true,   -- unfinished tasks move to today
  timer_alerts   boolean not null default true,
  nudge_enabled  boolean not null default true,   -- 9pm "Setup tasks for tomorrow!"
  mood_pin       text check (mood_pin is null or char_length(mood_pin) <= 40),
  nudged_on      date,                            -- last local date a nudge was sent
  created_at     timestamptz not null default now()
);

alter table public.profiles enable row level security;
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (rollover, timer_alerts, nudge_enabled, mood_pin) on public.profiles to authenticated;

drop policy if exists "profiles: read own"   on public.profiles;
drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: read own"   on public.profiles for select to authenticated using (id = auth.uid());
create policy "profiles: update own" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- New auth user -> profile row (username comes from sign-up metadata).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username)
  values (new.id, lower(coalesce(new.raw_user_meta_data ->> 'username', split_part(new.email, '@', 1))));
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- The app reports the phone's time zone; bad values fall back to UTC.
create or replace function public.set_timezone(p_tz text)
returns text language plpgsql security definer set search_path = public as $$
declare
  safe text := 'UTC';
begin
  begin
    perform now() at time zone p_tz;
    safe := p_tz;
  exception when others then
    safe := 'UTC';
  end;
  update public.profiles set tz = safe where id = auth.uid();
  return safe;
end $$;

revoke all on function public.set_timezone(text) from public;
grant execute on function public.set_timezone(text) to authenticated;

-- --------------------------------------------------------------------------
-- 2. Tasks: private to their owner.
-- --------------------------------------------------------------------------
create table if not exists public.tasks (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title         text not null check (char_length(btrim(title)) between 1 and 200),
  category      text check (category is null or char_length(category) <= 40),
  for_date      date not null,                    -- the day this task is planned for
  goal_minutes  integer check (goal_minutes is null or goal_minutes between 1 and 2880),
  deadline_at   timestamptz,
  completed     boolean not null default false,
  completed_at  timestamptz,
  push_sent_at  timestamptz,                      -- set by the send-due-pushes function
  created_at    timestamptz not null default now(),
  constraint deadline_needs_goal check (deadline_at is null or goal_minutes is not null)
);

create index if not exists tasks_user_day_idx on public.tasks (user_id, for_date);
create index if not exists tasks_due_idx on public.tasks (deadline_at)
  where completed = false and push_sent_at is null;

create or replace function public.tasks_set_completed_at()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.completed_at := case when new.completed then now() end;
  elsif new.completed and not old.completed then
    new.completed_at := now();
  elsif not new.completed then
    new.completed_at := null;
  end if;
  return new;
end $$;

drop trigger if exists tasks_completed_at on public.tasks;
create trigger tasks_completed_at
  before insert or update of completed on public.tasks
  for each row execute function public.tasks_set_completed_at();

alter table public.tasks enable row level security;
revoke all on public.tasks from anon, authenticated;
grant select, insert, delete on public.tasks to authenticated;
grant update (title, category, for_date, goal_minutes, deadline_at, completed, push_sent_at)
  on public.tasks to authenticated;

drop policy if exists "tasks: own rows" on public.tasks;
create policy "tasks: own rows" on public.tasks for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Realtime: changes reach your other devices instantly.
alter table public.tasks replica identity full;
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tasks') then
    alter publication supabase_realtime add table public.tasks;
  end if;
end $$;

-- --------------------------------------------------------------------------
-- 3. History: a snapshot of each finished day (tasks set / tasks done),
--    taken the first time the app opens after midnight, before rollover.
-- --------------------------------------------------------------------------
create table if not exists public.day_stats (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  day        date not null,
  set_count  integer not null check (set_count >= 0),
  done_count integer not null check (done_count >= 0),
  primary key (user_id, day)
);

alter table public.day_stats enable row level security;
revoke all on public.day_stats from anon, authenticated;
grant select on public.day_stats to authenticated;

drop policy if exists "day_stats: read own" on public.day_stats;
create policy "day_stats: read own" on public.day_stats for select to authenticated
  using (user_id = auth.uid());

-- Closes every past day not yet recorded, then (if the user chose Roll over)
-- moves unfinished past tasks to today. p_today is the phone's local date.
create or replace function public.close_days(p_today date)
returns void language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  roll boolean;
begin
  if me is null then return; end if;

  insert into public.day_stats (user_id, day, set_count, done_count)
  select me, t.for_date, count(*), count(*) filter (where t.completed)
  from public.tasks t
  where t.user_id = me and t.for_date < p_today
  group by t.for_date
  on conflict (user_id, day) do nothing;

  select rollover into roll from public.profiles where id = me;
  if coalesce(roll, true) then
    update public.tasks
       set for_date = p_today
     where user_id = me and for_date < p_today and not completed;
  end if;

  -- Keep the table small: history only shows 3 days.
  delete from public.day_stats where user_id = me and day < p_today - 14;
end $$;

revoke all on function public.close_days(date) from public;
grant execute on function public.close_days(date) to authenticated;

-- --------------------------------------------------------------------------
-- 4. Quote bank: read-only for every app user.
--    Add, edit or remove quotes in Dashboard > Table Editor > quotes.
--    No app account (not even yours) can change them.
-- --------------------------------------------------------------------------
create table if not exists public.quotes (
  id          bigint generated always as identity primary key,
  quote       text not null check (char_length(quote) between 1 and 400),
  author      text not null default '' check (char_length(author) <= 120),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (quote, author)
);

alter table public.quotes alter column author set default '';
alter table public.quotes drop constraint if exists quotes_author_check;
alter table public.quotes add constraint quotes_author_check check (char_length(author) <= 120);

alter table public.quotes enable row level security;
revoke all on public.quotes from anon, authenticated;
grant select on public.quotes to anon, authenticated;

drop policy if exists "quotes: read active" on public.quotes;
create policy "quotes: read active" on public.quotes
  for select to anon, authenticated using (active);

-- Remove the placeholder quotes from the first version of this script.
delete from public.quotes where (quote, author) in (values
  ('The secret of getting ahead is getting started.', 'Mark Twain'),
  ('It does not matter how slowly you go as long as you do not stop.', 'Confucius'),
  ('Well done is better than well said.', 'Benjamin Franklin'),
  ('You miss 100% of the shots you don''t take.', 'Wayne Gretzky'),
  ('Simplicity is the ultimate sophistication.', 'Clare Boothe Luce'),
  ('What you do today can improve all your tomorrows.', 'Ralph Marston'),
  ('How we spend our days is, of course, how we spend our lives.', 'Annie Dillard'),
  ('Nothing will work unless you do.', 'Maya Angelou'),
  ('The best way out is always through.', 'Robert Frost'),
  ('Act as if what you do makes a difference. It does.', 'William James'),
  ('If you spend too much time thinking about a thing, you''ll never get it done.', 'Bruce Lee'),
  ('The man who moves a mountain begins by carrying away small stones.', 'Confucius'),
  ('Do what you can, with what you have, where you are.', 'Theodore Roosevelt'),
  ('Little by little, one travels far.', 'J.R.R. Tolkien'),
  ('We are what we repeatedly do.', 'Will Durant'),
  ('Start where you are. Use what you have. Do what you can.', 'Arthur Ashe'),
  ('The future depends on what you do today.', 'Mahatma Gandhi'),
  ('Lost time is never found again.', 'Benjamin Franklin'),
  ('It always seems impossible until it''s done.', 'Nelson Mandela'),
  ('Done is better than perfect.', 'Sheryl Sandberg'),
  ('Focus on being productive instead of busy.', 'Tim Ferriss'),
  ('Either you run the day or the day runs you.', 'Jim Rohn'),
  ('Amateurs sit and wait for inspiration, the rest of us just get up and go to work.', 'Stephen King'),
  ('You can''t use up creativity. The more you use, the more you have.', 'Maya Angelou'),
  ('The way to get started is to quit talking and begin doing.', 'Walt Disney'),
  ('Courage doesn''t always roar. Sometimes it''s the quiet voice at the end of the day saying, ''I will try again tomorrow.''', 'Mary Anne Radmacher'),
  ('Believe you can and you''re halfway there.', 'Theodore Roosevelt'),
  ('Happiness is not something ready made. It comes from your own actions.', 'Dalai Lama'),
  ('Small deeds done are better than great deeds planned.', 'Peter Marshall'),
  ('A year from now you may wish you had started today.', 'Karen Lamb'),
  ('Action is the foundational key to all success.', 'Pablo Picasso'),
  ('Inspiration exists, but it has to find you working.', 'Pablo Picasso'),
  ('You don''t have to see the whole staircase, just take the first step.', 'Martin Luther King Jr.'),
  ('Life is what happens when you''re busy making other plans.', 'Allen Saunders'),
  ('Be kind, for everyone you meet is fighting a hard battle.', 'Ian Maclaren'),
  ('The best time to plant a tree was 20 years ago. The second best time is now.', 'Chinese Proverb'),
  ('Quality is not an act, it is a habit.', 'Will Durant'),
  ('Rest when you''re weary. Refresh and renew yourself, your body, your mind, your spirit. Then get back to work.', 'Ralph Marston'),
  ('There is no substitute for hard work.', 'Thomas Edison'),
  ('Energy and persistence conquer all things.', 'Benjamin Franklin'),
  ('The only way to do great work is to love what you do.', 'Steve Jobs'),
  ('If you want to go fast, go alone. If you want to go far, go together.', 'African Proverb'),
  ('Make each day your masterpiece.', 'John Wooden'),
  ('Don''t watch the clock; do what it does. Keep going.', 'Sam Levenson'),
  ('One day or day one. You decide.', 'Paulo Coelho'),
  ('Wherever you go, go with all your heart.', 'Confucius'),
  ('Keep your face always toward the sunshine, and shadows will fall behind you.', 'Walt Whitman'),
  ('Well begun is half done.', 'Aristotle'),
  ('Almost everything will work again if you unplug it for a few minutes, including you.', 'Anne Lamott'),
  ('Today is a good day to have a good day.', 'Unknown')
);


-- Seed the 40 quotes from daily_quotes.txt (matches QUOTE_BANK in quotes.js).
insert into public.quotes (quote, author) values
  ('Sweat more in peace. Bleed less in war.', ''),
  ('Depression cannot hit a moving target.', ''),
  ('You are exactly where you''re supposed to be.', ''),
  ('Tire yourself out.', ''),
  ('Hate the process? You''re supposed to.', ''),
  ('How you do anything is how you do everything.', ''),
  ('Museum of failures or gallery of trying?', ''),
  ('I am nothing if not (in)consistent.', ''),
  ('The odds of success far outweigh the odds of failure.', ''),
  ('You can never get anything wrong. You only find another way.', ''),
  ('Life is a series of ridiculous attempts to feel alive.', ''),
  ('You don''t need permission to be you.', ''),
  ('Make something of yourself, then make something else.', ''),
  ('The attempt is the whole point.', ''),
  ('You can be a complete mess and still be onto something.', ''),
  ('If they can''t see the vision, build it where they can.', ''),
  ('Be delusional enough to start. Be disciplined enough to finish.', ''),
  ('You weren''t born to fit neatly into someone else''s imagination.', ''),
  ('Have the audacity. Match your ability.', ''),
  ('Don''t shrink the dream to fit the room.', ''),
  ('You can waste your life trying not to waste it.', ''),
  ('The universe owes you nothing. You get to make something anyway.', ''),
  ('Nobody knows what they''re doing. Some people just commit harder.', ''),
  ('You are a biological accident with a to-do list.', ''),
  ('There is no arriving. There is only being here.', ''),
  ('Life is mostly maintenance interrupted by miracles.', ''),
  ('You don''t have to make every experience mean something.', ''),
  ('Nobody remembers the almosts.', ''),
  ('A mediocre attempt beats immaculate intention.', ''),
  ('You can restart without making an announcement.', ''),
  ('Your life is made of things you did on unremarkable days.', ''),
  ('Do the work before you decide you''re the kind of person who can''t.', ''),
  ('You don''t need to win the day. Just don''t abandon it.', ''),
  ('You are allowed to want an unreasonable amount from life.', ''),
  ('Make peace with being misunderstood. Make sure the work is worth it.', ''),
  ('You can be grateful for the life you have and impatient with the one you''re building.', ''),
  ('One day, you''ll wish you could return to a day you thought was ordinary.', ''),
  ('Be here, now.', ''),
  ('The boring days stack up.', ''),
  ('It''s all in your head. Get out of it.', '')
on conflict (quote, author) do nothing;

-- --------------------------------------------------------------------------
-- 5. Phone push subscriptions (one row per device).
-- --------------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  endpoint    text primary key check (endpoint like 'https://%'),
  user_id     uuid not null references auth.users (id) on delete cascade,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  updated_at  timestamptz not null default now()
);

create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;

-- Saves this device for the signed-in account (moves it if another account
-- used this device before).
create or replace function public.save_push_subscription(
  p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into public.push_subscriptions (endpoint, user_id, p256dh, auth, user_agent, updated_at)
  values (p_endpoint, auth.uid(), p_p256dh, p_auth, left(p_user_agent, 300), now())
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
        user_agent = excluded.user_agent, updated_at = now();
end $$;

create or replace function public.delete_push_subscription(p_endpoint text)
returns void
language sql security definer set search_path = public as $$
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
$$;

revoke all on function public.save_push_subscription(text, text, text, text) from public;
revoke all on function public.delete_push_subscription(text) from public;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;
grant execute on function public.delete_push_subscription(text) to authenticated;

-- --------------------------------------------------------------------------
-- 6. 9pm nudge: called by the send-due-pushes function (service role only).
--    Picks accounts where it's 9pm-10pm locally, not nudged yet today, and
--    with nothing planned for tomorrow, and marks them as nudged.
-- --------------------------------------------------------------------------
create or replace function public.claim_due_nudges()
returns table (user_id uuid)
language sql security definer set search_path = public as $$
  update public.profiles p
     set nudged_on = (now() at time zone p.tz)::date
   where p.nudge_enabled
     and extract(hour from (now() at time zone p.tz)) = 21
     and (p.nudged_on is null or p.nudged_on < (now() at time zone p.tz)::date)
     and not exists (
       select 1 from public.tasks t
        where t.user_id = p.id
          and t.for_date = (now() at time zone p.tz)::date + 1
     )
  returning p.id;
$$;

revoke all on function public.claim_due_nudges() from public, anon, authenticated;
grant execute on function public.claim_due_nudges() to service_role;

-- --------------------------------------------------------------------------
-- Quick check (optional):
-- select count(*) from public.quotes;            -- 40
-- select * from pg_publication_tables where pubname = 'supabase_realtime';
-- --------------------------------------------------------------------------
