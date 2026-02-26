-- Store current/last project per user so refresh restores the same workspace
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS last_project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_profiles_last_project ON public.profiles(last_project_id);

COMMENT ON COLUMN public.profiles.last_project_id IS 'Current project shown on app load; used to restore session on refresh.';
