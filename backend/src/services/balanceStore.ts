/**
 * Mock/stub database model for borrower on-chain balances.
 *
 * Mirrors the in-memory `Map`-backed approach used by `loanStore`. In
 * production this interface would be backed by a real database; the listener
 * depends only on the {@link BorrowerBalanceRepository} interface so the
 * storage layer can be swapped without touching the event-handling logic.
 */

/** Active on-chain balances tracked for a borrower account. */
export interface BorrowerBalance {
  address: string;
  /** Accumulated escrow savings (stroops, i128 as a decimal string). */
  escrowBalance: string;
  /** Outstanding loan principal disbursed minus repaid (stroops). */
  loanOutstanding: string;
  /** Ledger sequence of the most recent event applied to this account. */
  lastEventLedger: number;
  updatedAt: string;
}

export interface BorrowerBalanceRepository {
  get(address: string): BorrowerBalance | null;
  list(): BorrowerBalance[];
  applyEscrowDeposit(address: string, amount: string, ledger: number): BorrowerBalance;
  applyEscrowWithdraw(address: string, amount: string, ledger: number): BorrowerBalance;
  applyDisbursement(address: string, amount: string, ledger: number): BorrowerBalance;
  applyRepayment(address: string, amount: string, ledger: number): BorrowerBalance;
}

/** Adds two non-negative integer (stroop) decimal strings. */
function addStroops(a: string, b: string): string {
  return (BigInt(a) + BigInt(b)).toString();
}

/** Subtracts `b` from `a`, clamping at zero so balances never go negative. */
function subStroops(a: string, b: string): string {
  const result = BigInt(a) - BigInt(b);
  return (result < 0n ? 0n : result).toString();
}

export class InMemoryBalanceRepository implements BorrowerBalanceRepository {
  private store = new Map<string, BorrowerBalance>();

  get(address: string): BorrowerBalance | null {
    return this.store.get(address) ?? null;
  }

  list(): BorrowerBalance[] {
    return Array.from(this.store.values());
  }

  private upsert(
    address: string,
    ledger: number,
    mutate: (b: BorrowerBalance) => void
  ): BorrowerBalance {
    const existing = this.store.get(address) ?? {
      address,
      escrowBalance: "0",
      loanOutstanding: "0",
      lastEventLedger: 0,
      updatedAt: new Date().toISOString(),
    };
    mutate(existing);
    existing.lastEventLedger = Math.max(existing.lastEventLedger, ledger);
    existing.updatedAt = new Date().toISOString();
    this.store.set(address, existing);
    return existing;
  }

  applyEscrowDeposit(address: string, amount: string, ledger: number): BorrowerBalance {
    return this.upsert(address, ledger, (b) => {
      b.escrowBalance = addStroops(b.escrowBalance, amount);
    });
  }

  applyEscrowWithdraw(address: string, amount: string, ledger: number): BorrowerBalance {
    return this.upsert(address, ledger, (b) => {
      b.escrowBalance = subStroops(b.escrowBalance, amount);
    });
  }

  applyDisbursement(address: string, amount: string, ledger: number): BorrowerBalance {
    return this.upsert(address, ledger, (b) => {
      b.loanOutstanding = addStroops(b.loanOutstanding, amount);
    });
  }

  applyRepayment(address: string, amount: string, ledger: number): BorrowerBalance {
    return this.upsert(address, ledger, (b) => {
      b.loanOutstanding = subStroops(b.loanOutstanding, amount);
    });
  }
}

/** Default process-wide repository instance used by the running listener. */
export const balanceRepository: BorrowerBalanceRepository =
  new InMemoryBalanceRepository();
