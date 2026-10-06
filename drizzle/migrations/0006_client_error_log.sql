-- Error log: runtime problems the browser hits (editor crashes, failed saves) so the firm can review them.
-- Messages and stacks only — never document text or credentials.
CREATE TABLE IF NOT EXISTS public.client_errors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  route text NOT NULL,
  source text NOT NULL,
  message text NOT NULL,
  stack text,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  user_agent text,
  CONSTRAINT client_errors_message_len CHECK (char_length(message) <= 2000),
  CONSTRAINT client_errors_stack_len CHECK (stack IS NULL OR char_length(stack) <= 8000)
);
CREATE INDEX IF NOT EXISTS client_errors_created_at_idx ON public.client_errors(created_at DESC);

GRANT SELECT, INSERT, DELETE ON public.client_errors TO authenticated;
GRANT ALL ON public.client_errors TO service_role;

ALTER TABLE public.client_errors ENABLE ROW LEVEL SECURITY;
CREATE POLICY "firm members read error log" ON public.client_errors FOR SELECT TO authenticated USING (true);
CREATE POLICY "users log their own errors" ON public.client_errors FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "firm members clear error log" ON public.client_errors FOR DELETE TO authenticated USING (true);