"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import dynamic from "next/dynamic";
import { ChangeEvent, useMemo, useState } from "react";
import {
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

const Navbar = dynamic(() => import("../../components/Navbar"), { ssr: false });

type CommitteeMember = {
  id: string;
  label: string;
  publicKey: string;
  weight: number;
};

type FreighterModule = {
  requestAccess?: () => void | Promise<void>;
  getPublicKey?: () => string | Promise<string>;
  signTransaction?: (
    transactionXdr: string,
    options: { networkPassphrase: string }
  ) => string | Promise<string>;
};

const defaultMembers: CommitteeMember[] = [
  { id: "member-1", label: "Committee member 1", publicKey: "", weight: 1 },
  { id: "member-2", label: "Committee member 2", publicKey: "", weight: 1 },
];

function validatePublicKey(publicKey: string) {
  try {
    Keypair.fromPublicKey(publicKey.trim());
    return true;
  } catch {
    return false;
  }
}

function shortKey(publicKey: string) {
  if (!publicKey) return "Pending public key";
  return `${publicKey.slice(0, 8)}...${publicKey.slice(-6)}`;
}

async function getFreighterPublicKey() {
  const freighter = (await import("@stellar/freighter-api")) as FreighterModule;

  if (typeof freighter.requestAccess === "function") {
    await freighter.requestAccess();
  }

  if (typeof freighter.getPublicKey === "function") {
    return freighter.getPublicKey();
  }

  throw new Error("Freighter public key API is unavailable.");
}

async function signTransactionWithFreighter(transactionXdr: string, networkPassphrase: string) {
  const freighter = (await import("@stellar/freighter-api")) as FreighterModule;

  if (typeof freighter.signTransaction !== "function") {
    throw new Error("Freighter signing API is unavailable.");
  }

  return freighter.signTransaction(transactionXdr, { networkPassphrase });
}

export default function MultisigCoordinatorPage() {
  const [governanceAccount, setGovernanceAccount] = useState("");
  const [members, setMembers] = useState<CommitteeMember[]>(defaultMembers);
  const [masterWeight, setMasterWeight] = useState(1);
  const [lowThreshold, setLowThreshold] = useState(1);
  const [mediumThreshold, setMediumThreshold] = useState(2);
  const [highThreshold, setHighThreshold] = useState(3);
  const [transactionXdr, setTransactionXdr] = useState("");
  const [signedTransactionXdr, setSignedTransactionXdr] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  const horizonUrl = process.env.NEXT_PUBLIC_HORIZON_URL || "https://horizon-testnet.stellar.org";
  const networkPassphrase = process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET;
  const validMembers = useMemo(
    () => members.filter((member) => validatePublicKey(member.publicKey) && member.weight > 0),
    [members]
  );
  const totalWeight =
    masterWeight + validMembers.reduce((sum, member) => sum + Number(member.weight || 0), 0);
  const maxThreshold = Math.max(lowThreshold, mediumThreshold, highThreshold);
  const validationMessages = useMemo(() => {
    const messages: string[] = [];

    if (!validatePublicKey(governanceAccount)) {
      messages.push("Enter the governance account public key.");
    }

    if (members.some((member) => member.publicKey.trim() && !validatePublicKey(member.publicKey))) {
      messages.push("Every entered committee public key must be a valid Stellar public key.");
    }

    if (validMembers.length === 0) {
      messages.push("Add at least one valid committee signer.");
    }

    if (lowThreshold > mediumThreshold || mediumThreshold > highThreshold) {
      messages.push("Thresholds must be ordered Low <= Medium <= High.");
    }

    if (totalWeight < maxThreshold) {
      messages.push("Total available weight must meet or exceed the highest threshold.");
    }

    if (
      [
        masterWeight,
        lowThreshold,
        mediumThreshold,
        highThreshold,
        ...members.map((member) => member.weight),
      ].some((value) => value < 0 || value > 255)
    ) {
      messages.push("Weights and thresholds must be between 0 and 255.");
    }

    return messages;
  }, [
    governanceAccount,
    highThreshold,
    lowThreshold,
    masterWeight,
    maxThreshold,
    mediumThreshold,
    members,
    totalWeight,
    validMembers.length,
  ]);
  const isValidConfiguration = validationMessages.length === 0;
  const chartScale = Math.max(totalWeight, highThreshold, 1);

  function updateMember(id: string, field: keyof CommitteeMember, value: string | number) {
    setMembers((current) =>
      current.map((member) => (member.id === id ? { ...member, [field]: value } : member))
    );
    setTransactionXdr("");
    setSignedTransactionXdr("");
  }

  function addMember() {
    const nextIndex = members.length + 1;
    setMembers((current) => [
      ...current,
      {
        id: `member-${Date.now()}`,
        label: `Committee member ${nextIndex}`,
        publicKey: "",
        weight: 1,
      },
    ]);
    setTransactionXdr("");
    setSignedTransactionXdr("");
  }

  function removeMember(id: string) {
    setMembers((current) => current.filter((member) => member.id !== id));
    setTransactionXdr("");
    setSignedTransactionXdr("");
  }

  function handleNumberInput(setter: (value: number) => void) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      setter(Math.max(0, Number(event.target.value)));
      setTransactionXdr("");
      setSignedTransactionXdr("");
    };
  }

  async function connectGovernanceAccount() {
    setStatusMessage("Reading Freighter account...");

    try {
      const publicKey = await getFreighterPublicKey();
      setGovernanceAccount(publicKey);
      setStatusMessage("Governance account loaded from Freighter.");
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Could not read Freighter account."
      );
    }
  }

  async function buildSetupTransaction() {
    setStatusMessage("");
    setTransactionXdr("");
    setSignedTransactionXdr("");

    if (!isValidConfiguration) {
      setStatusMessage("Fix validation warnings before building the setup transaction.");
      return "";
    }

    setIsBusy(true);

    try {
      const server = new Horizon.Server(horizonUrl);
      const sourceAccount = await server.loadAccount(governanceAccount.trim());
      const builder = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase,
      }).addOperation(
        Operation.setOptions({
          masterWeight,
          lowThreshold,
          medThreshold: mediumThreshold,
          highThreshold,
        })
      );

      validMembers.forEach((member) => {
        builder.addOperation(
          Operation.setOptions({
            signer: {
              ed25519PublicKey: member.publicKey.trim(),
              weight: member.weight,
            },
          })
        );
      });

      const transaction = builder.setTimeout(300).build();
      const xdr = transaction.toXDR();
      setTransactionXdr(xdr);
      setStatusMessage("SetOptions transaction built successfully.");
      return xdr;
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Unable to build transaction.");
      return "";
    } finally {
      setIsBusy(false);
    }
  }

  async function signSetupTransaction() {
    const xdr = transactionXdr || (await buildSetupTransaction());

    if (!xdr) return;

    setIsBusy(true);
    setStatusMessage("Requesting Freighter signature...");

    try {
      const freighterPublicKey = await getFreighterPublicKey();

      if (freighterPublicKey !== governanceAccount.trim()) {
        throw new Error(
          "Freighter must be connected to the governance account master key before signing."
        );
      }

      const signedXdr = await signTransactionWithFreighter(xdr, networkPassphrase);
      setSignedTransactionXdr(signedXdr);
      setStatusMessage("Freighter signed the multisig setup transaction.");
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Freighter could not sign the transaction."
      );
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-[var(--bg-primary)]">
      <Navbar />

      <section className="pt-24 pb-16 px-6">
        <div className="max-w-7xl mx-auto">
          <div className="mb-8">
            <p className="text-sm font-semibold uppercase text-[var(--accent-secondary)]">
              Milestone governance
            </p>
            <h1 className="text-3xl md:text-4xl font-bold mt-2">Multisig Key Coordinator</h1>
            <p className="text-[var(--text-secondary)] mt-3 max-w-3xl">
              Register committee signer keys, assign Stellar signature weights, set transaction
              thresholds, and build the SetOptions transaction for the governance account.
            </p>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-[1.1fr_0.9fr] gap-6">
            <div className="space-y-6">
              <section className="glass-card p-6">
                <div className="flex flex-col md:flex-row md:items-end gap-4">
                  <label className="flex-1 space-y-2">
                    <span className="text-sm text-[var(--text-muted)]">
                      Governance account master key
                    </span>
                    <input
                      value={governanceAccount}
                      onChange={(event) => {
                        setGovernanceAccount(event.target.value);
                        setTransactionXdr("");
                        setSignedTransactionXdr("");
                      }}
                      placeholder="G..."
                      className="w-full p-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] font-mono"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={connectGovernanceAccount}
                    className="btn-outline !py-3 !px-5"
                  >
                    Use Freighter
                  </button>
                </div>
              </section>

              <section className="glass-card p-6 space-y-5">
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                  <div>
                    <h2 className="text-2xl font-semibold">Committee Signers</h2>
                    <p className="text-[var(--text-secondary)] mt-1">
                      Each valid signer becomes a SetOptions signer entry.
                    </p>
                  </div>
                  <button type="button" onClick={addMember} className="btn-primary !py-3 !px-5">
                    Add Key
                  </button>
                </div>

                <div className="space-y-4">
                  {members.map((member) => {
                    const keyIsInvalid =
                      member.publicKey.trim() && !validatePublicKey(member.publicKey);

                    return (
                      <div
                        key={member.id}
                        className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] p-4"
                      >
                        <div className="grid grid-cols-1 lg:grid-cols-[1fr_120px_auto] gap-3">
                          <label className="space-y-2">
                            <span className="text-sm text-[var(--text-muted)]">
                              {member.label} public key
                            </span>
                            <input
                              value={member.publicKey}
                              onChange={(event) =>
                                updateMember(member.id, "publicKey", event.target.value)
                              }
                              placeholder="G..."
                              className="w-full p-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] font-mono"
                            />
                            {keyIsInvalid && (
                              <span className="text-sm text-red-300">
                                Invalid Stellar public key.
                              </span>
                            )}
                          </label>

                          <label className="space-y-2">
                            <span className="text-sm text-[var(--text-muted)]">Weight</span>
                            <input
                              type="number"
                              min={0}
                              max={255}
                              value={member.weight}
                              onChange={(event) =>
                                updateMember(
                                  member.id,
                                  "weight",
                                  Math.max(0, Number(event.target.value))
                                )
                              }
                              className="w-full p-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)]"
                            />
                          </label>

                          <button
                            type="button"
                            onClick={() => removeMember(member.id)}
                            className="btn-outline !py-3 !px-5 lg:self-end"
                            disabled={members.length === 1}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="glass-card p-6 space-y-5">
                <div>
                  <h2 className="text-2xl font-semibold">Threshold Limits</h2>
                  <p className="text-[var(--text-secondary)] mt-1">
                    Stellar authorizes an operation when signer weight reaches the matching
                    threshold.
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <label className="space-y-2">
                    <span className="text-sm text-[var(--text-muted)]">Master weight</span>
                    <input
                      type="number"
                      min={0}
                      max={255}
                      value={masterWeight}
                      onChange={handleNumberInput(setMasterWeight)}
                      className="w-full p-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)]"
                    />
                  </label>
                  <label className="space-y-2">
                    <span className="text-sm text-[var(--text-muted)]">Low threshold</span>
                    <input
                      type="number"
                      min={0}
                      max={255}
                      value={lowThreshold}
                      onChange={handleNumberInput(setLowThreshold)}
                      className="w-full p-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)]"
                    />
                  </label>
                  <label className="space-y-2">
                    <span className="text-sm text-[var(--text-muted)]">Medium threshold</span>
                    <input
                      type="number"
                      min={0}
                      max={255}
                      value={mediumThreshold}
                      onChange={handleNumberInput(setMediumThreshold)}
                      className="w-full p-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)]"
                    />
                  </label>
                  <label className="space-y-2">
                    <span className="text-sm text-[var(--text-muted)]">High threshold</span>
                    <input
                      type="number"
                      min={0}
                      max={255}
                      value={highThreshold}
                      onChange={handleNumberInput(setHighThreshold)}
                      className="w-full p-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)]"
                    />
                  </label>
                </div>
              </section>
            </div>

            <aside className="space-y-6">
              <section className="glass-card p-6">
                <h2 className="text-2xl font-semibold">Weight Distribution</h2>
                <p className="text-[var(--text-secondary)] mt-2">
                  Available weight: {totalWeight}. Highest required threshold: {maxThreshold}.
                </p>

                <div className="mt-5 space-y-4">
                  <div>
                    <div className="flex justify-between text-sm mb-1">
                      <span>Master key</span>
                      <span>{masterWeight}</span>
                    </div>
                    <div className="h-3 rounded-full bg-[var(--bg-secondary)] overflow-hidden">
                      <div
                        className="h-full bg-indigo-400"
                        style={{ width: `${(masterWeight / chartScale) * 100}%` }}
                      />
                    </div>
                  </div>

                  {members.map((member) => (
                    <div key={`chart-${member.id}`}>
                      <div className="flex justify-between gap-3 text-sm mb-1">
                        <span className="truncate">{shortKey(member.publicKey)}</span>
                        <span>{member.weight}</span>
                      </div>
                      <div className="h-3 rounded-full bg-[var(--bg-secondary)] overflow-hidden">
                        <div
                          className={`h-full ${validatePublicKey(member.publicKey) ? "bg-cyan-400" : "bg-slate-600"}`}
                          style={{ width: `${(member.weight / chartScale) * 100}%` }}
                        />
                      </div>
                    </div>
                  ))}

                  <div className="grid grid-cols-3 gap-3 pt-2">
                    <div className="rounded-lg bg-[var(--bg-card)] p-3">
                      <p className="text-xs text-[var(--text-muted)]">Low</p>
                      <p className="text-xl font-bold">{lowThreshold}</p>
                    </div>
                    <div className="rounded-lg bg-[var(--bg-card)] p-3">
                      <p className="text-xs text-[var(--text-muted)]">Medium</p>
                      <p className="text-xl font-bold">{mediumThreshold}</p>
                    </div>
                    <div className="rounded-lg bg-[var(--bg-card)] p-3">
                      <p className="text-xs text-[var(--text-muted)]">High</p>
                      <p className="text-xl font-bold">{highThreshold}</p>
                    </div>
                  </div>
                </div>
              </section>

              <section className="glass-card p-6">
                <h2 className="text-2xl font-semibold">Validation</h2>
                {validationMessages.length > 0 ? (
                  <div className="mt-4 space-y-2">
                    {validationMessages.map((message) => (
                      <p
                        key={message}
                        className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-200"
                      >
                        {message}
                      </p>
                    ))}
                  </div>
                ) : (
                  <p className="mt-4 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
                    Configuration can satisfy all thresholds without locking the governance account.
                  </p>
                )}
              </section>

              <section className="glass-card p-6 space-y-4">
                <h2 className="text-2xl font-semibold">Transaction Builder</h2>
                <p className="text-[var(--text-secondary)]">
                  The transaction adds one SetOptions operation for thresholds and one SetOptions
                  operation per committee signer.
                </p>

                <div className="flex flex-col sm:flex-row gap-3">
                  <button
                    type="button"
                    onClick={buildSetupTransaction}
                    disabled={!isValidConfiguration || isBusy}
                    className="btn-outline disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    Build Transaction
                  </button>
                  <button
                    type="button"
                    onClick={signSetupTransaction}
                    disabled={!isValidConfiguration || isBusy}
                    className="btn-primary disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    Sign with Freighter
                  </button>
                </div>

                {statusMessage && (
                  <p className="text-sm text-[var(--text-secondary)]">{statusMessage}</p>
                )}

                {transactionXdr && (
                  <label className="block space-y-2">
                    <span className="text-sm text-[var(--text-muted)]">
                      Unsigned setup transaction XDR
                    </span>
                    <textarea
                      readOnly
                      value={transactionXdr}
                      className="h-32 w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] p-3 font-mono text-xs"
                    />
                  </label>
                )}

                {signedTransactionXdr && (
                  <label className="block space-y-2">
                    <span className="text-sm text-[var(--text-muted)]">Signed transaction XDR</span>
                    <textarea
                      readOnly
                      value={signedTransactionXdr}
                      className="h-32 w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] p-3 font-mono text-xs"
                    />
                  </label>
                )}
              </section>
            </aside>
          </div>
        </div>
      </section>
    </main>
  );
}
