-- Club Assessment Platform schema (v2).
-- Access control is enforced here, not in the UI:
--   * every web request runs in a transaction as app_club, app_assessor or app_admin,
--     with app.uid set to the signed-in user;
--   * GRANTs decide which tables/columns a role can touch at all;
--   * row level security decides which rows;
--   * triggers enforce workflow rules and compute scores, so the UI cannot bypass them.
-- A club lead (CDA) is an assessor account linked to a club in club_leads.
-- Auth tables have no grants to app roles; only the trusted auth layer uses them.

create role app_club nologin;
create role app_assessor nologin;
create role app_admin nologin;

-- ================================================================ core tables
create table clubs (
  id serial primary key,
  name text not null unique,
  tier int not null default 1,
  pool char(1) not null check (pool in ('A','B','C')),
  current_shield text not null default 'None'
);

create table users (
  id serial primary key,
  email text not null unique check (email = lower(email)),
  name text not null,
  role text not null check (role in ('club','assessor','admin')),
  club_id int references clubs(id),
  is_primary boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check ((role = 'club') = (club_id is not null))
);

-- Phases follow sections. Each has its own submission deadline and is closed by the admin.
create table phases (
  id text primary key,
  label text not null,
  sort int not null,
  deadline date,
  closed_at timestamptz
);

-- Club-facing requirement catalogue (loaded from the framework file).
create table requirements (
  id text primary key,
  section text not null references phases(id),
  grp text not null,
  name text not null,
  kind text not null check (kind in ('staff','document','onfield','fq')),   -- what the CLUB does
  type text not null check (type in ('ticks','value','direct','yesno')),   -- how ASSESSORS score
  assessors int not null check (assessors in (1,2)),
  evidence text not null,
  max_score numeric(5,1) not null,
  weight numeric(5,1) not null,
  guidance text not null,
  n_criteria int not null default 0,
  unit text,
  mandatory boolean not null default false,
  optional boolean not null default false,
  only_shields text[],
  except_shields text[],
  sort int not null
);

-- Assessor-only: descriptor, tick criteria and value bands.
create table requirement_criteria (
  req_id text primary key references requirements(id),
  descriptor text not null,
  criteria jsonb not null default '[]',
  bands jsonb
);

create table club_items (
  id serial primary key,
  club_id int not null references clubs(id),
  req_id text not null references requirements(id),
  status text not null default 'not_started'
    check (status in ('not_started','submitted','approved','returned','not_accepted')),
  return_comment text,
  verification text check (verification in ('verified','not_accepted','returned','observed')),
  verified_by int references users(id),
  verified_at timestamptz,
  selected boolean not null default true,      -- planning opt-in for partial pools
  flagged_at timestamptz,
  upload_until date,                            -- admin reopened after the deadline
  updated_at timestamptz not null default now(),
  unique (club_id, req_id)
);

create table extensions (
  club_id int not null references clubs(id),
  phase text not null references phases(id),
  until date not null,
  granted_by int references users(id),
  primary key (club_id, phase)
);

create table staff_rows (
  id serial primary key,
  club_id int not null references clubs(id),
  position text not null,
  person text not null,
  gender text,
  team text,
  qualification text not null,
  qual_expiry date,
  fa_number text,
  blue_card text,
  blue_card_expiry date,
  years_at_club int,
  employment_type text,
  status text not null default 'submitted' check (status in ('submitted','approved','returned','not_accepted')),
  return_comment text,
  verification text check (verification in ('verified','returned','not_accepted')),
  verified_by int references users(id),
  updated_at timestamptz not null default now()
);

create table files (
  id serial primary key,
  club_id int not null references clubs(id),
  req_id text references requirements(id),
  staff_row_id int references staff_rows(id) on delete cascade,
  filename text not null,
  mime text not null,
  size int not null,
  data bytea not null,
  uploaded_by int not null references users(id),
  uploaded_at timestamptz not null default now(),
  check ((req_id is null) <> (staff_row_id is null))
);

-- The club's lead (Club Development Ambassador). Standing relationship for the season.
create table club_leads (
  club_id int primary key references clubs(id),
  lead_id int not null references users(id)
);

-- One row per club x item x slot. No fixed pairs: each slot is filled independently.
create table slots (
  club_id int not null references clubs(id),
  req_id text not null references requirements(id),
  slot text not null check (slot in ('first','second')),
  assessor_id int not null references users(id),
  assigned_at timestamptz not null default now(),
  primary key (club_id, req_id, slot)
);

-- Third assessor for an item whose first and second scores differ.
create table third_assignments (
  club_id int not null references clubs(id),
  req_id text not null references requirements(id),
  assessor_id int not null references users(id),
  assigned_by int references users(id),
  assigned_at timestamptz not null default now(),
  primary key (club_id, req_id)
);

-- Scores. The numeric score is COMPUTED by trigger from ticks / value; assessors
-- only enter a score directly for 'direct' and 'yesno' items.
create table scores (
  club_id int not null references clubs(id),
  req_id text not null references requirements(id),
  slot text not null check (slot in ('first','second','third')),
  assessor_id int not null references users(id),
  ticks jsonb,            -- array of 'y' | 'p' | 'n', one per criterion
  value numeric,          -- measured value for 'value' items
  score numeric(5,1) not null default 0,
  comment text,
  updated_at timestamptz not null default now(),
  primary key (club_id, req_id, slot)
);

-- An assessor locks all their items at one club for one phase.
create table score_locks (
  club_id int not null references clubs(id),
  assessor_id int not null references users(id),
  phase text not null references phases(id),
  locked_at timestamptz not null default now(),
  primary key (club_id, assessor_id, phase)
);

create table resolutions (
  club_id int not null references clubs(id),
  req_id text not null references requirements(id),
  final_score numeric(5,1) not null check (final_score >= 0),
  method text not null check (method in ('agreed','single','third','admin')),
  tick_mismatch boolean not null default false,
  note text,
  resolved_by int references users(id),
  resolved_at timestamptz not null default now(),
  primary key (club_id, req_id)
);

create table prior_scores (
  club_id int not null references clubs(id),
  req_id text not null references requirements(id),
  score numeric(5,1) not null,
  primary key (club_id, req_id)
);

-- Lead's written feedback: one per section plus 'overall'. Hidden from clubs until release.
create table lead_comments (
  club_id int not null references clubs(id),
  section text not null check (section in ('planning','staff','delivery','outcomes','nn','overall')),
  body text not null check (length(trim(body)) > 0),
  updated_by int references users(id),
  updated_at timestamptz not null default now(),
  primary key (club_id, section)
);

create table settings (key text primary key, value text not null);

create table results (
  club_id int primary key references clubs(id),
  total numeric(8,1) not null,
  max_total numeric(8,1) not null,
  pct numeric(5,1) not null,
  rating text not null,
  nn_met boolean not null,
  details jsonb not null,
  released_at timestamptz
);

create table audit_log (
  id serial primary key,
  at timestamptz not null default now(),
  actor_id int,
  action text not null,
  table_name text not null,
  club_id int,
  req_id text,
  detail jsonb,
  reason text
);

-- ================================================================ auth tables (no app grants)
create table magic_links (
  id serial primary key,
  user_id int not null references users(id),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz
);
create table login_codes (
  id serial primary key,
  link_id int not null references magic_links(id),
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  used_at timestamptz
);
create table sessions (
  id serial primary key,
  token_hash text not null unique,
  user_id int not null references users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create table emails (
  id serial primary key,
  to_addr text not null,
  subject text not null,
  body text not null,
  created_at timestamptz not null default now()
);

-- ================================================================ helper functions
-- SECURITY DEFINER so policies can consult protected tables without exposing them.
create function app_uid() returns int language sql stable as
  $$ select nullif(current_setting('app.uid', true), '')::int $$;

create function app_club() returns int language sql stable security definer as
  $$ select club_id from users where id = app_uid() and active $$;

create function app_is_primary() returns boolean language sql stable security definer as
  $$ select coalesce((select is_primary from users where id = app_uid() and active), false) $$;

create function setting(k text) returns text language sql stable security definer as
  $$ select value from settings where key = k $$;

create function my_slot(c int, r text) returns text language sql stable security definer as
  $$ select slot from slots where club_id = c and req_id = r and assessor_id = app_uid() $$;

create function holds_slot_on_club(c int) returns boolean language sql stable security definer as
  $$ select exists (select 1 from slots where club_id = c and assessor_id = app_uid()) $$;

create function holds_staff_slot(c int) returns boolean language sql stable security definer as
  $$ select exists (select 1 from slots s join requirements q on q.id = s.req_id
                    where s.club_id = c and s.assessor_id = app_uid() and q.section = 'staff') $$;

create function is_third_for(c int, r text) returns boolean language sql stable security definer as
  $$ select exists (select 1 from third_assignments where club_id = c and req_id = r and assessor_id = app_uid()) $$;

create function is_third_on_club(c int) returns boolean language sql stable security definer as
  $$ select exists (select 1 from third_assignments where club_id = c and assessor_id = app_uid()) $$;

create function is_third_on_staff(c int) returns boolean language sql stable security definer as
  $$ select exists (select 1 from third_assignments where club_id = c and assessor_id = app_uid() and req_id in (select id from requirements where section = 'staff')) $$;

create function is_lead_for(c int) returns boolean language sql stable security definer as
  $$ select exists (select 1 from club_leads where club_id = c and lead_id = app_uid()) $$;

create function assessor_sees_club(c int) returns boolean language sql stable security definer as
  $$ select holds_slot_on_club(c) or is_third_on_club(c) or is_lead_for(c) $$;

create function released_for(c int) returns boolean language sql stable security definer as
  $$ select exists (select 1 from results where club_id = c and released_at is not null) $$;

-- Does this item count for this club this cycle? Single source of truth for applicability.
create function item_applies(c int, r text) returns boolean language sql stable security definer as $$
  select case
    when q.only_shields is not null and not (cl.current_shield = any(q.only_shields)) then false
    when q.except_shields is not null and cl.current_shield = any(q.except_shields) then false
    when q.optional and cl.pool = any(string_to_array(coalesce(setting('partial_pools'), ''), ','))
         and not coalesce(ci.selected, true) then false
    else true end
  from requirements q cross join clubs cl
  left join club_items ci on ci.club_id = cl.id and ci.req_id = q.id
  where q.id = r and cl.id = c $$;

-- An item is "locked" when every slot it needs is assigned and that assessor has locked the phase.
-- Always true or false (never NULL), because callers use it in NOT conditions.
create function item_locked(c int, r text) returns boolean language sql stable security definer as $$
  select coalesce((
    select count(*) = max(q.assessors)
    from requirements q
    join slots s on s.req_id = q.id and s.club_id = c
    join score_locks l on l.club_id = c and l.assessor_id = s.assessor_id and l.phase = q.section
    where q.id = r
    group by q.id), false) $$;

-- Can the club still upload or change evidence for this item?
create function upload_open(c int, r text) returns boolean language sql stable security definer as $$
  select p.closed_at is null and (
      p.deadline is null or current_date <= p.deadline
      or exists (select 1 from extensions e where e.club_id = c and e.phase = p.id and current_date <= e.until)
      or exists (select 1 from club_items i where i.club_id = c and i.req_id = r and current_date <= i.upload_until))
  from requirements q join phases p on p.id = q.section where q.id = r $$;

create function staff_upload_open(c int) returns boolean language sql stable security definer as $$
  select p.closed_at is null and (p.deadline is null or current_date <= p.deadline
      or exists (select 1 from extensions e where e.club_id = c and e.phase = 'staff' and current_date <= e.until))
  from phases p where p.id = 'staff' $$;

-- ================================================================ integrity triggers
create function trg_slot_guard() returns trigger language plpgsql security definer as $$
declare q requirements;
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from scores where club_id = old.club_id and req_id = old.req_id and slot = old.slot) then
      raise exception 'Cannot unassign %: a score has already been entered', old.req_id;
    end if;
    return old;
  end if;
  select * into q from requirements where id = new.req_id;
  if q.assessors = 1 and new.slot = 'second' then
    raise exception '% is scored by one assessor only', new.req_id;
  end if;
  if not exists (select 1 from users where id = new.assessor_id and role = 'assessor' and active) then
    raise exception 'Only active assessor accounts can be assigned';
  end if;
  if exists (select 1 from slots where club_id = new.club_id and req_id = new.req_id
             and slot <> new.slot and assessor_id = new.assessor_id) then
    raise exception 'The same person cannot be first and second assessor on % for this club', new.req_id;
  end if;
  if exists (select 1 from third_assignments where club_id = new.club_id and req_id = new.req_id and assessor_id = new.assessor_id) then
    raise exception 'This person is the third assessor on %', new.req_id;
  end if;
  if tg_op = 'UPDATE' and old.assessor_id <> new.assessor_id
     and exists (select 1 from scores where club_id = old.club_id and req_id = old.req_id and slot = old.slot) then
    raise exception 'Cannot reassign %: a score has already been entered', old.req_id;
  end if;
  return new;
end $$;
create trigger slot_guard before insert or update or delete on slots for each row execute function trg_slot_guard();

create function trg_third_guard() returns trigger language plpgsql security definer as $$
begin
  if exists (select 1 from slots where club_id = new.club_id and req_id = new.req_id and assessor_id = new.assessor_id) then
    raise exception 'The third assessor cannot be the first or second assessor on this item';
  end if;
  if not exists (select 1 from users where id = new.assessor_id and role = 'assessor' and active) then
    raise exception 'Third assessor must be an active assessor';
  end if;
  return new;
end $$;
create trigger third_guard before insert or update on third_assignments for each row execute function trg_third_guard();

-- Scores: derive slot ownership, compute the score, freeze after lock.
create function trg_score_guard() returns trigger language plpgsql security definer as $$
declare q requirements; crit requirement_criteria; t text; total numeric := 0; n int; b jsonb;
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from score_locks l join requirements q2 on q2.id = old.req_id
               where l.club_id = old.club_id and l.assessor_id = old.assessor_id and l.phase = q2.section) then
      raise exception 'Scores are locked';
    end if;
    return old;
  end if;
  select * into q from requirements where id = new.req_id;
  select * into crit from requirement_criteria where req_id = new.req_id;
  if new.slot = 'third' then
    if not exists (select 1 from third_assignments where club_id = new.club_id and req_id = new.req_id and assessor_id = new.assessor_id) then
      raise exception 'Not the third assessor for %', new.req_id;
    end if;
    if not item_locked(new.club_id, new.req_id) then
      raise exception 'Both assessors must lock in before a third assessment';
    end if;
  else
    if not exists (select 1 from slots where club_id = new.club_id and req_id = new.req_id and slot = new.slot and assessor_id = new.assessor_id) then
      raise exception 'Not assigned to % for this club', new.req_id;
    end if;
    if exists (select 1 from score_locks where club_id = new.club_id and assessor_id = new.assessor_id and phase = q.section) then
      raise exception 'Scores are locked';
    end if;
  end if;
  if not item_applies(new.club_id, new.req_id) then
    raise exception '% is not assessed for this club this cycle', new.req_id;
  end if;

  if q.type = 'ticks' then
    n := jsonb_array_length(coalesce(new.ticks, '[]'));
    if n <> q.n_criteria then raise exception '%: mark every criterion (Yes, Partial or No)', new.req_id; end if;
    for t in select jsonb_array_elements_text(new.ticks) loop
      if t = 'y' then total := total + 1;
      elsif t = 'p' then total := total + coalesce(setting('partial_value'), '0.5')::numeric;
      elsif t <> 'n' then raise exception 'Invalid tick %', t; end if;
    end loop;
    new.score := round(total / q.n_criteria * q.max_score, 1);     -- proportional
    new.value := null;
  elsif q.type = 'value' then
    if new.value is null then raise exception '%: enter the measured value', new.req_id; end if;
    new.score := 0;
    for b in select jsonb_array_elements(crit.bands) loop
      if new.value >= (b->>'min')::numeric then new.score := greatest(new.score, (b->>'score')::numeric); end if;
    end loop;
    new.ticks := null;
  elsif q.type = 'yesno' then
    if new.score not in (0, 1) then raise exception '%: Met or Not met', new.req_id; end if;
    new.ticks := null; new.value := null;
  else
    if new.score is null or new.score < 0 or new.score > q.max_score then
      raise exception 'Score % exceeds maximum % for %', new.score, q.max_score, new.req_id;
    end if;
    new.ticks := null; new.value := null;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger score_guard before insert or update or delete on scores for each row execute function trg_score_guard();

-- Lock: everything the assessor holds at this club in this phase must be scored.
create function trg_lock_guard() returns trigger language plpgsql security definer as $$
declare missing text;
begin
  if not exists (select 1 from slots s join requirements q on q.id = s.req_id
                 where s.club_id = new.club_id and s.assessor_id = new.assessor_id and q.section = new.phase) then
    raise exception 'You have no items to lock in this phase';
  end if;
  select string_agg(s.req_id, ', ' order by q.sort) into missing
  from slots s join requirements q on q.id = s.req_id
  where s.club_id = new.club_id and s.assessor_id = new.assessor_id and q.section = new.phase
    and item_applies(s.club_id, s.req_id)
    and not exists (select 1 from scores x where x.club_id = s.club_id and x.req_id = s.req_id and x.slot = s.slot);
  if missing is not null then raise exception 'Score every item before locking. Missing: %', missing; end if;
  return new;
end $$;
create trigger lock_guard before insert on score_locks for each row execute function trg_lock_guard();

-- After a lock: resolve items that are now complete and agree (or need only one assessor).
-- Disagreements are left for a third assessor. Tick differences are flagged for the admin.
create function trg_after_lock() returns trigger language plpgsql security definer as $$
declare r record;
begin
  for r in
    select q.id, q.assessors, f.score s1, f.ticks t1, s.score s2, s.ticks t2
    from requirements q
    join scores f on f.club_id = new.club_id and f.req_id = q.id and f.slot = 'first'
    left join scores s on s.club_id = new.club_id and s.req_id = q.id and s.slot = 'second'
    where q.section = new.phase and item_locked(new.club_id, q.id) and item_applies(new.club_id, q.id)
  loop
    if r.assessors = 1 then
      insert into resolutions(club_id, req_id, final_score, method, note, resolved_by)
      values (new.club_id, r.id, r.s1, 'single', 'Single assessor (data based)', null) on conflict do nothing;
    elsif r.s1 = r.s2 then
      insert into resolutions(club_id, req_id, final_score, method, tick_mismatch, note, resolved_by)
      values (new.club_id, r.id, r.s1, 'agreed', coalesce(r.t1 <> r.t2, false), 'Both assessors agreed', null)
      on conflict do nothing;
    end if;
  end loop;
  return new;
end $$;
create trigger after_lock after insert on score_locks for each row execute function trg_after_lock();

-- A third assessor's score becomes the final score.
create function trg_after_third() returns trigger language plpgsql security definer as $$
begin
  if new.slot = 'third' then
    insert into resolutions(club_id, req_id, final_score, method, note, resolved_by)
    values (new.club_id, new.req_id, new.score, 'third', new.comment, new.assessor_id)
    on conflict (club_id, req_id) do update set final_score = excluded.final_score, method = 'third',
      note = excluded.note, resolved_by = excluded.resolved_by, resolved_at = now();
  end if;
  return new;
end $$;
create trigger after_third after insert or update on scores for each row execute function trg_after_third();

-- Admin overrides only (other resolutions are created by the triggers above).
-- Invoker rights on purpose: current_user must be the caller's role.
create function trg_resolution_guard() returns trigger language plpgsql as $$
begin
  if current_user = 'app_admin' then
    if not item_locked(new.club_id, new.req_id) then raise exception 'Both assessors must lock in first'; end if;
    if (select closed_at from phases p join requirements q on q.section = p.id where q.id = new.req_id) is not null then
      raise exception 'This phase is closed';
    end if;
    if new.final_score > (select max_score from requirements where id = new.req_id) then raise exception 'Final score exceeds maximum'; end if;
    if coalesce(trim(new.note), '') = '' then raise exception 'A reason is required'; end if;
    new.method := 'admin';
    new.resolved_by := app_uid();
    new.resolved_at := now();
  end if;
  return new;
end $$;
create trigger resolution_guard before insert or update on resolutions for each row execute function trg_resolution_guard();

-- Closing a phase requires every applicable item at every club to be resolved.
create function trg_phase_guard() returns trigger language plpgsql as $$
declare n int;
begin
  if current_user = 'app_admin' and old.closed_at is null and new.closed_at is not null then
    select count(*) into n from clubs c cross join requirements q
    where q.section = new.id and item_applies(c.id, q.id)
      and not exists (select 1 from resolutions r where r.club_id = c.id and r.req_id = q.id);
    if n > 0 then raise exception 'Cannot close %: % item(s) not yet resolved', new.label, n; end if;
  end if;
  return new;
end $$;
create trigger phase_guard before update on phases for each row execute function trg_phase_guard();

-- Club-side state machine on items (invoker rights: checks current_user).
create function trg_item_guard() returns trigger language plpgsql as $$
declare v_count int; q requirements;
begin
  if current_user = 'app_club' then
    select * into q from requirements where id = new.req_id;
    if new.status is distinct from old.status then
      if not ((old.status in ('not_started','returned','submitted') and new.status = 'submitted')
              or (old.status = 'submitted' and new.status = 'not_started')) then
        raise exception 'Clubs can only submit items that are not locked';
      end if;
      if q.kind <> 'document' then raise exception 'This item is assessed by FQ'; end if;
      if not upload_open(new.club_id, new.req_id) then raise exception 'The submission deadline for this section has passed'; end if;
    end if;
    if new.selected is distinct from old.selected then
      if not q.optional or not (select pool from clubs where id = new.club_id) = any(string_to_array(setting('partial_pools'), ',')) then
        raise exception 'This item cannot be chosen or removed';
      end if;
      if old.status <> 'not_started' then raise exception 'Item already submitted'; end if;
      select count(*) into v_count from club_items i join requirements r on r.id = i.req_id
        where i.club_id = new.club_id and r.optional and i.selected and i.id <> new.id;
      if new.selected and v_count >= setting('max_optional')::int then
        raise exception 'Choose at most % optional planning items', setting('max_optional');
      end if;
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger item_guard before update on club_items for each row execute function trg_item_guard();

create function trg_file_guard() returns trigger language plpgsql as $$
declare v_status text; f files;
begin
  if current_user <> 'app_club' then return coalesce(new, old); end if;
  f := coalesce(new, old);
  if f.req_id is not null then
    select status into v_status from club_items where club_id = f.club_id and req_id = f.req_id;
    if (select kind from requirements where id = f.req_id) <> 'document' then raise exception 'This item does not take uploads'; end if;
    if not upload_open(f.club_id, f.req_id) then raise exception 'The submission deadline for this section has passed'; end if;
  else
    select status into v_status from staff_rows where id = f.staff_row_id and club_id = f.club_id;
    if v_status is null then raise exception 'Unknown staff row'; end if;
    if not staff_upload_open(f.club_id) then raise exception 'The submission deadline for this section has passed'; end if;
  end if;
  if v_status in ('approved','not_accepted') then raise exception 'Evidence is locked. Ask FQ to reopen the item.'; end if;
  return coalesce(new, old);
end $$;
create trigger file_guard before insert or delete on files for each row execute function trg_file_guard();

create function trg_staff_guard() returns trigger language plpgsql as $$
begin
  if current_user = 'app_club' then
    if tg_op in ('UPDATE','DELETE') and old.status in ('approved','not_accepted') then
      raise exception 'This row is locked. Ask FQ to reopen it.';
    end if;
    if not staff_upload_open(coalesce(new.club_id, old.club_id)) then
      raise exception 'The submission deadline for this section has passed';
    end if;
    if tg_op = 'DELETE' then return old; end if;
    new.status := 'submitted';
    new.club_id := app_club();
  end if;
  if tg_op = 'DELETE' then return old; end if;
  new.updated_at := now();
  return new;
end $$;
create trigger staff_guard before insert or update or delete on staff_rows for each row execute function trg_staff_guard();

create function trg_user_guard() returns trigger language plpgsql as $$
begin
  if current_user = 'app_club' then
    if new.role <> 'club' or new.club_id <> app_club() or new.is_primary then raise exception 'Invalid invite'; end if;
    if (select count(*) from users where club_id = new.club_id and active) >= 2 then
      raise exception 'Clubs may have at most two contacts';
    end if;
  end if;
  return new;
end $$;
create trigger user_guard before insert on users for each row execute function trg_user_guard();

create function trg_lead_comment_guard() returns trigger language plpgsql as $$
begin
  if current_user = 'app_assessor' then
    if new.section = 'overall' then
      if exists (select 1 from requirements q where item_applies(new.club_id, q.id)
                 and not exists (select 1 from resolutions r where r.club_id = new.club_id and r.req_id = q.id)) then
        raise exception 'The overall comment can be written once every section is reconciled';
      end if;
    elsif exists (select 1 from requirements q where q.section = new.section and item_applies(new.club_id, q.id)
                  and not exists (select 1 from resolutions r where r.club_id = new.club_id and r.req_id = q.id)) then
      raise exception 'This section is not fully reconciled yet';
    end if;
  end if;
  if released_for(new.club_id) then raise exception 'Results are already released'; end if;
  new.updated_by := app_uid();
  new.updated_at := now();
  return new;
end $$;
create trigger lead_comment_guard before insert or update on lead_comments for each row execute function trg_lead_comment_guard();

-- ================================================================ audit (cannot be bypassed by app roles)
create function trg_audit() returns trigger language plpgsql security definer as $$
declare d jsonb;
begin
  d := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  d := d - 'data';
  insert into audit_log(actor_id, action, table_name, club_id, req_id, detail, reason)
  values (app_uid(), lower(tg_op), tg_table_name, (d->>'club_id')::int, d->>'req_id', d,
          nullif(current_setting('app.reason', true), ''));
  return coalesce(new, old);
end $$;
create trigger audit_items after update on club_items for each row
  when (old.status is distinct from new.status or old.verification is distinct from new.verification
        or old.flagged_at is distinct from new.flagged_at or old.selected is distinct from new.selected
        or old.upload_until is distinct from new.upload_until)
  execute function trg_audit();
create trigger audit_staff after insert or update or delete on staff_rows for each row execute function trg_audit();
create trigger audit_files after insert or delete on files for each row execute function trg_audit();
create trigger audit_scores after insert or update on scores for each row execute function trg_audit();
create trigger audit_locks after insert on score_locks for each row execute function trg_audit();
create trigger audit_slots after insert or update or delete on slots for each row execute function trg_audit();
create trigger audit_third after insert or update or delete on third_assignments for each row execute function trg_audit();
create trigger audit_leads after insert or update on club_leads for each row execute function trg_audit();
create trigger audit_res after insert or update or delete on resolutions for each row execute function trg_audit();
create trigger audit_comments after insert or update on lead_comments for each row execute function trg_audit();
create trigger audit_phases after update on phases for each row execute function trg_audit();
create trigger audit_ext after insert or update on extensions for each row execute function trg_audit();
create trigger audit_results after insert or update on results for each row execute function trg_audit();
create trigger audit_settings after insert or update on settings for each row execute function trg_audit();
create trigger audit_users after insert or update on users for each row execute function trg_audit();

-- ================================================================ grants
grant usage on all sequences in schema public to app_club, app_assessor, app_admin;
revoke all on magic_links, login_codes, sessions, emails from public;
grant select on requirements, phases to app_club, app_assessor, app_admin;

-- Club: own data only, limited columns.
grant select on clubs to app_club;
grant select (id, email, name, role, club_id, is_primary, active) on users to app_club;
grant insert (email, name, role, club_id) on users to app_club;
grant select (id, club_id, req_id, status, return_comment, selected, flagged_at, upload_until, updated_at) on club_items to app_club;
grant update (status, selected) on club_items to app_club;
grant select (id, club_id, position, person, gender, team, qualification, qual_expiry, fa_number, blue_card,
              blue_card_expiry, years_at_club, employment_type, status, return_comment, updated_at) on staff_rows to app_club;
grant insert (club_id, position, person, gender, team, qualification, qual_expiry, fa_number, blue_card,
              blue_card_expiry, years_at_club, employment_type) on staff_rows to app_club;
grant update (position, person, gender, team, qualification, qual_expiry, fa_number, blue_card,
              blue_card_expiry, years_at_club, employment_type, status) on staff_rows to app_club;
grant delete on staff_rows to app_club;
grant select, insert, delete on files to app_club;
grant select on results, extensions, lead_comments to app_club;
-- deliberately NO club grant on: requirement_criteria, slots, scores, score_locks, third_assignments,
-- club_leads, resolutions, prior_scores, settings, audit_log.

-- Assessor (incl. leads and third assessors).
grant select on clubs, club_items, staff_rows, files, requirement_criteria, prior_scores, settings, extensions to app_assessor;
grant select (id, email, name, role, club_id, is_primary, active) on users to app_assessor;
grant update (status, return_comment, verification, verified_by, verified_at, flagged_at) on club_items to app_assessor;
grant update (status, return_comment, verification, verified_by) on staff_rows to app_assessor;
grant select, insert, update, delete on scores to app_assessor;
grant select, insert on score_locks to app_assessor;
grant select on slots, third_assignments, club_leads, resolutions to app_assessor;
grant select, insert, update on lead_comments to app_assessor;

-- Admin: oversight. No write access to scores (admin never scores).
grant select on clubs, club_items, staff_rows, files, requirement_criteria, prior_scores, score_locks, audit_log to app_admin;
grant select (id, email, name, role, club_id, is_primary, active, created_at) on users to app_admin;
grant insert (email, name, role, club_id, is_primary) on users to app_admin;
grant update (name, active) on users to app_admin;
grant insert, update on clubs to app_admin;
grant insert on club_items to app_admin;
grant update (status, return_comment, verification, verified_by, verified_at, flagged_at, upload_until) on club_items to app_admin;
grant update (status, return_comment, verification, verified_by) on staff_rows to app_admin;
grant select, insert, update, delete on slots, third_assignments, club_leads, extensions to app_admin;
grant select, insert, update, delete on resolutions to app_admin;
grant select on scores to app_admin;
grant update (deadline, closed_at) on phases to app_admin;
grant select, insert, update on settings, lead_comments to app_admin;
grant select, insert, update on results to app_admin;

-- ================================================================ row level security
alter table clubs enable row level security;
alter table users enable row level security;
alter table requirements enable row level security;
alter table requirement_criteria enable row level security;
alter table phases enable row level security;
alter table club_items enable row level security;
alter table extensions enable row level security;
alter table staff_rows enable row level security;
alter table files enable row level security;
alter table club_leads enable row level security;
alter table slots enable row level security;
alter table third_assignments enable row level security;
alter table scores enable row level security;
alter table score_locks enable row level security;
alter table resolutions enable row level security;
alter table prior_scores enable row level security;
alter table lead_comments enable row level security;
alter table settings enable row level security;
alter table results enable row level security;
alter table audit_log enable row level security;

create policy req_all on requirements for select using (true);
create policy phases_all on phases for select using (true);
create policy phases_admin on phases for update to app_admin using (true) with check (true);
create policy crit_staff on requirement_criteria for select to app_assessor, app_admin using (true);
create policy settings_read on settings for select to app_assessor, app_admin using (true);
create policy settings_admin on settings for all to app_admin using (true) with check (true);

create policy clubs_club on clubs for select to app_club using (id = app_club());
create policy clubs_assessor on clubs for select to app_assessor using (assessor_sees_club(id));
create policy clubs_admin on clubs for all to app_admin using (true) with check (true);

create policy users_self on users for select using (id = app_uid());
create policy users_club on users for select to app_club using (club_id = app_club());
create policy users_club_invite on users for insert to app_club
  with check (app_is_primary() and role = 'club' and club_id = app_club());
create policy users_staff on users for select to app_assessor using (role in ('assessor','admin'));
create policy users_admin on users for all to app_admin using (true) with check (true);

-- Items and evidence: assessors see only items they hold (or third-assess); leads see all of their clubs.
create policy items_club on club_items for select to app_club using (club_id = app_club());
create policy items_club_upd on club_items for update to app_club using (club_id = app_club()) with check (club_id = app_club());
create policy items_assessor on club_items for select to app_assessor
  using (my_slot(club_id, req_id) is not null or is_third_for(club_id, req_id) or is_lead_for(club_id));
create policy items_assessor_upd on club_items for update to app_assessor
  using (my_slot(club_id, req_id) is not null) with check (my_slot(club_id, req_id) is not null);
create policy items_admin on club_items for all to app_admin using (true) with check (true);

create policy ext_club on extensions for select to app_club using (club_id = app_club());
create policy ext_assessor on extensions for select to app_assessor using (assessor_sees_club(club_id));
create policy ext_admin on extensions for all to app_admin using (true) with check (true);

create policy staff_club on staff_rows for all to app_club using (club_id = app_club()) with check (club_id = app_club());
create policy staff_assessor on staff_rows for select to app_assessor using (holds_staff_slot(club_id) or is_third_on_staff(club_id) or is_lead_for(club_id));
create policy staff_assessor_upd on staff_rows for update to app_assessor using (holds_staff_slot(club_id)) with check (holds_staff_slot(club_id));
create policy staff_admin on staff_rows for all to app_admin using (true) with check (true);

create policy files_club on files for all to app_club
  using (club_id = app_club()) with check (club_id = app_club() and uploaded_by = app_uid());
create policy files_assessor on files for select to app_assessor
  using (my_slot(club_id, req_id) is not null or is_third_for(club_id, req_id) or is_lead_for(club_id)
         or (staff_row_id is not null and (holds_staff_slot(club_id) or is_third_on_staff(club_id))));
create policy files_admin on files for select to app_admin using (true);

create policy leads_self on club_leads for select to app_assessor using (lead_id = app_uid());
create policy leads_admin on club_leads for all to app_admin using (true) with check (true);

-- Assessors see only their own slots: nobody learns who else is scoring the same item.
create policy slots_own on slots for select to app_assessor using (assessor_id = app_uid());
create policy slots_admin on slots for all to app_admin using (true) with check (true);
create policy third_own on third_assignments for select to app_assessor using (assessor_id = app_uid());
create policy third_admin on third_assignments for all to app_admin using (true) with check (true);

-- BLIND scoring. Own rows only. The third assessor of an item, and the admin, see
-- first and second scores only once the item is locked by both. Leads never see them.
create policy scores_own on scores for select to app_assessor using (assessor_id = app_uid());
create policy scores_third on scores for select to app_assessor using (is_third_for(club_id, req_id) and item_locked(club_id, req_id));
create policy scores_ins on scores for insert to app_assessor with check (assessor_id = app_uid());
create policy scores_upd on scores for update to app_assessor using (assessor_id = app_uid()) with check (assessor_id = app_uid());
create policy scores_del on scores for delete to app_assessor using (assessor_id = app_uid());
create policy scores_admin on scores for select to app_admin using (item_locked(club_id, req_id));

create policy locks_own on score_locks for select to app_assessor using (assessor_id = app_uid());
create policy locks_ins on score_locks for insert to app_assessor with check (assessor_id = app_uid());
create policy locks_admin on score_locks for select to app_admin using (true);

-- Final scores: admin; the third assessor for their item; the lead for their clubs.
create policy res_third on resolutions for select to app_assessor using (is_third_for(club_id, req_id));
create policy res_lead on resolutions for select to app_assessor using (is_lead_for(club_id));
create policy res_admin on resolutions for all to app_admin using (true) with check (true);

create policy prior_assessor on prior_scores for select to app_assessor
  using (my_slot(club_id, req_id) is not null or is_third_for(club_id, req_id) or is_lead_for(club_id));
create policy prior_admin on prior_scores for select to app_admin using (true);

create policy comments_lead on lead_comments for all to app_assessor using (is_lead_for(club_id)) with check (is_lead_for(club_id));
create policy comments_admin on lead_comments for all to app_admin using (true) with check (true);
create policy comments_club on lead_comments for select to app_club using (club_id = app_club() and released_for(club_id));

create policy results_club on results for select to app_club using (club_id = app_club() and released_at is not null);
create policy results_admin on results for all to app_admin using (true) with check (true);

-- Audit: admin only; score entries stay sealed until that item is locked by both assessors.
create policy audit_admin on audit_log for select to app_admin
  using (table_name <> 'scores' or item_locked(club_id, req_id));
