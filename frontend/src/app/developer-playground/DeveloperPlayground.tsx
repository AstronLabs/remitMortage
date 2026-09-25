"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useState, useEffect } from "react";
import {
  Contract,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  nativeToScVal,
  Address,
  scValToNative,
  Account,
} from "@stellar/stellar-sdk";
import { getRpcServer } from "@/lib/soroban-rpc";
import { useWallet } from "@/context/WalletContext";

// Gating the page component at runtime
const IS_PRODUCTION = process.env.NODE_ENV === "production";

type MethodArgType = "address" | "symbol" | "u32" | "i128" | "bytes32" | "string";

export interface MethodArg {
  name: string;
  type: MethodArgType;
  placeholder?: string;
  defaultValue?: string;
}

export interface MethodMetadata {
  name: string;
  label: string;
  description: string;
  args: MethodArg[];
}

export interface ContractMetadata {
  name: string;
  label: string;
  defaultId: string;
  methods: MethodMetadata[];
}

const CONTRACTS_CONFIG: ContractMetadata[] = [
  {
    name: "Escrow",
    label: "Escrow Contract",
    defaultId:
      process.env.NEXT_PUBLIC_ESCROW_CONTRACT_ID ||
      "CA3D5V2V5C3J5V2V5C3J5V2V5C3J5V2V5C3J5V2V5C3J5V2V5C3J5V2V",
    methods: [
      {
        name: "get_escrow_config",
        label: "get_escrow_config",
        description: "Retrieve general escrow settings and configurations.",
        args: [],
      },
      {
        name: "get_borrower_info",
        label: "get_borrower_info",
        description: "Get status, savings goal progress, and timeline for a borrower.",
        args: [
          { name: "borrower", type: "address", placeholder: "G..." },
          { name: "goal_id", type: "symbol", defaultValue: "savings" },
        ],
      },
      {
        name: "get_borrower_balance",
        label: "get_borrower_balance",
        description: "Get balance deposited in USDC (stroops) for a borrower.",
        args: [
          { name: "borrower", type: "address", placeholder: "G..." },
          { name: "goal_id", type: "symbol", defaultValue: "savings" },
        ],
      },
      {
        name: "get_total_pooled",
        label: "get_total_pooled",
        description: "Get total USDC deposited in the escrow contract.",
        args: [],
      },
      {
        name: "get_lockup_remaining",
        label: "get_lockup_remaining",
        description: "Retrieve remaining lockup period in ledgers.",
        args: [
          { name: "borrower", type: "address", placeholder: "G..." },
          { name: "goal_id", type: "symbol", defaultValue: "savings" },
        ],
      },
      {
        name: "get_current_penalty",
        label: "get_current_penalty",
        description: "Get current withdrawal penalty for borrower's current lockup tier.",
        args: [
          { name: "borrower", type: "address", placeholder: "G..." },
          { name: "goal_id", type: "symbol", defaultValue: "savings" },
        ],
      },
    ],
  },
  {
    name: "Lending Pool",
    label: "Lending Pool Contract",
    defaultId:
      process.env.NEXT_PUBLIC_LENDING_POOL_CONTRACT_ID ||
      "CB3D5V2V5C3J5V2V5C3J5V2V5C3J5V2V5C3J5V2V5C3J5V2V5C3J5V2V",
    methods: [
      {
        name: "get_pool_config",
        label: "get_pool_config",
        description: "Retrieve lending pool parameters and token references.",
        args: [],
      },
      {
        name: "get_liquidity",
        label: "get_liquidity",
        description: "Get total USDC liquidity in the pool.",
        args: [],
      },
      {
        name: "get_pool_health",
        label: "get_pool_health",
        description: "Get overall health metrics of the lending pool.",
        args: [],
      },
      {
        name: "get_available_withdrawal",
        label: "get_available_withdrawal",
        description: "Get how much USDC an investor can currently withdraw.",
        args: [{ name: "investor", type: "address", placeholder: "G..." }],
      },
      {
        name: "get_pending_yield",
        label: "get_pending_yield",
        description: "Get unclaimed yield for a specific investor.",
        args: [{ name: "investor", type: "address", placeholder: "G..." }],
      },
      {
        name: "get_investor_info",
        label: "get_investor_info",
        description: "Retrieve detailed record for an investor.",
        args: [{ name: "investor", type: "address", placeholder: "G..." }],
      },
      {
        name: "get_loan_info",
        label: "get_loan_info",
        description: "Get loan info by loan ID.",
        args: [{ name: "loan_id", type: "bytes32", placeholder: "32-byte hex string" }],
      },
      {
        name: "get_utilization",
        label: "get_utilization",
        description: "Get pool utilization rate in basis points.",
        args: [],
      },
    ],
  },
  {
    name: "Milestones",
    label: "Milestones Contract",
    defaultId:
      process.env.NEXT_PUBLIC_MILESTONE_CONTRACT_ID ||
      "CC3D5V2V5C3J5V2V5C3J5V2V5C3J5V2V5C3J5V2V5C3J5V2V5C3J5V2V",
    methods: [
      {
        name: "get_milestone",
        label: "get_milestone",
        description: "Get details of a milestone proposal.",
        args: [{ name: "proposal_id", type: "bytes32", placeholder: "32-byte hex string" }],
      },
      {
        name: "version",
        label: "version",
        description: "Retrieve contract code version.",
        args: [],
      },
    ],
  },
  {
    name: "Registry",
    label: "Registry Contract",
    defaultId:
      process.env.NEXT_PUBLIC_VERIFICATION_REGISTRY_CONTRACT_ID ||
      "CD3D5V2V5C3J5V2V5C3J5V2V5C3J5V2V5C3J5V2V5C3J5V2V5C3J5V2V",
    methods: [
      {
        name: "is_verified",
        label: "is_verified",
        description: "Check if a borrower is verified in the registry.",
        args: [{ name: "borrower", type: "address", placeholder: "G..." }],
      },
      {
        name: "get_verification",
        label: "get_verification",
        description: "Get detailed verification record for a borrower.",
        args: [{ name: "borrower", type: "address", placeholder: "G..." }],
      },
      {
        name: "version",
        label: "version",
        description: "Retrieve contract code version.",
        args: [],
      },
    ],
  },
];

export default function DeveloperPlayground() {
  const { publicKey, isConnected } = useWallet();

  const [selectedContract, setSelectedContract] = useState<ContractMetadata>(CONTRACTS_CONFIG[0]);
  const [contractId, setContractId] = useState<string>(CONTRACTS_CONFIG[0].defaultId);
  const [selectedMethod, setSelectedMethod] = useState<MethodMetadata>(
    CONTRACTS_CONFIG[0].methods[0]
  );
  const [argsValues, setArgsValues] = useState<Record<string, string>>({});
  const [sourceAddress, setSourceAddress] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [output, setOutput] = useState<any>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Sync default contract ID when selecting a new contract
  useEffect(() => {
    setContractId(selectedContract.defaultId);
    setSelectedMethod(selectedContract.methods[0]);
    setArgsValues({});
  }, [selectedContract]);

  // Sync inputs with method default values
  useEffect(() => {
    const defaults: Record<string, string> = {};
    selectedMethod.args.forEach((arg) => {
      if (arg.defaultValue) {
        defaults[arg.name] = arg.defaultValue;
      }
    });
    setArgsValues(defaults);
  }, [selectedMethod]);

  // Sync wallet address with source address input
  useEffect(() => {
    if (publicKey) {
      setSourceAddress(publicKey);
    } else {
      setSourceAddress("GBRPYHIL2CIW2GQN2DGUHNZMNH75WPI223B2A6ZGAIXZKCXIW4UBW6TZ"); // default dummy fallback
    }
  }, [publicKey]);

  if (IS_PRODUCTION) {
    return null;
  }

  const handleArgChange = (name: string, value: string) => {
    setArgsValues((prev) => ({ ...prev, [name]: value }));
  };

  const executeSimulation = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErrorMsg(null);
    setOutput(null);
    setLatency(null);

    const startTime = performance.now();

    try {
      if (!contractId) {
        throw new Error("Contract ID is required.");
      }
      if (!sourceAddress) {
        throw new Error("Source address is required.");
      }

      // 1. Prepare RPC Server
      const server = getRpcServer();

      // 2. Prepare Source Account (fallback if it is not funded/created on testnet)
      let source: Account;
      try {
        const horizonAccount = await server.getAccount(sourceAddress);
        source = horizonAccount;
      } catch (err) {
        // Fallback for non-funded addresses
        source = new Account(sourceAddress, "1");
      }

      // 3. Prepare Contract Call arguments
      const scArgs = selectedMethod.args.map((arg) => {
        const rawVal = argsValues[arg.name] || "";
        if (!rawVal && arg.type !== "string" && arg.type !== "symbol") {
          throw new Error(`Argument '${arg.name}' is required.`);
        }

        switch (arg.type) {
          case "address":
            try {
              return Address.fromString(rawVal).toScVal();
            } catch (err) {
              throw new Error(`Invalid address for argument '${arg.name}': ${rawVal}`);
            }
          case "symbol":
            return nativeToScVal(rawVal, { type: "symbol" });
          case "u32":
            const num = Number(rawVal);
            if (isNaN(num)) throw new Error(`Argument '${arg.name}' must be a valid number.`);
            return nativeToScVal(num, { type: "u32" });
          case "i128":
            try {
              return nativeToScVal(BigInt(rawVal), { type: "i128" });
            } catch {
              throw new Error(`Argument '${arg.name}' must be a valid 128-bit integer.`);
            }
          case "bytes32":
            const hex = rawVal.replace(/^0x/, "");
            if (hex.length !== 64) {
              throw new Error(
                `Argument '${arg.name}' must be a 32-byte hex string (64 characters).`
              );
            }
            return nativeToScVal(Buffer.from(hex, "hex"), { type: "bytes" });
          case "string":
          default:
            return nativeToScVal(rawVal, { type: "string" });
        }
      });

      // 4. Construct Contract
      const contract = new Contract(contractId);

      // 5. Build Transaction
      const tx = new TransactionBuilder(source, {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(contract.call(selectedMethod.name, ...scArgs))
        .setTimeout(300)
        .build();

      // 6. Simulate Transaction
      const simulation = await server.simulateTransaction(tx);

      const endTime = performance.now();
      setLatency(Math.round(endTime - startTime));

      if ("error" in simulation && simulation.error) {
        throw new Error(`Simulation failed: ${simulation.error}`);
      }

      // Check results
      if (!("result" in simulation) || !simulation.result) {
        setOutput({
          status: "SUCCESS",
          message: "Simulation completed successfully, but returned no result value.",
          simulationRaw: simulation,
        });
      } else {
        const retval = simulation.result.retval;
        let decodedResult: any;
        try {
          decodedResult = scValToNative(retval);
        } catch {
          decodedResult = retval; // fallback to raw XDR structure
        }

        setOutput({
          status: "SUCCESS",
          method: selectedMethod.name,
          result: decodedResult,
          events:
            simulation.events?.map((ev: any) => {
              try {
                return {
                  topics: ev.event.topic.map((t: any) => scValToNative(t)),
                  value: scValToNative(ev.event.value),
                };
              } catch {
                return ev;
              }
            }) || [],
          cost: {
            cpuInsns: (simulation.result as any)?.cpuInstructions,
            memBytes: (simulation.result as any)?.memoryBytes,
          },
        });
      }
    } catch (err: any) {
      const endTime = performance.now();
      setLatency(Math.round(endTime - startTime));
      setErrorMsg(err?.message || "An unknown error occurred during simulation.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[var(--bg-primary)] hero-bg dot-grid py-24 px-6">
      <div className="max-w-7xl mx-auto">
        <header className="mb-10 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/25">
                Sandbox Mode
              </span>
              <span className="text-xs text-[var(--text-muted)] font-mono">Testnet</span>
            </div>
            <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight">
              Developer <span className="gradient-text">Playground</span>
            </h1>
            <p className="text-[var(--text-secondary)] mt-1.5 max-w-2xl text-sm">
              Interact directly with deployed Soroban contracts via local transaction simulations.
              Read contract storage, simulate state checks, and preview output without signing
              on-chain transactions.
            </p>
          </div>
          {isConnected && publicKey && (
            <div className="p-3 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-color)] text-right">
              <span className="block text-xs text-[var(--text-muted)]">Connected Developer</span>
              <span className="font-mono text-xs font-semibold text-[var(--accent-primary-light)]">
                {publicKey.slice(0, 10)}...{publicKey.slice(-8)}
              </span>
            </div>
          )}
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Form Side */}
          <div className="lg:col-span-5 space-y-6">
            <form
              onSubmit={executeSimulation}
              className="p-6 bg-[var(--bg-card)] border border-[var(--border-color)] rounded-xl shadow-lg space-y-5"
            >
              <h2 className="text-lg font-bold border-b border-[var(--border-color)] pb-3">
                Configure Call
              </h2>

              {/* Contract Select */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)] mb-1.5">
                  Select Contract
                </label>
                <select
                  value={selectedContract.name}
                  onChange={(e) => {
                    const c = CONTRACTS_CONFIG.find((x) => x.name === e.target.value);
                    if (c) setSelectedContract(c);
                  }}
                  className="w-full p-2.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] text-sm font-medium outline-none focus:border-[var(--accent-primary)] transition-colors"
                >
                  {CONTRACTS_CONFIG.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Contract Address */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)] mb-1.5">
                  Contract ID
                </label>
                <input
                  type="text"
                  value={contractId}
                  onChange={(e) => setContractId(e.target.value)}
                  placeholder="C..."
                  className="w-full p-2.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] font-mono text-xs outline-none focus:border-[var(--accent-primary)] transition-colors"
                />
              </div>

              {/* Source Account */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)] mb-1.5">
                  Source Account Address (Simulation context)
                </label>
                <input
                  type="text"
                  value={sourceAddress}
                  onChange={(e) => setSourceAddress(e.target.value)}
                  placeholder="G..."
                  className="w-full p-2.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] font-mono text-xs outline-none focus:border-[var(--accent-primary)] transition-colors"
                />
              </div>

              {/* Method Select */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)] mb-1.5">
                  Select Read Method
                </label>
                <select
                  value={selectedMethod.name}
                  onChange={(e) => {
                    const m = selectedContract.methods.find((x) => x.name === e.target.value);
                    if (m) setSelectedMethod(m);
                  }}
                  className="w-full p-2.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] text-sm font-mono outline-none focus:border-[var(--accent-primary)] transition-colors"
                >
                  {selectedContract.methods.map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-[var(--text-muted)] mt-1.5">
                  {selectedMethod.description}
                </p>
              </div>

              {/* Dynamic Arguments */}
              {selectedMethod.args.length > 0 && (
                <div className="space-y-4 pt-3 border-t border-[var(--border-color)]/50">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)]">
                    Method Arguments ({selectedMethod.args.length})
                  </h3>
                  {selectedMethod.args.map((arg) => (
                    <div key={arg.name}>
                      <label className="flex items-center justify-between text-xs font-medium text-[var(--text-secondary)] mb-1">
                        <span>{arg.name}</span>
                        <span className="text-[10px] font-mono bg-[var(--bg-secondary)] px-1.5 py-0.5 rounded text-[var(--text-muted)] border border-[var(--border-color)]">
                          {arg.type}
                        </span>
                      </label>
                      <input
                        type={arg.type === "u32" || arg.type === "i128" ? "number" : "text"}
                        value={argsValues[arg.name] || ""}
                        onChange={(e) => handleArgChange(arg.name, e.target.value)}
                        placeholder={arg.placeholder || `Enter ${arg.type}`}
                        className="w-full p-2.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] font-mono text-xs outline-none focus:border-[var(--accent-primary)] transition-colors"
                      />
                    </div>
                  ))}
                </div>
              )}

              {/* Submit Button */}
              <button
                type="submit"
                disabled={loading}
                className="w-full btn-primary justify-center font-bold text-sm tracking-wide cursor-pointer disabled:opacity-50"
              >
                {loading ? (
                  <span className="flex items-center gap-2">
                    <svg
                      className="animate-spin h-4 w-4 text-white"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      />
                    </svg>
                    Simulating...
                  </span>
                ) : (
                  "Execute Simulation"
                )}
              </button>
            </form>
          </div>

          {/* Terminal / Code Pane */}
          <div className="lg:col-span-7 h-full flex flex-col">
            <div className="flex-1 min-h-[500px] flex flex-col bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-xl overflow-hidden shadow-lg">
              {/* Terminal Header */}
              <div className="px-4 py-3 bg-[var(--bg-primary)] border-b border-[var(--border-color)] flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded-full bg-rose-500/80 inline-block" />
                    <span className="w-3 h-3 rounded-full bg-amber-500/80 inline-block" />
                    <span className="w-3 h-3 rounded-full bg-emerald-500/80 inline-block" />
                  </div>
                  <span className="text-xs font-mono font-semibold text-[var(--text-secondary)] ml-3">
                    WASM Output Terminal
                  </span>
                </div>
                {latency !== null && (
                  <span className="text-[10px] font-mono text-[var(--text-muted)] bg-[var(--bg-primary)] px-2 py-0.5 rounded border border-[var(--border-color)]">
                    Latency: {latency}ms
                  </span>
                )}
              </div>

              {/* Terminal Screen */}
              <div className="flex-1 p-5 font-mono text-xs overflow-auto select-text leading-relaxed bg-[#0a0f1d] text-slate-300">
                {loading && (
                  <div className="flex flex-col items-center justify-center h-full text-[var(--text-muted)] gap-3 animate-pulse">
                    <svg
                      className="animate-spin h-6 w-6 text-[var(--accent-primary-light)]"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      />
                    </svg>
                    <span>Simulating contract call, evaluating WASM bytecode...</span>
                  </div>
                )}

                {!loading && !output && !errorMsg && (
                  <div className="flex flex-col items-center justify-center h-full text-[var(--text-muted)] text-center max-w-sm mx-auto">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      className="w-10 h-10 mb-3 text-[var(--text-muted)] opacity-60"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5"
                      />
                    </svg>
                    <p>
                      Select a contract, supply arguments, and click{" "}
                      <strong>Execute Simulation</strong> to inspect returned WASM outputs.
                    </p>
                  </div>
                )}

                {errorMsg && (
                  <div className="p-4 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-400 space-y-2">
                    <div className="font-semibold text-rose-300">Simulation Error:</div>
                    <pre className="whitespace-pre-wrap text-[11px] leading-relaxed font-mono">
                      {errorMsg}
                    </pre>
                  </div>
                )}

                {output && (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                      <span className="text-emerald-400 font-semibold text-xs flex items-center gap-1.5">
                        <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block animate-ping" />
                        SUCCESS (Simulation Returned)
                      </span>
                      <button
                        onClick={() =>
                          navigator.clipboard.writeText(JSON.stringify(output, null, 2))
                        }
                        className="text-[10px] px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
                      >
                        Copy Output
                      </button>
                    </div>
                    <pre className="text-cyan-400 overflow-x-auto text-[11px] leading-relaxed whitespace-pre font-mono">
                      {JSON.stringify(output, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Glassmorphism Design Tokens Showcase */}
        <section className="mt-16">
          <h2 className="text-lg font-bold mb-1.5">
            Glass <span className="gradient-text">Design Tokens</span>
          </h2>
          <p className="text-[var(--text-secondary)] text-sm mb-6 max-w-2xl">
            Every panel and card below is styled purely with the shared{" "}
            <code className="text-xs font-mono bg-[var(--bg-secondary)] px-1.5 py-0.5 rounded border border-[var(--border-color)]">
              --glass-*
            </code>{" "}
            tokens defined in <code className="text-xs font-mono">globals.css</code>. Changing a
            token updates every consumer at once.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <div className="glass-card p-6">
              <h3 className="text-sm font-bold mb-1">.glass-card</h3>
              <p className="text-xs text-[var(--text-muted)]">
                Default surface for dashboard cards and list items. Hover to see the glow
                transition driven by <code>--glass-card-border-hover</code>.
              </p>
            </div>
            <div className="glass-panel p-6">
              <h3 className="text-sm font-bold mb-1">.glass-panel</h3>
              <p className="text-xs text-[var(--text-muted)]">
                Heavier blur and opacity for standalone panels that need to stand apart from the
                page background.
              </p>
            </div>
            <div className="glass-modal p-6">
              <h3 className="text-sm font-bold mb-1">.glass-modal</h3>
              <p className="text-xs text-[var(--text-muted)]">
                Reserved for modal dialogs — darkest background, strongest blur, and the
                largest shadow token.
              </p>
            </div>
            <div className="relative overflow-hidden rounded-xl h-full min-h-[120px] bg-gradient-to-br from-[var(--color-blue)]/30 to-[var(--color-indigo)]/30 p-6">
              <div className="glass-overlay absolute inset-0" />
              <div className="relative">
                <h3 className="text-sm font-bold mb-1">.glass-overlay</h3>
                <p className="text-xs text-[var(--text-muted)]">
                  Full-bleed scrim used behind modals, shown here over a sample gradient
                  background.
                </p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
