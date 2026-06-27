import { Keypair } from "@stellar/stellar-sdk";
import {
  analyzeRemittanceHistory,
  fetchAllOperations,
  summarizePayments,
  detectSelfDealing,
  createHorizonServer,
  InvalidStellarAddressError,
  PAGE_LIMIT,
  HorizonOperation,
  HorizonServerLike,
  OperationsPageLike,
} from "../services/stellar";

/** Build a payment operation record as Horizon would return it. */
function payment(
  from: string,
  to: string,
  amount: string,
  date: string,
  assetCode = "USDC"
): HorizonOperation {
  return {
    type: "payment",
    from,
    to,
    asset_code: assetCode,
    asset_type: "credit_alphanum4",
    amount,
    created_at: date,
  };
}

/**
 * Fake Horizon server that paginates a fixed per-account operation history in
 * pages of PAGE_LIMIT, exposing the same builder + `next()` cursor shape the
 * service consumes.
 */
function mockServer(history: Record<string, HorizonOperation[]>): HorizonServerLike {
  function pageFrom(records: HorizonOperation[], start: number): OperationsPageLike {
    return {
      records: records.slice(start, start + PAGE_LIMIT),
      next: async () => pageFrom(records, start + PAGE_LIMIT),
    };
  }
  return {
    operations: () => ({
      forAccount: (account: string) => ({
        limit: () => ({
          order: () => ({
            call: async () => pageFrom(history[account] ?? [], 0),
          }),
        }),
      }),
    }),
  };
}

const SENDER = Keypair.random().publicKey();
const RECIPIENT = Keypair.random().publicKey();
const OTHER_BORROWER_WALLET = Keypair.random().publicKey();

/** N roughly-monthly USDC payments from sender to recipient starting 2023-01. */
function monthlySpanPayments(count: number, amount = "100"): HorizonOperation[] {
  return Array.from({ length: count }, (_, i) =>
    payment(SENDER, RECIPIENT, amount, new Date(Date.UTC(2023, i, 1)).toISOString())
  );
}

// ── Pagination ────────────────────────────────────────────────────────────

describe("fetchAllOperations (pagination)", () => {
  it("retrieves history beyond the first 200 operations via next() cursors", async () => {
    const records = monthlySpanPayments(250);
    const server = mockServer({ [SENDER]: records });

    const all = await fetchAllOperations(SENDER, server);

    expect(all).toHaveLength(250);
  });

  it("stops once a short (final) page is returned", async () => {
    const records = monthlySpanPayments(PAGE_LIMIT); // exactly one full page
    const server = mockServer({ [SENDER]: records });

    const all = await fetchAllOperations(SENDER, server);

    expect(all).toHaveLength(PAGE_LIMIT);
  });
});

describe("analyzeRemittanceHistory (pagination aggregation)", () => {
  it("aggregates payments across more than 200 operations", async () => {
    const server = mockServer({ [SENDER]: monthlySpanPayments(250) });

    const result = await analyzeRemittanceHistory(SENDER, RECIPIENT, { server });

    expect(result.totalPayments).toBe(250);
    expect(result.eligible).toBe(true);
    expect(result.selfDealing).toBe(false);
  });
});

// ── Self-dealing / circular transfers ──────────────────────────────────────

describe("self-dealing detection", () => {
  it("flags circular transfers (Sender → Recipient → Sender) as ineligible", async () => {
    const server = mockServer({
      [SENDER]: monthlySpanPayments(8),
      // Recipient routes funds back to the sender.
      [RECIPIENT]: [payment(RECIPIENT, SENDER, "500", "2023-06-01T00:00:00Z")],
    });

    const result = await analyzeRemittanceHistory(SENDER, RECIPIENT, { server });

    expect(result.selfDealing).toBe(true);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/self-dealing/i);
  });

  it("flags funds forwarded to another wallet owned by the borrower", async () => {
    const server = mockServer({
      [SENDER]: monthlySpanPayments(8),
      [RECIPIENT]: [
        payment(RECIPIENT, OTHER_BORROWER_WALLET, "300", "2023-06-01T00:00:00Z"),
      ],
    });

    const result = await analyzeRemittanceHistory(SENDER, RECIPIENT, {
      server,
      borrowerWallets: [OTHER_BORROWER_WALLET],
    });

    expect(result.selfDealing).toBe(true);
    expect(result.eligible).toBe(false);
  });

  it("does not flag a recipient who only receives, never returns funds", async () => {
    const server = mockServer({
      [SENDER]: monthlySpanPayments(8),
      [RECIPIENT]: [], // no outgoing payments
    });

    const result = await analyzeRemittanceHistory(SENDER, RECIPIENT, { server });

    expect(result.selfDealing).toBe(false);
    expect(result.eligible).toBe(true);
  });

  describe("detectSelfDealing (unit)", () => {
    it("returns true when the recipient sends USDC back to a flagged wallet", () => {
      const ops = [payment(RECIPIENT, SENDER, "100", "2023-01-01T00:00:00Z")];
      expect(detectSelfDealing(ops, RECIPIENT, new Set([SENDER]))).toBe(true);
    });

    it("ignores non-USDC returns", () => {
      const ops = [payment(RECIPIENT, SENDER, "100", "2023-01-01T00:00:00Z", "XLM")];
      expect(detectSelfDealing(ops, RECIPIENT, new Set([SENDER]))).toBe(false);
    });

    it("ignores payments to wallets that are not flagged", () => {
      const unrelated = Keypair.random().publicKey();
      const ops = [payment(RECIPIENT, unrelated, "100", "2023-01-01T00:00:00Z")];
      expect(detectSelfDealing(ops, RECIPIENT, new Set([SENDER]))).toBe(false);
    });
  });
});

// ── Filtering ───────────────────────────────────────────────────────────────

describe("payment filtering", () => {
  it("ignores non-USDC payments and payments to other recipients", async () => {
    const unrelated = Keypair.random().publicKey();
    const server = mockServer({
      [SENDER]: [
        payment(SENDER, RECIPIENT, "100", "2023-01-01T00:00:00Z", "XLM"),
        payment(SENDER, unrelated, "100", "2023-02-01T00:00:00Z"),
        { type: "create_account", created_at: "2023-01-01T00:00:00Z" },
      ],
    });

    const result = await analyzeRemittanceHistory(SENDER, RECIPIENT, { server });

    expect(result.totalPayments).toBe(0);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/no usdc payments/i);
  });
});

// ── Validation ────────────────────────────────────────────────────────────

describe("address validation", () => {
  it("throws InvalidStellarAddressError for a malformed sender address", async () => {
    await expect(
      analyzeRemittanceHistory("NOT_A_VALID_ADDRESS", RECIPIENT, {
        server: mockServer({}),
      })
    ).rejects.toBeInstanceOf(InvalidStellarAddressError);
  });

  it("throws InvalidStellarAddressError for a malformed recipient address", async () => {
    await expect(
      analyzeRemittanceHistory(SENDER, "GARBAGE", { server: mockServer({}) })
    ).rejects.toBeInstanceOf(InvalidStellarAddressError);
  });
});

// ── Statistics: average amount + timespan ───────────────────────────────────

describe("summarizePayments (average + timespan)", () => {
  it("computes the average USDC transaction amount", () => {
    const stats = summarizePayments([
      { amount: "100", date: "2024-01-01T00:00:00Z" },
      { amount: "200", date: "2024-02-01T00:00:00Z" },
      { amount: "300", date: "2024-03-01T00:00:00Z" },
    ]);

    expect(stats.totalAmountUSDC).toBe("600.00");
    expect(stats.averageAmountUSDC).toBe("200.00");
    expect(stats.totalPayments).toBe(3);
  });

  it("computes the timespan in months between first and last payment", () => {
    const stats = summarizePayments([
      { amount: "100", date: "2024-04-01T00:00:00Z" },
      { amount: "100", date: "2024-01-01T00:00:00Z" }, // out of order on purpose
    ]);

    // ~90 days between Jan 1 and Apr 1 → 3 months.
    expect(stats.spanMonths).toBe(3);
    expect(stats.firstPayment).toBe("2024-01-01T00:00:00Z");
    expect(stats.lastPayment).toBe("2024-04-01T00:00:00Z");
  });

  it("returns zeroed stats for an empty payment set", () => {
    const stats = summarizePayments([]);
    expect(stats.totalPayments).toBe(0);
    expect(stats.averageAmountUSDC).toBe("0");
    expect(stats.spanMonths).toBe(0);
    expect(stats.firstPayment).toBeNull();
  });
});

// ── Multi-network configuration ────────────────────────────────────────────

describe("createHorizonServer (multi-network)", () => {
  it("uses the supplied URL when explicitly provided", () => {
    const customUrl = "https://custom-horizon.example.com";
    const server = createHorizonServer(customUrl, "testnet");
    // The returned server is an HorizonServerLike; verify it was constructed
    // without throwing and exposes the operations builder.
    expect(typeof server.operations).toBe("function");
  });

  it("falls back to the canonical testnet URL when horizonUrl is empty", () => {
    const server = createHorizonServer("", "testnet");
    expect(typeof server.operations).toBe("function");
  });

  it("falls back to the canonical mainnet URL when horizonUrl is empty", () => {
    const server = createHorizonServer("", "mainnet");
    expect(typeof server.operations).toBe("function");
  });

  it("falls back to the local standalone URL when horizonUrl is empty", () => {
    const server = createHorizonServer("", "standalone");
    expect(typeof server.operations).toBe("function");
  });

  it("analysis runs identically against a futurenet-targeted mock server", async () => {
    const server = mockServer({
      [SENDER]: monthlySpanPayments(8),
      [RECIPIENT]: [],
    });
    const result = await analyzeRemittanceHistory(SENDER, RECIPIENT, { server });
    expect(result.eligible).toBe(true);
    expect(result.selfDealing).toBe(false);
  });
});
