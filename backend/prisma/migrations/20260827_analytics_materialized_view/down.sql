-- Rollback for 20260827_analytics_materialized_view.
-- The supporting unique indexes are dropped with their materialized views.
DROP MATERIALIZED VIEW IF EXISTS "monthly_volume_series";
DROP MATERIALIZED VIEW IF EXISTS "protocol_analytics";
