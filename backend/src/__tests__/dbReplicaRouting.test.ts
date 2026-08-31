import {
  buildDatabaseUrl,
  resolveReadReplicaSettings,
  resolvePoolSettings,
} from "../services/dbPoolConfig.js";

describe("read replica routing", () => {
  it("builds a replica URL with the same pool settings as the primary", () => {
    const url = buildDatabaseUrl(
      {
        DATABASE_REPLICA_URL: "postgres://replica:pw@replica:5432/remitmortgage",
        DB_CONNECTION_LIMIT: "25",
        DB_POOL_TIMEOUT: "12",
        DB_CONNECT_TIMEOUT: "20",
      } as NodeJS.ProcessEnv,
      "DATABASE_REPLICA_URL"
    );

    expect(url).toContain("postgres://replica:pw@replica:5432/remitmortgage?");
    expect(url).toContain("connection_limit=25");
    expect(url).toContain("pool_timeout=12");
    expect(url).toContain("connect_timeout=20");
  });

  it("resolves replica lag threshold and url defaults safely", () => {
    expect(resolveReadReplicaSettings({} as NodeJS.ProcessEnv)).toEqual({
      url: undefined,
      lagThresholdSeconds: 30,
    });

    expect(
      resolveReadReplicaSettings({
        DATABASE_REPLICA_URL: "postgres://replica:pw@replica:5432/remitmortgage",
        DB_REPLICA_LAG_THRESHOLD_SECONDS: "9",
      } as NodeJS.ProcessEnv)
    ).toEqual({
      url: "postgres://replica:pw@replica:5432/remitmortgage",
      lagThresholdSeconds: 9,
    });
  });

  it("keeps the base pool settings independent of the replica config", () => {
    expect(
      resolvePoolSettings({
        DB_CONNECTION_LIMIT: "8",
      } as NodeJS.ProcessEnv)
    ).toEqual({ connectionLimit: 8, poolTimeout: 15, connectTimeout: 30 });
  });
});
