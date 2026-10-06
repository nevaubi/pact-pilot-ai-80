-- Office editors: keep prior versions of edited documents and track edits on files.
ALTER TABLE public.files ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.files ADD COLUMN IF NOT EXISTS edited_by text;

CREATE TABLE IF NOT EXISTS public.file_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id uuid NOT NULL REFERENCES public.files(id) ON DELETE CASCADE,
  path text NOT NULL,
  size bigint,
  note text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS file_versions_file_id_idx ON public.file_versions(file_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.file_versions TO authenticated;
GRANT ALL ON public.file_versions TO service_role;

ALTER TABLE public.file_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "firm members read versions" ON public.file_versions FOR SELECT TO authenticated USING (true);
CREATE POLICY "firm members add versions" ON public.file_versions FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "firm members delete versions" ON public.file_versions FOR DELETE TO authenticated USING (true);