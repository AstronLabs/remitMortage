/**
 * Connection pool settings, resolved from the environment in one place.
 *
 * Both the Prisma client (`services/db.ts`) and the pool metrics
 * (`services/dbPoolMetrics.ts`) need to agree on the configured connection
 * limit — a utilization gauge computed against a different number than the one
 * the pool actually enforces would be worse than no gauge at all. So the
 * resolution lives here and both import it.
 */

/** Defaults applied when the corresponding env var is unset or unparseable. */
export const DB_POOL_DEFAULTS = {
  /** Maximum open connections to PostgreSQL for this process. */
  connectionLimit: 20,
  /** Seconds to wait for a free connection before Prisma throws P2024. */
  poolTimeout: 15,
  /** Seconds allowed for the initial TCP handshake to PostgreSQL. */
  connectTimeout: 30,
} as const;

export interface DbPoolSettings {
  connectionLimit: number;
  poolTimeout: number;
  connectTimeout: number;
}

/**
 * Parse a positive integer from an env var, falling back to `fallback` when the
 * value is missing, non-numeric, or not positive. A pool limit of 0 or a
 * negative number is always a configuration mistake, and silently honouring it
 * would wedge the service.
 */
function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Resolve the pool settings from an environment map (defaults to `process.env`). */
export function resolvePoolSettings(
  env: NodeJS.ProcessEnv = process.env
): DbPoolSettings {
  return {
    connectionLimit: positiveInt(
      env.DB_CONNECTION_LIMIT,
      DB_POOL_DEFAULTS.connectionLimit
    ),
    poolTimeout: positiveInt(env.DB_POOL_TIMEOUT, DB_POOL_DEFAULTS.poolTimeout),
    connectTimeout: positiveInt(
      env.DB_CONNECT_TIMEOUT,
      DB_POOL_DEFAULTS.connectTimeout
    ),
  };
}

/**
 * Read replica settings that may be used for analytics/reporting queries.
 * The replica is optional: if unset, the primary database remains the only
 * source of truth and all operations continue unchanged.
 */
export interface ReadReplicaSettings {
  url?: string;
  lagThresholdSeconds: number;
}

export function resolveReadReplicaSettings(
  env: NodeJS.ProcessEnv = process.env
): ReadReplicaSettings {
  const url = env.DATABASE_REPLICA_URL || env.READ_REPLICA_URL || undefined;
  return {
    url,
    lagThresholdSeconds: positiveInt(
      env.DB_REPLICA_LAG_THRESHOLD_SECONDS,
      30
    ),
  };
}

/**
 * Append the pool settings to a database URL as query-string parameters, which
 * is how Prisma accepts them. Returns undefined when no base URL is set.
 */
export function buildDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
  databaseUrlKey: keyof NodeJS.ProcessEnv = "DATABASE_URL"
): string | undefined {
  const base = env[databaseUrlKey];
  if (!base) return undefined;

  const { connectionLimit, poolTimeout, connectTimeout } = resolvePoolSettings(env);
  const separator = base.includes("?") ? "&" : "?";

  return (
    `${base}${separator}` +
    `connection_limit=${connectionLimit}` +
    `&pool_timeout=${poolTimeout}` +
    `&connect_timeout=${connectTimeout}`
  );
}
