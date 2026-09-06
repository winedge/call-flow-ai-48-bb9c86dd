CREATE TABLE public.app_credentials (
  key TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_by UUID
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_credentials TO authenticated;
GRANT ALL ON public.app_credentials TO service_role;

ALTER TABLE public.app_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage credentials"
ON public.app_credentials FOR ALL TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER app_credentials_updated_at
BEFORE UPDATE ON public.app_credentials
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();