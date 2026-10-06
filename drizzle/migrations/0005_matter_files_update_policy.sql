-- Editors overwrite a document in place after copying the prior bytes to versions/; that needs UPDATE on storage objects.
create policy "firm files update"
on storage.objects
for update
to authenticated
using (bucket_id = 'matter-files')
with check (bucket_id = 'matter-files');