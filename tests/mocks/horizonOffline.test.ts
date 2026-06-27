/**
 * Offline Horizon mock layer tests (#161)
 *
 * All requests are intercepted by MSW — no real network calls are made.
 * These tests verify that:
 *  1. Mock handlers return compliant Stellar JSON structures
 *  2. Edge cases (404, 429) are correctly simulated
 *  3. Payment and operation records match expected shapes
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { horizonHandlers, MOCK_EDGE_CASES } from './horizonHandlers';

const HORIZON_URL = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';

const server = setupServer(...horizonHandlers);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const TEST_ACCOUNT = 'GABC1234567890XYZABC1234567890XYZABC1234567890XYZABC12345';

async function getJson(path: string) {
  const res = await fetch(`${HORIZON_URL}${path}`);
  return { status: res.status, body: await res.json() };
}

// ── Account endpoint ─────────────────────────────────────────────────────────

describe('GET /accounts/:accountId', () => {
  it('returns a valid account object with balances', async () => {
    const { status, body } = await getJson(`/accounts/${TEST_ACCOUNT}`);
    expect(status).toBe(200);
    expect(body.account_id).toBe(TEST_ACCOUNT);
    expect(Array.isArray(body.balances)).toBe(true);
    expect(body.balances.length).toBeGreaterThan(0);
  });

  it('returns a USDC balance entry', async () => {
    const { body } = await getJson(`/accounts/${TEST_ACCOUNT}`);
    const usdc = body.balances.find(
      (b: { asset_code?: string }) => b.asset_code === 'USDC'
    );
    expect(usdc).toBeDefined();
    expect(parseFloat(usdc.balance)).toBeGreaterThan(0);
  });

  it('returns 404 for a missing account', async () => {
    const { status, body } = await getJson(`/accounts/${MOCK_EDGE_CASES.MISSING_ACCOUNT}`);
    expect(status).toBe(404);
    expect(body.title).toMatch(/missing/i);
  });

  it('returns 429 for a rate-limited account', async () => {
    const { status, body } = await getJson(`/accounts/${MOCK_EDGE_CASES.RATE_LIMITED_ACCOUNT}`);
    expect(status).toBe(429);
    expect(body.title).toMatch(/rate limit/i);
  });
});

// ── Payment history endpoint ─────────────────────────────────────────────────

describe('GET /accounts/:accountId/payments', () => {
  it('returns embedded records with payment objects', async () => {
    const { status, body } = await getJson(`/accounts/${TEST_ACCOUNT}/payments`);
    expect(status).toBe(200);
    const records = body._embedded?.records;
    expect(Array.isArray(records)).toBe(true);
    expect(records.length).toBeGreaterThan(0);
  });

  it('payment records have required Horizon fields', async () => {
    const { body } = await getJson(`/accounts/${TEST_ACCOUNT}/payments`);
    const record = body._embedded.records[0];
    expect(record).toHaveProperty('id');
    expect(record).toHaveProperty('type', 'payment');
    expect(record).toHaveProperty('from');
    expect(record).toHaveProperty('to');
    expect(record).toHaveProperty('amount');
    expect(record).toHaveProperty('created_at');
    expect(record).toHaveProperty('asset_code', 'USDC');
  });

  it('returns 404 for payments on a missing account', async () => {
    const { status } = await getJson(`/accounts/${MOCK_EDGE_CASES.MISSING_ACCOUNT}/payments`);
    expect(status).toBe(404);
  });
});

// ── Operations endpoint ──────────────────────────────────────────────────────

describe('GET /accounts/:accountId/operations', () => {
  it('returns a paginated operations list', async () => {
    const { status, body } = await getJson(`/accounts/${TEST_ACCOUNT}/operations`);
    expect(status).toBe(200);
    const records = body._embedded?.records;
    expect(Array.isArray(records)).toBe(true);
    expect(records.length).toBe(8);
  });

  it('returns an empty page for a non-zero cursor (end of history)', async () => {
    const { body } = await getJson(`/accounts/${TEST_ACCOUNT}/operations?cursor=end`);
    expect(body._embedded.records).toHaveLength(0);
  });

  it('returns 404 for operations on a missing account', async () => {
    const { status } = await getJson(`/accounts/${MOCK_EDGE_CASES.MISSING_ACCOUNT}/operations`);
    expect(status).toBe(404);
  });
});

// ── Transaction history endpoint ─────────────────────────────────────────────

describe('GET /accounts/:accountId/transactions', () => {
  it('returns a transaction list with required fields', async () => {
    const { status, body } = await getJson(`/accounts/${TEST_ACCOUNT}/transactions`);
    expect(status).toBe(200);
    const records = body._embedded?.records;
    expect(Array.isArray(records)).toBe(true);
    const tx = records[0];
    expect(tx).toHaveProperty('hash');
    expect(tx).toHaveProperty('ledger');
    expect(tx).toHaveProperty('created_at');
    expect(tx).toHaveProperty('result_code', 'txSUCCESS');
  });

  it('returns 404 for transactions on a missing account', async () => {
    const { status } = await getJson(`/accounts/${MOCK_EDGE_CASES.MISSING_ACCOUNT}/transactions`);
    expect(status).toBe(404);
  });
});

// ── Transaction by hash endpoint ─────────────────────────────────────────────

describe('GET /transactions/:hash', () => {
  it('returns transaction details for any hash', async () => {
    const hash = 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd';
    const { status, body } = await getJson(`/transactions/${hash}`);
    expect(status).toBe(200);
    expect(body.hash).toBe(hash);
    expect(body.result_code).toBe('txSUCCESS');
  });
});
