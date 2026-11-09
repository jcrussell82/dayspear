-- Owner-facing: remember when a cancelled subscription ends, so the Plan page can say so.
alter table public.businesses add column if not exists cancel_at timestamptz;

-- Operator dashboard (#admin): counts and a business list, computed inside the database so
-- the server never has to load every team's full data. Only the `api` function (service role)
-- can call it, and it only does so for the addresses in the ADMIN_EMAILS function secret.
-- It returns business-level facts and counts only: no employee names, contacts or messages.
create or replace function public.admin_stats() returns jsonb
language sql stable security definer set search_path = public as $$
  with ppl as (
    select w.business_id, p->>'status' as status, p->>'access' as access, p->>'email' as email
    from public.workspaces w, jsonb_each(coalesce(w.doc->'people', '{}'::jsonb)) as e(k, p)
  ),
  per_biz as (
    select b.id, b.name, b.created_at, b.plan_id, b.subscription_status, b.current_period_end, b.cancel_at,
           w.updated_at as last_change,
           (select count(*) from ppl where ppl.business_id = b.id and ppl.status = 'active')  as active_people,
           (select count(*) from ppl where ppl.business_id = b.id and ppl.status = 'invited') as invited_people,
           (select count(*) from public.memberships m where m.business_id = b.id)             as sign_ins,
           (select ppl.email from ppl where ppl.business_id = b.id and ppl.access = 'owner' limit 1) as owner_email,
           coalesce(jsonb_array_length(w.doc->'shifts'), 0)      as shifts,
           (select count(*) from jsonb_object_keys(coalesce(w.doc->'locs', '{}'::jsonb))) as locations
    from public.businesses b left join public.workspaces w on w.business_id = b.id
  )
  select jsonb_build_object(
    'generated_at', now(),
    'businesses',   (select count(*) from public.businesses),
    'new_7d',       (select count(*) from public.businesses where created_at > now() - interval '7 days'),
    'new_30d',      (select count(*) from public.businesses where created_at > now() - interval '30 days'),
    'active_7d',    (select count(*) from public.workspaces where updated_at > now() - interval '7 days'),
    'active_30d',   (select count(*) from public.workspaces where updated_at > now() - interval '30 days'),
    'sign_ins',     (select count(distinct user_id) from public.memberships),
    'people',       (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) n from ppl group by status) t),
    'plans',        (select coalesce(jsonb_object_agg(plan_id, n), '{}'::jsonb) from (select plan_id, count(*) n from public.businesses group by plan_id) t),
    'statuses',     (select coalesce(jsonb_object_agg(coalesce(subscription_status, 'none'), n), '{}'::jsonb)
                     from (select subscription_status, count(*) n from public.businesses group by subscription_status) t),
    'paying',       (select coalesce(jsonb_object_agg(plan_id, n), '{}'::jsonb) from (select plan_id, count(*) n from public.businesses
                     where plan_id <> 'free' and subscription_status in ('active', 'trialing', 'past_due') group by plan_id) t),
    'cancelling',   (select count(*) from public.businesses where cancel_at is not null and cancel_at > now()),
    'weekly_signups', (select coalesce(jsonb_agg(jsonb_build_object('week', wk, 'n', n) order by wk), '[]'::jsonb) from (
                        select g::date as wk, (select count(*) from public.businesses b where b.created_at >= g and b.created_at < g + interval '7 days') as n
                        from generate_series(date_trunc('week', now()) - interval '11 weeks', date_trunc('week', now()), interval '7 days') g) t),
    'list',         (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb) from (select * from per_biz order by created_at desc limit 500) x)
  );
$$;
revoke all on function public.admin_stats() from public, anon, authenticated;
grant execute on function public.admin_stats() to service_role;
