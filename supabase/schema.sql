-- ITeen Academy typing trainer: Supabase schema + tenant isolation
-- Run the whole file in Supabase Dashboard -> SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.teacher_groups (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null unique references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 2 and 100),
  created_at timestamptz not null default now()
);

create table if not exists public.students (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.teacher_groups(id) on delete cascade,
  display_name text not null check (char_length(trim(display_name)) between 1 and 100),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.lessons (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.teacher_groups(id) on delete cascade,
  title text not null check (char_length(trim(title)) between 1 and 150),
  content text not null check (char_length(trim(content)) between 1 and 30000),
  is_active boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists lessons_one_active_per_group
  on public.lessons(group_id) where is_active = true;

create table if not exists public.typing_results (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.teacher_groups(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  lesson_id uuid not null references public.lessons(id) on delete cascade,
  duration_seconds integer not null check (duration_seconds between 1 and 600),
  typed_chars integer not null check (typed_chars between 0 and 100000),
  correct_chars integer not null check (correct_chars between 0 and 100000),
  errors integer not null check (errors between 0 and 100000),
  wpm numeric(8,2) not null check (wpm between 0 and 10000),
  accuracy numeric(5,2) not null check (accuracy between 0 and 100),
  created_at timestamptz not null default now()
);
create index if not exists typing_results_group_created on public.typing_results(group_id, created_at desc);
create index if not exists typing_results_student_created on public.typing_results(student_id, created_at desc);

create or replace function public.owns_group(p_group_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$ select exists(select 1 from public.teacher_groups g where g.id=p_group_id and g.teacher_id=auth.uid()); $$;

alter table public.teacher_groups enable row level security;
alter table public.students enable row level security;
alter table public.lessons enable row level security;
alter table public.typing_results enable row level security;

-- A teacher can only see/change their own single group.
drop policy if exists teacher_owns_group on public.teacher_groups;
create policy teacher_owns_group on public.teacher_groups for all to authenticated
  using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());

drop policy if exists teacher_manage_students on public.students;
create policy teacher_manage_students on public.students for all to authenticated
  using (public.owns_group(group_id)) with check (public.owns_group(group_id));

drop policy if exists teacher_manage_lessons on public.lessons;
create policy teacher_manage_lessons on public.lessons for all to authenticated
  using (public.owns_group(group_id)) with check (public.owns_group(group_id));

drop policy if exists teacher_read_results on public.typing_results;
create policy teacher_read_results on public.typing_results for select to authenticated
  using (public.owns_group(group_id));

-- Public student view: only group labels are exposed, not teacher account details.
create or replace function public.student_portal_groups()
returns table(id uuid, name text)
language sql stable security definer set search_path = public, pg_temp
as $$ select g.id, g.name from public.teacher_groups g order by g.created_at, g.name; $$;

-- Public student view: only active student display names and current published text are returned.
create or replace function public.student_portal_data(p_group_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare result jsonb;
begin
  if not exists(select 1 from public.teacher_groups where id=p_group_id) then
    raise exception 'Группа не найдена';
  end if;
  select jsonb_build_object(
    'group', (select jsonb_build_object('id',g.id,'name',g.name) from public.teacher_groups g where g.id=p_group_id),
    'students', coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'display_name',s.display_name) order by s.display_name)
                          from public.students s where s.group_id=p_group_id and s.active=true),'[]'::jsonb),
    'lesson', (select jsonb_build_object('id',l.id,'title',l.title,'content',l.content)
               from public.lessons l where l.group_id=p_group_id and l.is_active=true limit 1)
  ) into result;
  return result;
end; $$;

-- The client can submit a result only for an existing active student and a lesson belonging to that group.
create or replace function public.submit_typing_result(
  p_group_id uuid, p_student_id uuid, p_lesson_id uuid,
  p_duration_seconds integer, p_typed_chars integer, p_correct_chars integer,
  p_errors integer, p_wpm numeric, p_accuracy numeric
) returns uuid language plpgsql security definer set search_path = public, pg_temp
as $$
declare new_id uuid;
begin
  if not exists(select 1 from public.students where id=p_student_id and group_id=p_group_id and active=true) then
    raise exception 'Ученик не найден в этой группе';
  end if;
  if not exists(select 1 from public.lessons where id=p_lesson_id and group_id=p_group_id) then
    raise exception 'Занятие не найдено';
  end if;
  if p_duration_seconds < 1 or p_duration_seconds > 600 then raise exception 'Некорректная длительность'; end if;
  if p_typed_chars < 0 or p_correct_chars < 0 or p_errors < 0 or p_correct_chars > p_typed_chars then
    raise exception 'Некорректные показатели';
  end if;
  insert into public.typing_results(group_id,student_id,lesson_id,duration_seconds,typed_chars,correct_chars,errors,wpm,accuracy)
  values(p_group_id,p_student_id,p_lesson_id,p_duration_seconds,p_typed_chars,p_correct_chars,p_errors,p_wpm,p_accuracy)
  returning id into new_id;
  return new_id;
end; $$;

-- Atomic publish: previous text is archived and the new one becomes active.
create or replace function public.teacher_publish_lesson(p_group_id uuid,p_title text,p_content text)
returns uuid language plpgsql security definer set search_path = public, pg_temp
as $$
declare new_id uuid;
begin
  if not public.owns_group(p_group_id) then raise exception 'Нет доступа к этой группе'; end if;
  if char_length(trim(p_title)) not between 1 and 150 then raise exception 'Название должно содержать от 1 до 150 символов'; end if;
  if char_length(trim(p_content)) not between 1 and 30000 then raise exception 'Текст должен содержать от 1 до 30000 символов'; end if;
  update public.lessons set is_active=false where group_id=p_group_id and is_active=true;
  insert into public.lessons(group_id,title,content,is_active) values(p_group_id,trim(p_title),trim(p_content),true) returning id into new_id;
  return new_id;
end; $$;

revoke all on function public.owns_group(uuid) from public, anon;
grant execute on function public.owns_group(uuid) to authenticated;
revoke all on function public.student_portal_groups() from public;
grant execute on function public.student_portal_groups() to anon, authenticated;
revoke all on function public.student_portal_data(uuid) from public;
grant execute on function public.student_portal_data(uuid) to anon, authenticated;
revoke all on function public.submit_typing_result(uuid,uuid,uuid,integer,integer,integer,integer,numeric,numeric) from public;
grant execute on function public.submit_typing_result(uuid,uuid,uuid,integer,integer,integer,integer,numeric,numeric) to anon, authenticated;
revoke all on function public.teacher_publish_lesson(uuid,text,text) from public, anon;
grant execute on function public.teacher_publish_lesson(uuid,text,text) to authenticated;

grant select, insert, update, delete on public.teacher_groups to authenticated;
grant select, insert, update, delete on public.students to authenticated;
grant select, insert, update, delete on public.lessons to authenticated;
grant select on public.typing_results to authenticated;
