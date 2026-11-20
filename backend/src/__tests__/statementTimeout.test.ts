// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

jest.mock("../utils/logger.js", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  DEFAULT_LONG_RUNNING_STATEMENT_TIMEOUT_MS,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  STATEMENT_TIMEOUT_SQLSTATE,
  StatementTimeoutError,
  buildStatementTimeoutOption,
  getLongRunningStatementTimeoutMs,
  getStatementTimeoutMs,
  isStatementTimeoutError,
  runWithStatementTimeout,
  toStatementTimeoutError,
} from "../services/statementTimeout.js";
import { buildDatabaseUrl } from "../services/dbPoolConfig.js";
import { errorHandler } from "../middleware/errorHandler.js";

/**
 * A Prisma-like client whose interactive transaction runs inline and records
 * every statement issued through the transaction client, so tests can assert on
 * the `SET LOCAL statement_timeout` the helper applies.
 */
function makeClient() {
  const executed: string[] = [];
  const tx = {
    $executeRawUnsafe: async (sql: string) => {
      executed.push(sql);
      return 0;
    },
  };
  return {
    executed,
    tx,
    $transaction: (fn: (t: any) => Promise<unknown>) => fn(tx),
  };
}

/** Minimal Express response double capturing status, headers and JSON body. */
function makeRes() {
  const res: any = { statusCode: 0, headers: {} as Record<string, string>, body: undefined };
  res.setHeader = (key: string, value: string) => {
    res.headers[key] = value;
    return res;
  };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: unknown) => {
    res.body = body;
    return res;
  };
  return res;
}

const req: any = { method: "GET", originalUrl: "/api/exports/transactions", url: "/api/exports/transactions", ip: "127.0.0.1" };

describe("statement timeout configuration", () => {
  it("falls back to the documented defaults when unset", () => {
    expect(getStatementTimeoutMs({} as NodeJS.ProcessEnv)).toBe(DEFAULT_STATEMENT_TIMEOUT_MS);
    expect(getLongRunningStatementTimeoutMs({} as NodeJS.ProcessEnv)).toBe(
      DEFAULT_LONG_RUNNING_STATEMENT_TIMEOUT_MS
    );
  });

  it("reads the configured values", () => {
    expect(
      getStatementTimeoutMs({ DB_STATEMENT_TIMEOUT_MS: "2000" } as NodeJS.ProcessEnv)
    ).toBe(2000);
    expect(
      getLongRunningStatementTimeoutMs({
        DB_LONG_RUNNING_STATEMENT_TIMEOUT_MS: "600000",
      } as NodeJS.ProcessEnv)
    ).toBe(600000);
  });

  it("keeps the long-running override above the interactive default", () => {
    expect(DEFAULT_LONG_RUNNING_STATEMENT_TIMEOUT_MS).toBeGreaterThan(
      DEFAULT_STATEMENT_TIMEOUT_MS
    );
  });

  it.each([["0"], ["-1"], ["abc"], [""]])(
    "rejects the invalid timeout %p and keeps the default",
    (value) => {
      expect(
        getStatementTimeoutMs({ DB_STATEMENT_TIMEOUT_MS: value } as NodeJS.ProcessEnv)
      ).toBe(DEFAULT_STATEMENT_TIMEOUT_MS);
      expect(
        getLongRunningStatementTimeoutMs({
          DB_LONG_RUNNING_STATEMENT_TIMEOUT_MS: value,
        } as NodeJS.ProcessEnv)
      ).toBe(DEFAULT_LONG_RUNNING_STATEMENT_TIMEOUT_MS);
    }
  );
});

describe("connection-level statement timeout", () => {
  it("builds an encoded libpq options value", () => {
    expect(buildStatementTimeoutOption(15000)).toBe("-cstatement_timeout%3D15000");
    expect(buildStatementTimeoutOption(15000.9)).toBe("-cstatement_timeout%3D15000");
  });

  it("installs the default statement timeout on the database URL", () => {
    const url = buildDatabaseUrl({
      DATABASE_URL: "postgres://user:pw@host:5432/db",
    } as NodeJS.ProcessEnv);

    expect(url).toContain(`&options=${buildStatementTimeoutOption(DEFAULT_STATEMENT_TIMEOUT_MS)}`);
  });

  it("honours an explicit DB_STATEMENT_TIMEOUT_MS override", () => {
    const url = buildDatabaseUrl({
      DATABASE_URL: "postgres://user:pw@host:5432/db?sslmode=require",
      DB_STATEMENT_TIMEOUT_MS: "2000",
    } as NodeJS.ProcessEnv);

    expect(url).toContain(`&options=${buildStatementTimeoutOption(2000)}`);
  });
});

describe("isStatementTimeoutError", () => {
  it("recognises a statement cut off by the timeout in its common shapes", () => {
    expect(isStatementTimeoutError({ code: STATEMENT_TIMEOUT_SQLSTATE })).toBe(true);
    expect(isStatementTimeoutError({ meta: { code: STATEMENT_TIMEOUT_SQLSTATE } })).toBe(true);
    expect(isStatementTimeoutError({ originalCode: STATEMENT_TIMEOUT_SQLSTATE })).toBe(true);
    expect(
      isStatementTimeoutError(new Error("canceling statement due to statement timeout"))
    ).toBe(true);
    expect(
      isStatementTimeoutError(
        Object.assign(new Error("wrapped"), {
          cause: { originalCode: STATEMENT_TIMEOUT_SQLSTATE },
        })
      )
    ).toBe(true);
    expect(isStatementTimeoutError(new StatementTimeoutError())).toBe(true);
  });

  it("ignores unrelated failures", () => {
    expect(isStatementTimeoutError(new Error("boom"))).toBe(false);
    expect(isStatementTimeoutError({ code: "P2002" })).toBe(false);
    expect(isStatementTimeoutError(undefined)).toBe(false);
  });
});

describe("runWithStatementTimeout", () => {
  it("runs a query that finishes within the timeout using the default budget", async () => {
    const client = makeClient();
    const rows = [{ id: "r1" }];

    const result = await runWithStatementTimeout(
      client,
      getStatementTimeoutMs({} as NodeJS.ProcessEnv),
      async () => rows
    );

    expect(result).toEqual(rows);
    expect(client.executed).toEqual([
      `SET LOCAL statement_timeout = ${DEFAULT_STATEMENT_TIMEOUT_MS}`,
    ]);
  });

  it("maps a statement held past the timeout into a clear, retryable error", async () => {
    const client = makeClient();
    const cutOff = Object.assign(new Error("canceling statement due to statement timeout"), {
      code: STATEMENT_TIMEOUT_SQLSTATE,
    });

    const error = await runWithStatementTimeout(
      client,
      DEFAULT_STATEMENT_TIMEOUT_MS,
      async () => {
        throw cutOff;
      }
    ).catch((err) => err);

    expect(error).toBeInstanceOf(StatementTimeoutError);
    expect(error.retryable).toBe(true);
    expect(error.statusCode).toBe(503);
    expect(error.timeoutMs).toBe(DEFAULT_STATEMENT_TIMEOUT_MS);
  });

  it("runs a long-running job on its explicit override, above the default", async () => {
    const client = makeClient();
    const override = getLongRunningStatementTimeoutMs({
      DB_LONG_RUNNING_STATEMENT_TIMEOUT_MS: "600000",
    } as NodeJS.ProcessEnv);

    expect(override).toBeGreaterThan(DEFAULT_STATEMENT_TIMEOUT_MS);

    const rows = await runWithStatementTimeout(client, override, async () => ["row"]);
    expect(rows).toEqual(["row"]);
    // The override — not the interactive default — is what the connection sees.
    expect(client.executed).toEqual(["SET LOCAL statement_timeout = 600000"]);
    expect(client.executed).not.toContain(
      `SET LOCAL statement_timeout = ${DEFAULT_STATEMENT_TIMEOUT_MS}`
    );
  });

  it("runs directly when the client exposes no interactive transaction", async () => {
    const rows = await runWithStatementTimeout({}, 5000, async (tx) => {
      // No $transaction on this double; the callback receives the client itself.
      expect(tx).toEqual({});
      return "ok";
    });
    expect(rows).toBe("ok");
  });

  it("leaves non-timeout failures untouched", async () => {
    const failure = new Error("relation does not exist");
    const error = await runWithStatementTimeout(
      makeClient(),
      DEFAULT_STATEMENT_TIMEOUT_MS,
      async () => {
        throw failure;
      }
    ).catch((err) => err);

    expect(error).toBe(failure);
  });
});

describe("toStatementTimeoutError", () => {
  it("returns non-timeout errors unchanged", () => {
    const failure = new Error("boom");
    expect(toStatementTimeoutError(failure)).toBe(failure);
  });

  it("does not re-wrap an already-mapped timeout error", () => {
    const mapped = new StatementTimeoutError(1000);
    expect(toStatementTimeoutError(mapped)).toBe(mapped);
  });
});

describe("errorHandler", () => {
  it("returns a clear, retryable 503 for a statement timeout", () => {
    const res = makeRes();

    errorHandler(
      Object.assign(new Error("canceling statement due to statement timeout"), {
        code: STATEMENT_TIMEOUT_SQLSTATE,
      }),
      req,
      res,
      jest.fn()
    );

    expect(res.statusCode).toBe(503);
    expect(res.headers["Retry-After"]).toBe("1");
    expect(res.body.retryable).toBe(true);
    expect(res.body.error).toBe("statement_timeout");
    expect(res.body.statusCode).toBe(503);
  });

  it("leaves non-timeout errors on their existing response path", () => {
    const res = makeRes();

    errorHandler(Object.assign(new Error("boom"), { statusCode: 418 }), req, res, jest.fn());

    expect(res.statusCode).toBe(418);
    expect(res.body.error).toBe("boom");
    expect(res.headers["Retry-After"]).toBeUndefined();
  });
});
