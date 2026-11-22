-- Club Assessment Platform schema.
-- Access control is enforced here, not in the UI:
--   * every web request runs inside a transaction as one of three DB roles
--     (app_club, app_assessor, app_admin) with app.uid set to the user id;
--   * table/column GRANTs decide what each role can touch at all;
--   * row level security policies decide which rows.
-- The auth tables (users secrets, links, codes, sessions, outbox) have no grants
-- to the app roles and are only used by the trusted auth layer.

create role app_club nologin;
create role app_assessor nologin;
create role app_admin nologin;

-- ---------------------------------------------------------------- core tables
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

create table requirements (
  id text primary key,                 -- e.g. P2, D8, T01, NN3
  section text not null check (section in ('staff','planning','delivery','outcomes','nn')),
  grp text not null,
  name text not null,
  kind text not null check (kind in ('staff','document','onfield','fq')),
  evidence text not null,
  max_score numeric(5,1) not null,
  weight numeric(5,1) not null,
  guidance text not null,              -- club-facing
  sort int not null
);

-- Assessor-only scoring criteria. Separate table so clubs get no grant at all.
create table requirement_criteria (
  req_id text primary key references requirements(id),
  criteria text not null
);

create table club_items (
  id serial primary key,
  club_id int not null references clubs(id),
  req_id text not null references requirements(id),
  status text not null default 'not_started'
    check (status in ('not_started','submitted','approved','returned','closed')),
  return_comment text,
  verification text check (verification in ('verified','rejected','returned','observed')),
  verified_by int references users(id),
  verified_at timestamptz,
  selected boolean not null default true,   -- planning opt-in for pool A/C
  flagged_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (club_id, req_id)
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
  status text not null default 'submitted'
    check (status in ('submitted','approved','returned','closed')),
  return_comment text,
  verification text check (verification in ('verified','rejected','returned')),
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

create table assignments (
  club_id int primary key references clubs(id),
  first_id int references users(id),
  second_id int references users(id),
  check (first_id is null or second_id is null or first_id <> second_id)
);

create table scores (
  id serial primary key,
  club_id int not null references clubs(id),
  req_id text not null references requirements(id),
  assessor_id int not null references users(id),
  slot text not null check (slot in ('first','second')),
  score numeric(5,1) not null check (score >= 0),
  note text,
  updated_at timestamptz not null default now(),
  unique (club_id, req_id, assessor_id)
);

create table score_locks (
  club_id int not null references clubs(id),
  assessor_id int not null references users(id),
  locked_at timestamptz not null default now(),
  primary key (club_id, assessor_id)
);

create table moderations (
  club_id int not null references clubs(id),
  req_id text not null references requirements(id),
  moderator_id int not null references users(id),
  assigned_by int references users(id),
  assigned_at timestamptz not null default now(),
  primary key (club_id, req_id)
);

create table resolutions (
  club_id int not null references clubs(id),
  req_id text not null references requirements(id),
  final_score numeric(5,1) not null check (final_score >= 0),
  method text not null check (method in ('auto','moderator','consensus','admin')),
  note text,
  resolved_by int references users(id),
  resolved_at timestamptz not null default now(),
  primary key (club_id, req_id)
);

-- Previous-cycle final scores, used for the Pool A/C planning carry-forward.
create table prior_scores (
  club_id int not null references clubs(id),
  req_id text not null references requirements(id),
  score numeric(5,1) not null,
  primary key (club_id, req_id)
);

create table settings (
  key text primary key,
  value text not null
);

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

-- ---------------------------------------------------------------- auth tables (no app grants)
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

-- ---------------------------------------------------------------- helper functions
-- SECURITY DEFINER so policies can consult other protected tables without leaking them.
create function app_uid() returns int language sql stable as
  $$ select nullif(current_setting('app.uid', true), '')::int $$;

create function app_club() returns int language sql stable security definer as
  $$ select club_id from users where id = app_uid() and active $$;

create function app_is_primary() returns boolean language sql stable security definer as
  $$ select coalesce((select is_primary from users where id = app_uid() and active), false) $$;

create function assessor_slot(c int) returns text language sql stable security definer as
  $$ select case when first_id = app_uid() then 'first' when second_id = app_uid() then 'second' end
     from assignments where club_id = c $$;

create function is_moderator_for(c int, r text) returns boolean language sql stable security definer as
  $$ select exists (select 1 from moderations where club_id = c and req_id = r and moderator_id = app_uid()) $$;

create function is_moderator_on_club(c int) returns boolean language sql stable security definer as
  $$ select exists (select 1 from moderations where club_id = c and moderator_id = app_uid()) $$;

create function is_moderator_on_staff(c int) returns boolean language sql stable security definer as
  $$ select exists (select 1 from moderations where club_id = c and moderator_id = app_uid() and req_id like 'T%') $$;

create function assessor_sees_club(c int) returns boolean language sql stable security definer as
  $$ select assessor_slot(c) is not null or is_moderator_on_club(c) $$;

create function both_locked(c int) returns boolean language sql stable security definer as
  $$ select exists (
       select 1 from assignments a
       where a.club_id = c and a.first_id is not null and a.second_id is not null
         and exists (select 1 from score_locks l where l.club_id = c and l.assessor_id = a.first_id)
         and exists (select 1 from score_locks l where l.club_id = c and l.assessor_id = a.second_id)) $$;

create function i_have_locked(c int) returns boolean language sql stable security definer as
  $$ select exists (select 1 from score_locks where club_id = c and assessor_id = app_uid()) $$;

-- ---------------------------------------------------------------- integrity triggers
-- Same person cannot be first and second (CHECK above) nor moderate a club they assess.
create function trg_assignment_guard() returns trigger language plpgsql security definer as $$
begin
  if exists (select 1 from moderations m where m.club_id = new.club_id
             and m.moderator_id in (new.first_id, new.second_id)) then
    raise exception 'This person is a moderator on this club and cannot also be an assessor for it';
  end if;
  if exists (select 1 from users u where u.id in (new.first_id, new.second_id) and u.role <> 'assessor') then
    raise exception 'Only assessor accounts can be assigned';
  end if;
  return new;
end $$;
create trigger assignment_guard before insert or update on assignments
  for each row execute function trg_assignment_guard();

create function trg_moderation_guard() returns trigger language plpgsql security definer as $$
begin
  if exists (select 1 from assignments a where a.club_id = new.club_id
             and new.moderator_id in (a.first_id, a.second_id)) then
    raise exception 'The moderator cannot be the first or second assessor for this club';
  end if;
  if not exists (select 1 from users u where u.id = new.moderator_id and u.role = 'assessor' and u.active) then
    raise exception 'Moderator must be an active assessor';
  end if;
  return new;
end $$;
create trigger moderation_guard before insert or update on moderations
  for each row execute function trg_moderation_guard();

-- Scores: slot is derived from the assignment, and locked scores are frozen.
create function trg_score_guard() returns trigger language plpgsql security definer as $$
declare r requirements;
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from score_locks where club_id = old.club_id and assessor_id = old.assessor_id) then
      raise exception 'Scores are locked';
    end if;
    return old;
  end if;
  select * into r from requirements where id = new.req_id;
  if new.score > r.max_score then
    raise exception 'Score % exceeds maximum % for %', new.score, r.max_score, new.req_id;
  end if;
  new.slot := (select case when first_id = new.assessor_id then 'first'
                           when second_id = new.assessor_id then 'second' end
               from assignments where club_id = new.club_id);
  if new.slot is null then raise exception 'Not assigned to this club'; end if;
  if exists (select 1 from score_locks where club_id = new.club_id and assessor_id = new.assessor_id) then
    raise exception 'Scores are locked';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger score_guard before insert or update or delete on scores
  for each row execute function trg_score_guard();

-- Resolutions only once both assessors have locked in.
-- Invoker rights on purpose: current_user must be the caller's role, not the owner.
create function trg_resolution_guard() returns trigger language plpgsql as $$
declare r requirements;
begin
  if not both_locked(new.club_id) then
    raise exception 'Both assessors must lock in before reconciliation';
  end if;
  select * into r from requirements where id = new.req_id;
  if new.final_score > r.max_score then raise exception 'Final score exceeds maximum'; end if;
  if current_user = 'app_assessor' and new.method <> 'moderator' then
    raise exception 'Moderators can only record moderator resolutions';
  end if;
  new.resolved_by := app_uid();
  new.resolved_at := now();
  return new;
end $$;
create trigger resolution_guard before insert or update on resolutions
  for each row execute function trg_resolution_guard();

-- Club-side state machine on items.
-- Invoker rights on purpose: current_user must be the caller's role, not the owner.
create function trg_item_guard() returns trigger language plpgsql as $$
declare v_pool char(1); v_count int;
begin
  if current_user = 'app_club' then
    if new.status is distinct from old.status then
      if not ((old.status in ('not_started','returned','submitted') and new.status = 'submitted')
              or (old.status = 'submitted' and new.status = 'not_started')) then
        raise exception 'Clubs can only submit items that are not locked';
      end if;
      if (select kind from requirements where id = new.req_id) <> 'document' then
        raise exception 'This item is assessed by FQ';
      end if;
    end if;
    if new.selected is distinct from old.selected then
      select pool into v_pool from clubs where id = new.club_id;
      if v_pool not in ('A','C') or new.req_id not like 'P%' then
        raise exception 'Planning selection only applies to Pool A and C clubs';
      end if;
      if new.req_id in ('P2','P5') then raise exception 'P2 and P5 are mandatory'; end if;
      if old.status <> 'not_started' then raise exception 'Item already submitted'; end if;
      select count(*) into v_count from club_items
        where club_id = new.club_id and req_id like 'P%' and selected and req_id not in ('P2','P5') and id <> new.id;
      if new.selected and v_count >= 3 then raise exception 'Choose at most three optional planning items'; end if;
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger item_guard before update on club_items
  for each row execute function trg_item_guard();

-- Invoker rights on purpose: current_user must be the caller's role, not the owner.
create function trg_file_guard() returns trigger language plpgsql as $$
declare v_status text;
begin
  if current_user <> 'app_club' then return coalesce(new, old); end if;
  if tg_op = 'DELETE' then
    if old.req_id is not null then
      select status into v_status from club_items where club_id = old.club_id and req_id = old.req_id;
    else
      select status into v_status from staff_rows where id = old.staff_row_id;
    end if;
  else
    if new.req_id is not null then
      select status into v_status from club_items where club_id = new.club_id and req_id = new.req_id;
      if (select kind from requirements where id = new.req_id) <> 'document' then
        raise exception 'This item does not take uploads';
      end if;
    else
      select status into v_status from staff_rows where id = new.staff_row_id and club_id = new.club_id;
      if v_status is null then raise exception 'Unknown staff row'; end if;
    end if;
  end if;
  if v_status in ('approved','closed') then
    raise exception 'Evidence is locked. Ask FQ to reopen the item.';
  end if;
  return coalesce(new, old);
end $$;
create trigger file_guard before insert or delete on files
  for each row execute function trg_file_guard();

-- Invoker rights on purpose: current_user must be the caller's role, not the owner.
create function trg_staff_guard() returns trigger language plpgsql as $$
begin
  if current_user = 'app_club' then
    if tg_op in ('UPDATE','DELETE') and old.status in ('approved','closed') then
      raise exception 'This row is locked. Ask FQ to reopen it.';
    end if;
    if tg_op = 'DELETE' then return old; end if;
    new.status := 'submitted';
    new.club_id := app_club();
  end if;
  if tg_op = 'DELETE' then return old; end if;
  new.updated_at := now();
  return new;
end $$;
create trigger staff_guard before insert or update or delete on staff_rows
  for each row execute function trg_staff_guard();

-- Invoker rights on purpose: current_user must be the caller's role, not the owner.
create function trg_user_guard() returns trigger language plpgsql as $$
begin
  if current_user = 'app_club' then
    if new.role <> 'club' or new.club_id <> app_club() or new.is_primary then
      raise exception 'Invalid invite';
    end if;
    if (select count(*) from users where club_id = new.club_id and active) >= 2 then
      raise exception 'Clubs may have at most two contacts';
    end if;
  end if;
  return new;
end $$;
create trigger user_guard before insert on users
  for each row execute function trg_user_guard();

-- ---------------------------------------------------------------- audit (cannot be bypassed by the app roles)
create function trg_audit() returns trigger language plpgsql security definer as $$
declare d jsonb;
begin
  d := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  d := d - 'data';
  insert into audit_log(actor_id, action, table_name, club_id, req_id, detail, reason)
  values (app_uid(), lower(tg_op), tg_table_name,
          (d->>'club_id')::int, d->>'req_id', d,
          nullif(current_setting('app.reason', true), ''));
  return coalesce(new, old);
end $$;
create trigger audit_items after update on club_items for each row
  when (old.status is distinct from new.status or old.verification is distinct from new.verification
        or old.flagged_at is distinct from new.flagged_at or old.selected is distinct from new.selected)
  execute function trg_audit();
create trigger audit_staff after insert or update or delete on staff_rows for each row execute function trg_audit();
create trigger audit_files after insert or delete on files for each row execute function trg_audit();
create trigger audit_scores after insert or update on scores for each row execute function trg_audit();
create trigger audit_locks after insert on score_locks for each row execute function trg_audit();
create trigger audit_assign after insert or update on assignments for each row execute function trg_audit();
create trigger audit_mod after insert or update or delete on moderations for each row execute function trg_audit();
create trigger audit_res after insert or update on resolutions for each row execute function trg_audit();
create trigger audit_results after insert or update on results for each row execute function trg_audit();
create trigger audit_settings after insert or update on settings for each row execute function trg_audit();
create trigger audit_users after insert or update on users for each row execute function trg_audit();

-- ---------------------------------------------------------------- grants
grant usage on all sequences in schema public to app_club, app_assessor, app_admin;
revoke all on magic_links, login_codes, sessions, emails from public;

-- Everyone may read the club-facing requirement catalogue.
grant select on requirements to app_club, app_assessor, app_admin;

-- Club role: own data only, and only the columns it needs.
grant select on clubs to app_club;
grant select (id, email, name, role, club_id, is_primary, active) on users to app_club;
grant insert (email, name, role, club_id) on users to app_club;
grant select (id, club_id, req_id, status, return_comment, selected, flagged_at, updated_at) on club_items to app_club;
grant update (status, selected) on club_items to app_club;
grant select (id, club_id, position, person, gender, team, qualification, qual_expiry, fa_number, blue_card,
              blue_card_expiry, years_at_club, employment_type, status, return_comment, updated_at) on staff_rows to app_club;
grant insert (club_id, position, person, gender, team, qualification, qual_expiry, fa_number, blue_card,
              blue_card_expiry, years_at_club, employment_type) on staff_rows to app_club;
grant update (position, person, gender, team, qualification, qual_expiry, fa_number, blue_card,
              blue_card_expiry, years_at_club, employment_type, status) on staff_rows to app_club;
grant delete on staff_rows to app_club;
grant select, insert, delete on files to app_club;
grant select on results to app_club;
-- deliberately NO grant on: requirement_criteria, scores, score_locks, assignments,
-- moderations, resolutions, prior_scores, settings, audit_log.

-- Assessor role.
grant select on clubs, club_items, staff_rows, files, requirement_criteria, prior_scores, settings to app_assessor;
grant select (id, email, name, role, club_id, is_primary, active) on users to app_assessor;
grant update (status, return_comment, verification, verified_by, verified_at, flagged_at) on club_items to app_assessor;
grant update (status, return_comment, verification, verified_by) on staff_rows to app_assessor;
grant select, insert, update, delete on scores to app_assessor;
grant select, insert on score_locks to app_assessor;
grant select on assignments, moderations to app_assessor;
grant select, insert, update on resolutions to app_assessor;

-- Admin role: oversight. No write access to scores (admin never scores).
grant select on clubs, club_items, staff_rows, files, requirement_criteria, prior_scores, assignments,
                score_locks, moderations, audit_log to app_admin;
grant select (id, email, name, role, club_id, is_primary, active, created_at) on users to app_admin;
grant insert (email, name, role, club_id, is_primary) on users to app_admin;
grant update (name, active) on users to app_admin;
grant insert, update on clubs to app_admin;
grant insert on club_items to app_admin;
grant update (status, return_comment, verification, verified_by, verified_at, flagged_at) on club_items to app_admin;
grant update (status, return_comment, verification, verified_by) on staff_rows to app_admin;
grant insert, update on assignments to app_admin;
grant select, insert, update, delete on moderations to app_admin;
grant select, insert, update, delete on resolutions to app_admin;
grant select on scores to app_admin;
grant select, insert, update on settings to app_admin;
grant select, insert, update on results to app_admin;

-- ---------------------------------------------------------------- row level security
alter table clubs enable row level security;
alter table users enable row level security;
alter table club_items enable row level security;
alter table staff_rows enable row level security;
alter table files enable row level security;
alter table assignments enable row level security;
alter table scores enable row level security;
alter table score_locks enable row level security;
alter table moderations enable row level security;
alter table resolutions enable row level security;
alter table prior_scores enable row level security;
alter table results enable row level security;
alter table audit_log enable row level security;
alter table requirements enable row level security;
alter table requirement_criteria enable row level security;
alter table settings enable row level security;

create policy req_all on requirements for select using (true);
create policy crit_staff on requirement_criteria for select to app_assessor, app_admin using (true);
create policy settings_read on settings for select to app_assessor, app_admin using (true);
create policy settings_admin on settings for all to app_admin using (true) with check (true);

-- clubs
create policy clubs_club on clubs for select to app_club using (id = app_club());
create policy clubs_assessor on clubs for select to app_assessor using (assessor_sees_club(id));
create policy clubs_admin on clubs for all to app_admin using (true) with check (true);

-- users
create policy users_self on users for select using (id = app_uid());
create policy users_club on users for select to app_club using (club_id = app_club());
create policy users_club_invite on users for insert to app_club
  with check (app_is_primary() and role = 'club' and club_id = app_club());
create policy users_staff on users for select to app_assessor using (role in ('assessor','admin'));
create policy users_admin on users for all to app_admin using (true) with check (true);

-- club_items
create policy items_club on club_items for select to app_club using (club_id = app_club());
create policy items_club_upd on club_items for update to app_club
  using (club_id = app_club()) with check (club_id = app_club());
-- Moderators see only the items they were asked to moderate, not the whole club.
create policy items_assessor on club_items for select to app_assessor
  using (assessor_slot(club_id) is not null or is_moderator_for(club_id, req_id));
create policy items_assessor_upd on club_items for update to app_assessor
  using (assessor_slot(club_id) is not null) with check (assessor_slot(club_id) is not null);
create policy items_admin on club_items for all to app_admin using (true) with check (true);

-- staff_rows
create policy staff_club on staff_rows for all to app_club
  using (club_id = app_club()) with check (club_id = app_club());
create policy staff_assessor on staff_rows for select to app_assessor
  using (assessor_slot(club_id) is not null or is_moderator_on_staff(club_id));
create policy staff_assessor_upd on staff_rows for update to app_assessor
  using (assessor_slot(club_id) is not null) with check (assessor_slot(club_id) is not null);
create policy staff_admin on staff_rows for all to app_admin using (true) with check (true);

-- files
create policy files_club on files for all to app_club
  using (club_id = app_club()) with check (club_id = app_club() and uploaded_by = app_uid());
create policy files_assessor on files for select to app_assessor
  using (assessor_slot(club_id) is not null or is_moderator_for(club_id, req_id)
         or (staff_row_id is not null and is_moderator_on_staff(club_id)));
create policy files_admin on files for select to app_admin using (true);

-- assignments: assessors see only their own assignment rows; clubs have no grant
create policy assign_assessor on assignments for select to app_assessor
  using (first_id = app_uid() or second_id = app_uid());
create policy assign_admin on assignments for all to app_admin using (true) with check (true);

-- scores: BLIND. An assessor sees only their own rows. Moderators of an item and
-- admins see both scores only once both assessors have locked in.
create policy scores_own on scores for select to app_assessor using (assessor_id = app_uid());
create policy scores_moderator on scores for select to app_assessor
  using (is_moderator_for(club_id, req_id) and both_locked(club_id));
create policy scores_ins on scores for insert to app_assessor
  with check (assessor_id = app_uid() and assessor_slot(club_id) is not null);
create policy scores_upd on scores for update to app_assessor
  using (assessor_id = app_uid()) with check (assessor_id = app_uid());
create policy scores_del on scores for delete to app_assessor using (assessor_id = app_uid());
create policy scores_admin on scores for select to app_admin using (both_locked(club_id));

-- locks: an assessor cannot see whether the other assessor has locked (or started)
create policy locks_own on score_locks for select to app_assessor using (assessor_id = app_uid());
create policy locks_ins on score_locks for insert to app_assessor
  with check (assessor_id = app_uid() and assessor_slot(club_id) is not null);
create policy locks_admin on score_locks for select to app_admin using (true);

-- moderation
create policy mod_assessor on moderations for select to app_assessor using (moderator_id = app_uid());
create policy mod_admin on moderations for all to app_admin using (true) with check (true);

-- resolutions
create policy res_moderator on resolutions for select to app_assessor using (is_moderator_for(club_id, req_id));
create policy res_moderator_ins on resolutions for insert to app_assessor
  with check (is_moderator_for(club_id, req_id));
create policy res_moderator_upd on resolutions for update to app_assessor
  using (is_moderator_for(club_id, req_id)) with check (is_moderator_for(club_id, req_id));
create policy res_admin on resolutions for all to app_admin using (true) with check (true);

create policy prior_assessor on prior_scores for select to app_assessor
  using (assessor_slot(club_id) is not null or is_moderator_for(club_id, req_id));
create policy prior_admin on prior_scores for select to app_admin using (true);

-- results: hidden from clubs until released
create policy results_club on results for select to app_club
  using (club_id = app_club() and released_at is not null);
create policy results_admin on results for all to app_admin using (true) with check (true);

-- audit: admin only, and score values stay sealed until both assessors lock
create policy audit_admin on audit_log for select to app_admin
  using (table_name <> 'scores' or both_locked(club_id));
