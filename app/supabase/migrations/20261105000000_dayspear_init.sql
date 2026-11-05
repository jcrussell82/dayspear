-- DaySpear database.
--
-- Browsers never read or write these tables directly. Row level security is ON with
-- no policies, and the browser roles (anon, authenticated) have every privilege
-- revoked. The only way in is the `api` Edge Function, which runs with the service
-- role and checks who the person is and what their role allows before every change.
--
-- Each business's scheduling data is one JSON document in `workspaces`, always loaded
-- by business_id, so one business can never see another's.

create table public.businesses (
  id                     text primary key,
  name                   text not null,
  created_at             timestamptz not null default now(),
  plan_id                text not null default 'free',
  stripe_customer_id     text unique,
  stripe_subscription_id text unique,
  subscription_status    text,
  current_period_end     timestamptz,
  grace_until            timestamptz
);

create table public.workspaces (
  business_id text primary key references public.businesses(id) on delete cascade,
  doc         jsonb not null,
  version     integer not null default 1,
  updated_at  timestamptz not null default now()
);

-- links a Supabase Auth user to a person in a business
create table public.memberships (
  business_id text not null references public.businesses(id) on delete cascade,
  person_id   text not null,
  user_id     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (business_id, person_id)
);
create index memberships_user_idx on public.memberships(user_id);

-- invite links: only a SHA-256 hash of the token is stored
create table public.invites (
  token_hash  text primary key,
  business_id text not null references public.businesses(id) on delete cascade,
  person_id   text not null,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  revoked     boolean not null default false,
  created_at  timestamptz not null default now()
);
create index invites_person_idx on public.invites(business_id, person_id);

-- Stripe webhook events already handled (so a retried event is applied once)
create table public.stripe_events (
  id          text primary key,
  type        text,
  received_at timestamptz not null default now()
);

-- simple rate limiting for public endpoints (contact form)
create table public.rate_hits (
  key text not null,
  at  timestamptz not null default now()
);
create index rate_hits_idx on public.rate_hits(key, at);

-- lock everything
alter table public.businesses    enable row level security;
alter table public.workspaces    enable row level security;
alter table public.memberships   enable row level security;
alter table public.invites       enable row level security;
alter table public.stripe_events enable row level security;
alter table public.rate_hits     enable row level security;
revoke all on public.businesses, public.workspaces, public.memberships, public.invites, public.stripe_events, public.rate_hits from anon, authenticated;
grant all on public.businesses, public.workspaces, public.memberships, public.invites, public.stripe_events, public.rate_hits to service_role;

-- ---------------------------------------------------------------- functions (service role only)

-- create a business, its workspace and the owner's membership in one transaction
create function public.create_business(p_id text, p_name text, p_doc jsonb, p_user uuid, p_person text)
returns void language plpgsql set search_path = public as $$
begin
  insert into businesses (id, name) values (p_id, p_name);
  insert into workspaces (business_id, doc) values (p_id, p_doc);
  insert into memberships (business_id, person_id, user_id) values (p_id, p_person, p_user);
end $$;

-- accept an invite: save the updated workspace (only if nobody else changed it),
-- link the user, and use up the invite — all or nothing
create function public.accept_invite(p_token_hash text, p_user uuid, p_doc jsonb, p_version integer)
returns integer language plpgsql set search_path = public as $$
declare inv invites; n integer;
begin
  select * into inv from invites where token_hash = p_token_hash for update;
  if inv is null or inv.used_at is not null or inv.revoked or inv.expires_at < now() then
    raise exception 'invite_expired' using errcode = 'P0001';
  end if;
  update workspaces set doc = p_doc, version = version + 1, updated_at = now()
    where business_id = inv.business_id and version = p_version;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'version_conflict' using errcode = 'P0001'; end if;
  insert into memberships (business_id, person_id, user_id) values (inv.business_id, inv.person_id, p_user)
    on conflict (business_id, person_id) do update set user_id = excluded.user_id;
  update invites set used_at = now() where token_hash = p_token_hash;
  return p_version + 1;
end $$;

-- count a hit for a key; returns false when over the limit
create function public.rate_hit(p_key text, p_window_seconds integer, p_max integer)
returns boolean language plpgsql set search_path = public as $$
declare c integer;
begin
  delete from rate_hits where at < now() - interval '1 day';
  insert into rate_hits (key) values (p_key);
  select count(*) into c from rate_hits where key = p_key and at > now() - make_interval(secs => p_window_seconds);
  return c <= p_max;
end $$;

revoke all on function public.create_business(text, text, jsonb, uuid, text) from public, anon, authenticated;
revoke all on function public.accept_invite(text, uuid, jsonb, integer) from public, anon, authenticated;
revoke all on function public.rate_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.create_business(text, text, jsonb, uuid, text) to service_role;
grant execute on function public.accept_invite(text, uuid, jsonb, integer) to service_role;
grant execute on function public.rate_hit(text, integer, integer) to service_role;
