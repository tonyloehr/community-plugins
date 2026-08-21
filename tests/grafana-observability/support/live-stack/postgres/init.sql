REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE ROLE grafana_live_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
CREATE TABLE public.observability_kpis (
  environment text NOT NULL,
  business_scope text NOT NULL,
  revenue double precision NOT NULL,
  conversion double precision NOT NULL,
  operational_kpi double precision NOT NULL,
  origin text NOT NULL CHECK (origin = 'SIMULATED'),
  PRIMARY KEY (environment, business_scope)
);

INSERT INTO public.observability_kpis (
  environment,
  business_scope,
  revenue,
  conversion,
  operational_kpi,
  origin
) VALUES
  ('simulation', 'checkout-unit', 95000, 3.2, 88, 'SIMULATED');

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE observability TO grafana_live_reader;
GRANT USAGE ON SCHEMA public TO grafana_live_reader;
GRANT SELECT ON public.observability_kpis TO grafana_live_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
