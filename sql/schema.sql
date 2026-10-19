-- =========================================================
-- TeamFlow · 团队协作任务板
-- 数据库结构与行级安全策略（Supabase / PostgreSQL）
-- ---------------------------------------------------------
-- 在 Supabase 控制台 → SQL Editor 里整段执行即可。
-- 设计要点：
--   · 所有表都开 RLS，默认拒绝，按"项目成员"授权
--   · 任务用 (status, position) 双字段排序，支持看板拖拽
--   · 统计用视图 project_stats 计算，避免前端重复算
-- =========================================================

-- ---------- 扩展 ----------
-- PostgreSQL 13+ 已内置 gen_random_uuid()，这里加 IF NOT EXISTS 只是兜底；
-- 如果当前账号没有建扩展权限，失败也不影响后续（用 DO 块吞掉异常）。
do $$
begin
  create extension if not exists "pgcrypto";
exception when others then
  raise notice '跳过 pgcrypto 扩展：%', sqlerrm;
end $$;

-- =========================================================
-- 一、用户资料
-- =========================================================
-- 认证交给 Supabase Auth（auth.users），这里只存业务资料。
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text not null,
  avatar_color  text not null default '#3B6FF5',
  created_at    timestamptz not null default now()
);

-- 新用户注册时自动建资料
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =========================================================
-- 二、项目（看板）
-- =========================================================
create table if not exists public.projects (
  id          uuid primary key default gen_random_uuid(),
  key         text not null,                       -- 短标识，如 TF
  name        text not null,
  description text not null default '',
  owner_id    uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);

-- =========================================================
-- 三、项目成员
-- =========================================================
create table if not exists public.project_members (
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'member' check (role in ('owner', 'admin', 'member')),
  joined_at  timestamptz not null default now(),
  primary key (project_id, user_id)
);

-- =========================================================
-- 四、任务
-- =========================================================
create table if not exists public.tasks (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  title       text not null,
  description text not null default '',
  status      text not null default 'todo'
              check (status in ('todo', 'doing', 'review', 'done')),
  priority    text not null default 'medium'
              check (priority in ('low', 'medium', 'high', 'urgent')),
  position    integer not null default 0,          -- 同列内排序
  assignee_id uuid references auth.users(id) on delete set null,
  due_date    date,
  created_by  uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_tasks_project on public.tasks(project_id);
create index if not exists idx_tasks_status  on public.tasks(project_id, status, position);

-- 更新时间戳
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_tasks_updated on public.tasks;
create trigger trg_tasks_updated
  before update on public.tasks
  for each row execute function public.touch_updated_at();

-- =========================================================
-- 五、标签
-- =========================================================
create table if not exists public.tags (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name       text not null,
  color      text not null default '#5B8CFF',
  unique (project_id, name)
);

create table if not exists public.task_tags (
  task_id uuid not null references public.tasks(id) on delete cascade,
  tag_id  uuid not null references public.tags(id) on delete cascade,
  primary key (task_id, tag_id)
);

-- =========================================================
-- 六、评论
-- =========================================================
create table if not exists public.comments (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references public.tasks(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  body       text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_comments_task on public.comments(task_id, created_at);

-- =========================================================
-- 七、活动日志
-- =========================================================
create table if not exists public.activity (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  task_id    uuid references public.tasks(id) on delete set null,
  user_id    uuid not null references auth.users(id) on delete cascade,
  action     text not null,
  detail     text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists idx_activity_project on public.activity(project_id, created_at desc);

-- =========================================================
-- 八、辅助函数
-- =========================================================

-- 当前用户是否是某项目成员（RLS 策略里反复用到，抽出来避免策略复杂化）
create or replace function public.is_member(p_project uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.project_members m
    where m.project_id = p_project and m.user_id = auth.uid()
  );
$$;

-- 新建项目时自动把创建者加为 owner
create or replace function public.add_owner_as_member()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.project_members (project_id, user_id, role)
  values (new.id, new.owner_id, 'owner')
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists trg_project_owner on public.projects;
create trigger trg_project_owner
  after insert on public.projects
  for each row execute function public.add_owner_as_member();

-- =========================================================
-- 九、统计视图
-- =========================================================
create or replace view public.project_stats as
select
  p.id                                                        as project_id,
  count(t.id)                                                 as total_tasks,
  count(t.id) filter (where t.status = 'todo')                as todo,
  count(t.id) filter (where t.status = 'doing')               as doing,
  count(t.id) filter (where t.status = 'review')              as review,
  count(t.id) filter (where t.status = 'done')                as done,
  count(t.id) filter (where t.priority in ('high','urgent'))  as urgent_tasks,
  count(t.id) filter (where t.due_date < current_date
                        and t.status <> 'done')               as overdue
from public.projects p
left join public.tasks t on t.project_id = p.id
group by p.id;

-- =========================================================
-- 十、行级安全策略（RLS）
-- =========================================================
alter table public.profiles        enable row level security;
alter table public.projects        enable row level security;
alter table public.project_members enable row level security;
alter table public.tasks           enable row level security;
alter table public.tags            enable row level security;
alter table public.task_tags       enable row level security;
alter table public.comments        enable row level security;
alter table public.activity        enable row level security;

-- ---- profiles ----
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select using (true);                       -- 资料对全员可见（用于显示负责人）

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self on public.profiles
  for insert with check (auth.uid() = id);

-- ---- projects ----
drop policy if exists projects_select on public.projects;
create policy projects_select on public.projects
  for select using (public.is_member(id) or owner_id = auth.uid());

drop policy if exists projects_insert on public.projects;
create policy projects_insert on public.projects
  for insert with check (auth.uid() = owner_id);

drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects
  for update using (owner_id = auth.uid());

drop policy if exists projects_delete on public.projects;
create policy projects_delete on public.projects
  for delete using (owner_id = auth.uid());

-- ---- project_members ----
drop policy if exists members_select on public.project_members;
create policy members_select on public.project_members
  for select using (public.is_member(project_id));

drop policy if exists members_insert on public.project_members;
create policy members_insert on public.project_members
  for insert with check (
    exists (select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid())
  );

drop policy if exists members_delete on public.project_members;
create policy members_delete on public.project_members
  for delete using (
    exists (select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid())
  );

-- ---- tasks ----
drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks
  for select using (public.is_member(project_id));

drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks
  for insert with check (public.is_member(project_id) and auth.uid() = created_by);

drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks
  for update using (public.is_member(project_id));

drop policy if exists tasks_delete on public.tasks;
create policy tasks_delete on public.tasks
  for delete using (public.is_member(project_id));

-- ---- tags / task_tags ----
drop policy if exists tags_all on public.tags;
create policy tags_all on public.tags
  for all using (public.is_member(project_id)) with check (public.is_member(project_id));

drop policy if exists task_tags_all on public.task_tags;
create policy task_tags_all on public.task_tags
  for all using (
    exists (select 1 from public.tasks t where t.id = task_id and public.is_member(t.project_id))
  ) with check (
    exists (select 1 from public.tasks t where t.id = task_id and public.is_member(t.project_id))
  );

-- ---- comments ----
drop policy if exists comments_select on public.comments;
create policy comments_select on public.comments
  for select using (
    exists (select 1 from public.tasks t where t.id = task_id and public.is_member(t.project_id))
  );

drop policy if exists comments_insert on public.comments;
create policy comments_insert on public.comments
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from public.tasks t where t.id = task_id and public.is_member(t.project_id))
  );

drop policy if exists comments_delete on public.comments;
create policy comments_delete on public.comments
  for delete using (auth.uid() = user_id);

-- ---- activity ----
drop policy if exists activity_select on public.activity;
create policy activity_select on public.activity
  for select using (public.is_member(project_id));

drop policy if exists activity_insert on public.activity;
create policy activity_insert on public.activity
  for insert with check (auth.uid() = user_id and public.is_member(project_id));

-- =========================================================
-- 十一、实时订阅（可选）
-- =========================================================
-- 把 tasks / comments / activity 加入 Supabase 的实时发布。
-- 这一段最容易报错：表可能已在发布里（重复添加会抛错），
-- 或者当前角色没有修改发布的权限。用 DO 块逐个尝试并吞掉异常，
-- 保证整份脚本能一口气跑完，不会因为这段中断后面的验证。
do $$
declare
  t text;
begin
  foreach t in array array['tasks', 'comments', 'activity'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
      raise notice '已加入实时发布：%', t;
    exception when others then
      raise notice '跳过 % 的实时发布：%', t, sqlerrm;
    end;
  end loop;
end $$;

-- =========================================================
-- 完成
-- =========================================================
-- 验证用：执行下面这句应返回空数组（RLS 生效，匿名看不到任何项目）
-- select * from public.projects;
