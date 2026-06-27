import { http, HttpResponse } from 'msw';

const HORIZON_URL = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';

/** Accounts that simulate specific edge cases. */
const MISSING_ACCOUNT = 'G_MISSING_ACCOUNT_NOT_FOUND_000000000000';
const RATE_LIMITED_ACCOUNT = 'G_RATE_LIMITED_ACCOUNT_0000000000000000';

function buildPaymentRecord(
  id: string,
  from: string,
  to: string,
  amount: string,
  createdAt: string,
  assetCode = 'USDC',
) {
  return {
    id,
    paging_token: id,
    type: 'payment',
    type_i: 2,
    transaction_successful: true,
    source_account: from,
    from,
    to,
    asset_type: 'credit_alphanum4',
    asset_code: assetCode,
    asset_issuer: 'GCQPYGH4K57XBDENKKX55KDTWOTK5WDWRQOH2LHEDX3EKVIQRLMESGBG',
    amount,
    created_at: createdAt,
  };
}

function buildOperationRecord(id: string, from: string, to: string, amount: string, createdAt: string) {
  return {
    id,
    paging_token: id,
    type: 'payment',
    type_i: 2,
    transaction_successful: true,
    source_account: from,
    from,
    to,
    asset_type: 'credit_alphanum4',
    asset_code: 'USDC',
    asset_issuer: 'GCQPYGH4K57XBDENKKX55KDTWOTK5WDWRQOH2LHEDX3EKVIQRLMESGBG',
    amount,
    created_at: createdAt,
  };
}

export const horizonHandlers = [
  // ── /accounts/:accountId ──────────────────────────────────────────────────

  /** 404 for an account that does not exist on the mocked network. */
  http.get(`${HORIZON_URL}/accounts/${MISSING_ACCOUNT}`, () =>
    HttpResponse.json(
      {
        type: 'https://stellar.org/horizon-errors/not_found',
        title: 'Resource Missing',
        status: 404,
        detail: 'The resource at the url requested was not found.',
      },
      { status: 404 }
    )
  ),

  /** 429 for an account that triggers rate-limit simulation. */
  http.get(`${HORIZON_URL}/accounts/${RATE_LIMITED_ACCOUNT}`, () =>
    HttpResponse.json(
      {
        type: 'https://stellar.org/horizon-errors/rate_limit_exceeded',
        title: 'Rate Limit Exceeded',
        status: 429,
      },
      { status: 429, headers: { 'Retry-After': '5' } }
    )
  ),

  /** Default account response with a USDC and native balance. */
  http.get(`${HORIZON_URL}/accounts/:accountId`, ({ params }) => {
    return HttpResponse.json({
      id: params.accountId,
      account_id: params.accountId,
      sequence: '1234567890123456',
      subentry_count: 1,
      last_modified_ledger: 45000000,
      thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
      flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
      balances: [
        {
          balance: '5000.0000000',
          limit: '922337203685.4775807',
          buying_liabilities: '0.0000000',
          selling_liabilities: '0.0000000',
          last_modified_ledger: 45000000,
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: 'GCQPYGH4K57XBDENKKX55KDTWOTK5WDWRQOH2LHEDX3EKVIQRLMESGBG',
        },
        {
          balance: '10.0000000',
          buying_liabilities: '0.0000000',
          selling_liabilities: '0.0000000',
          asset_type: 'native',
        },
      ],
      signers: [{ weight: 1, key: params.accountId, type: 'ed25519_public_key' }],
      data: {},
    });
  }),

  // ── /accounts/:accountId/payments ────────────────────────────────────────

  /** Empty payment history for MISSING_ACCOUNT (404 cascades at account level, but guard here too). */
  http.get(`${HORIZON_URL}/accounts/${MISSING_ACCOUNT}/payments`, () =>
    HttpResponse.json(
      { type: 'https://stellar.org/horizon-errors/not_found', status: 404 },
      { status: 404 }
    )
  ),

  /** Default mock payment history: two monthly USDC remittances 30 days apart. */
  http.get(`${HORIZON_URL}/accounts/:accountId/payments`, ({ params }) => {
    const accountId = params.accountId as string;
    const records = [
      buildPaymentRecord(
        '1122334455',
        'G_EMPLOYER_MOCK_ACCOUNT',
        accountId,
        '2000.0000000',
        new Date().toISOString(),
      ),
      buildPaymentRecord(
        '1122334456',
        'G_EMPLOYER_MOCK_ACCOUNT',
        accountId,
        '2000.0000000',
        new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      ),
    ];
    return HttpResponse.json({
      _links: { self: { href: '' }, next: { href: '' }, prev: { href: '' } },
      _embedded: { records },
    });
  }),

  // ── /accounts/:accountId/operations ──────────────────────────────────────

  http.get(`${HORIZON_URL}/accounts/${MISSING_ACCOUNT}/operations`, () =>
    HttpResponse.json(
      { type: 'https://stellar.org/horizon-errors/not_found', status: 404 },
      { status: 404 }
    )
  ),

  http.get(`${HORIZON_URL}/accounts/:accountId/operations`, ({ params, request }) => {
    const accountId = params.accountId as string;
    const url = new URL(request.url);
    const cursor = url.searchParams.get('cursor') ?? '0';

    // Simulate a second page cursor returning empty to signal end of history.
    if (cursor !== '0') {
      return HttpResponse.json({
        _links: { self: { href: '' }, next: { href: '' }, prev: { href: '' } },
        _embedded: { records: [] },
      });
    }

    const records = Array.from({ length: 8 }, (_, i) =>
      buildOperationRecord(
        String(1000 + i),
        'G_EMPLOYER_MOCK_ACCOUNT',
        accountId,
        '2000.0000000',
        new Date(Date.now() - i * 30 * 24 * 60 * 60 * 1000).toISOString(),
      )
    );

    return HttpResponse.json({
      _links: { self: { href: '' }, next: { href: `${HORIZON_URL}/accounts/${accountId}/operations?cursor=end` }, prev: { href: '' } },
      _embedded: { records },
    });
  }),

  // ── /accounts/:accountId/transactions ─────────────────────────────────────

  http.get(`${HORIZON_URL}/accounts/${MISSING_ACCOUNT}/transactions`, () =>
    HttpResponse.json(
      { type: 'https://stellar.org/horizon-errors/not_found', status: 404 },
      { status: 404 }
    )
  ),

  http.get(`${HORIZON_URL}/accounts/:accountId/transactions`, ({ params }) => {
    const accountId = params.accountId as string;
    return HttpResponse.json({
      _links: { self: { href: '' }, next: { href: '' }, prev: { href: '' } },
      _embedded: {
        records: [
          {
            id: 'txn_mock_001',
            paging_token: 'txn_mock_001',
            hash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
            ledger: 45000001,
            created_at: new Date().toISOString(),
            source_account: accountId,
            source_account_sequence: '1234567890123456',
            fee_charged: '100',
            max_fee: '100',
            operation_count: 1,
            result_code: 'txSUCCESS',
            memo_type: 'none',
          },
        ],
      },
    });
  }),

  // ── /transactions/:hash ───────────────────────────────────────────────────

  http.get(`${HORIZON_URL}/transactions/:hash`, ({ params }) => {
    return HttpResponse.json({
      id: params.hash,
      paging_token: params.hash,
      hash: params.hash,
      ledger: 45000001,
      created_at: new Date().toISOString(),
      result_code: 'txSUCCESS',
      operation_count: 1,
      fee_charged: '100',
    });
  }),
];

/** Account IDs that trigger specific error behaviors in the mock server. */
export const MOCK_EDGE_CASES = {
  MISSING_ACCOUNT,
  RATE_LIMITED_ACCOUNT,
} as const;
