-- Conflict-safe save of a new file version. SECURITY INVOKER: runs with the caller's own RLS
-- (firm-shared policies on files/file_versions/storage.objects); no privilege escalation.
create or replace function public.save_file_version(
  p_file_id uuid,
  p_expected_path text,
  p_new_path text,
  p_size bigint,
  p_extracted_text text default null,
  p_update_text boolean default false,
  p_note text default null
)
returns table (path text, version_id uuid)
language plpgsql
security invoker
set search_path = public
as $$
declare
  f public.files%rowtype;
  v_id uuid;
  v_actor text := auth.uid()::text;
  v_prefix text;
begin
  if v_actor is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_new_path is null or p_new_path = '' or p_new_path = p_expected_path then
    raise exception 'invalid new path' using errcode = '22023';
  end if;
  if p_size is null or p_size <= 0 then
    raise exception 'empty file' using errcode = '22023';
  end if;

  -- Lock the row so concurrent saves serialise; compare against the path the editing session loaded.
  select * into f from public.files where id = p_file_id for update;
  if not found then
    raise exception 'file not found' using errcode = 'P0002';
  end if;
  if f.path is distinct from p_expected_path then
    raise exception 'conflict: file changed since it was opened' using errcode = '40001';
  end if;

  -- The new object must live under this file's matter folder and already be uploaded.
  v_prefix := coalesce(f.matter_id::text, 'firm') || '/';
  if left(p_new_path, length(v_prefix)) <> v_prefix or position('..' in p_new_path) > 0 then
    raise exception 'new path outside the file''s folder' using errcode = '22023';
  end if;
  if not exists (
    select 1 from storage.objects o where o.bucket_id = 'matter-files' and o.name = p_new_path
  ) then
    raise exception 'new object not uploaded' using errcode = '22023';
  end if;

  insert into public.file_versions (file_id, path, size, note, created_by)
  values (f.id, f.path, f.size, p_note, v_actor)
  returning id into v_id;

  update public.files
     set path = p_new_path,
         size = p_size,
         updated_at = now(),
         edited_by = v_actor,
         extracted_text = case when p_update_text then p_extracted_text else extracted_text end
   where id = f.id;

  return query select p_new_path, v_id;
end
$$;

revoke all on function public.save_file_version(uuid, text, text, bigint, text, boolean, text) from public, anon;
grant execute on function public.save_file_version(uuid, text, text, bigint, text, boolean, text) to authenticated;