"use client";

import dynamic from "next/dynamic";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { getProductTourStore } from "@/hooks/useProductTourState";

const Navbar = dynamic(() => import("../../components/Navbar"), { ssr: false });
// Push relies on browser-only APIs (ServiceWorker, PushManager, Notification),
// so it must never be evaluated during SSR.
const PushNotificationPanel = dynamic(
  () => import("../../components/PushNotificationPanel"),
  { ssr: false }
);
const ReferralInvitePanel = dynamic(() => import("../../components/ReferralInvitePanel"), {
  ssr: false,
});

type SettingsTab = "profile" | "wallets" | "notifications" | "referrals" | "contractor";

type NotificationKey =
  | "emailAlerts"
  | "smsAlerts"
  | "escrowApproaching"
  | "escrowReached"
  | "paymentMissed"
  | "loanMilestones"
  | "loanApproval";

type FreighterModule = {
  isConnected?: () => boolean | Promise<boolean>;
  requestAccess?: () => void | Promise<void>;
  getPublicKey?: () => string | Promise<string>;
};

const tabs: { id: SettingsTab; label: string }[] = [
  { id: "profile", label: "Profile" },
  { id: "wallets", label: "Wallets" },
  { id: "notifications", label: "Notifications & Alerts" },
  { id: "referrals", label: "Referrals" },
  { id: "contractor", label: "Developer/Contractor" },
];

const notificationDetails: Record<
  NotificationKey,
  { label: string; description: string; category: "channel" | "escrow" | "loan" }
> = {
  emailAlerts: {
    label: "Email Notifications",
    description: "Receive account and protocol updates via email",
    category: "channel",
  },
  smsAlerts: {
    label: "SMS Text Alerts",
    description: "Receive instant mobile SMS alerts for time-critical milestones",
    category: "channel",
  },
  escrowApproaching: {
    label: "Down-Payment Target Approaching (80%+)",
    description: "Alert when escrow savings reach 80% of the target down payment",
    category: "escrow",
  },
  escrowReached: {
    label: "Down-Payment Target Reached (100%)",
    description: "Alert when 30% down payment is fully accumulated and loan unlock is ready",
    category: "escrow",
  },
  paymentMissed: {
    label: "Missed Payment Warning",
    description: "Immediate alert if an escrow contribution or loan repayment installment is missed",
    category: "escrow",
  },
  loanMilestones: {
    label: "Construction Milestone Updates",
    description: "Notification when contractor IPFS proof is uploaded and multisig approves tranche disbursement",
    category: "loan",
  },
  loanApproval: {
    label: "Loan Status & Approval Alerts",
    description: "Alerts when your 70% lending pool loan application is approved or updated",
    category: "loan",
  },
};

const verifiedWallets = [
  {
    chain: "Ethereum",
    address: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
    verifiedAt: "Remittance sender verified",
  },
  {
    chain: "Solana",
    address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWjbQyPB3GzAykSF",
    verifiedAt: "Remittance sender verified",
  },
  {
    chain: "Base",
    address: "0x4f3A9b9251C2d8B490C3C314478E9465a33c8A21",
    verifiedAt: "Remittance sender verified",
  },
];

function shortenAddress(address: string) {
  if (address.length <= 16) return address;
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidWebhookUrl(webhookUrl: string) {
  if (!webhookUrl.trim()) return true;
  try {
    const url = new URL(webhookUrl);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

async function readFreighterPublicKey() {
  const freighter = (await import("@stellar/freighter-api")) as FreighterModule;

  if (typeof freighter.isConnected === "function" && !(await freighter.isConnected())) {
    throw new Error("Freighter is not available or not connected.");
  }

  if (typeof freighter.requestAccess === "function") {
    await freighter.requestAccess();
  }

  if (typeof freighter.getPublicKey === "function") {
    return freighter.getPublicKey();
  }

  throw new Error("Freighter public key API is unavailable.");
}

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("profile");
  const [displayName, setDisplayName] = useState("Ada Remit");
  const [email, setEmail] = useState("ada@example.com");
  const [phone, setPhone] = useState("+1 (555) 234-5678");
  const [stellarAddress, setStellarAddress] = useState("");
  const [notifications, setNotifications] = useState<Record<NotificationKey, boolean>>({
    emailAlerts: true,
    smsAlerts: false,
    escrowApproaching: true,
    escrowReached: true,
    paymentMissed: true,
    loanMilestones: true,
    loanApproval: true,
  });
  const [webhookUrl, setWebhookUrl] = useState("https://partner.example.com/remitmortgage/webhook");
  const [businessName, setBusinessName] = useState("Keystone Build Partners");
  const [registrationNumber, setRegistrationNumber] = useState("NG-RC-204918");
  const [serviceRegion, setServiceRegion] = useState("Lagos, Nigeria");
  const [walletMessage, setWalletMessage] = useState("");
  const [webhookStatus, setWebhookStatus] = useState("");
  const [saveStatus, setSaveStatus] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const emailError = email && !isValidEmail(email) ? "Enter a valid linked email address." : "";
  const webhookError =
    webhookUrl && !isValidWebhookUrl(webhookUrl)
      ? "Webhook URL must start with http:// or https://."
      : "";
  const canSave = isValidEmail(email) && isValidWebhookUrl(webhookUrl);

  const enabledNotificationCount = useMemo(
    () => Object.values(notifications).filter(Boolean).length,
    [notifications]
  );

  useEffect(() => {
    async function loadSettings() {
      try {
        const targetId = stellarAddress || email || "default_user";
        const res = await fetch(`/api/user/settings?userId=${encodeURIComponent(targetId)}`);
        if (res.ok) {
          const data = await res.json();
          if (data.settings) {
            if (data.settings.profile) {
              if (data.settings.profile.displayName) setDisplayName(data.settings.profile.displayName);
              if (data.settings.profile.email) setEmail(data.settings.profile.email);
              if (data.settings.profile.phone) setPhone(data.settings.profile.phone);
            }
            if (data.settings.notifications) {
              setNotifications((prev) => ({
                ...prev,
                ...data.settings.notifications,
              }));
              if (data.settings.notifications.webhookUrl !== undefined) {
                setWebhookUrl(data.settings.notifications.webhookUrl);
              }
            }
            if (data.settings.contractor) {
              if (data.settings.contractor.businessName) setBusinessName(data.settings.contractor.businessName);
              if (data.settings.contractor.registrationNumber)
                setRegistrationNumber(data.settings.contractor.registrationNumber);
              if (data.settings.contractor.serviceRegion) setServiceRegion(data.settings.contractor.serviceRegion);
            }
          }
        }
      } catch {
        // Fall back to default state
      }
    }
    loadSettings();
  }, [stellarAddress]);

  async function connectStellarWallet() {
    setWalletMessage("Connecting to Freighter...");

    try {
      const publicKey = await readFreighterPublicKey();
      setStellarAddress(publicKey);
      setWalletMessage("Stellar wallet connected.");
    } catch (error) {
      setWalletMessage(error instanceof Error ? error.message : "Unable to connect Freighter.");
    }
  }

  async function checkWebhookAccessibility() {
    if (!webhookUrl.trim()) {
      setWebhookStatus("Webhook URL is optional.");
      return;
    }

    if (!isValidWebhookUrl(webhookUrl)) {
      setWebhookStatus("Webhook URL format is invalid.");
      return;
    }

    setWebhookStatus("Checking webhook endpoint...");

    try {
      await fetch(webhookUrl, { method: "HEAD", mode: "no-cors" });
      setWebhookStatus("Webhook URL format is valid and endpoint accepted reachability check.");
    } catch {
      setWebhookStatus(
        "Webhook URL format is valid, but the endpoint could not be reached from this browser."
      );
    }
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaveStatus("");

    if (!canSave) {
      setSaveStatus("Fix the highlighted fields before saving.");
      return;
    }

    setIsSaving(true);

    try {
      const userId = stellarAddress || email;

      // Save user profile & notification settings
      const response = await fetch("/api/user/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          profile: { displayName, email, phone },
          notifications: { ...notifications, webhookUrl },
          contractor: { businessName, registrationNumber, serviceRegion },
        }),
      });

      // Also persist to backend notification preferences API
      await fetch("/api/notifications/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: userId,
          email,
          phone,
          emailAlerts: notifications.emailAlerts,
          smsAlerts: notifications.smsAlerts,
          escrowApproaching: notifications.escrowApproaching,
          escrowReached: notifications.escrowReached,
          paymentMissed: notifications.paymentMissed,
          loanMilestones: notifications.loanMilestones,
          webhookUrl,
        }),
      }).catch(() => null);

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Settings could not be saved.");
      }

      setSaveStatus("Notification settings and profile saved successfully.");
    } catch (error) {
      setSaveStatus(error instanceof Error ? error.message : "Settings could not be saved.");
    } finally {
      setIsSaving(false);
    }
  }

  function toggleNotification(key: NotificationKey) {
    setNotifications((current) => ({ ...current, [key]: !current[key] }));
  }

  return (
    <main className="rm-app-page min-h-screen bg-[#060913] text-slate-100">
      <Navbar />

      <section className="pt-28 pb-16 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="mb-8">
            <p className="text-xs font-bold uppercase tracking-wider text-cyan-400">Account control center</p>
            <h1 className="text-3xl md:text-5xl font-extrabold text-white mt-1">User Settings</h1>
            <p className="text-slate-400 mt-2 max-w-2xl text-sm">
              Manage profile details, SMS/Email notification preferences for escrow maturity, and contractor status.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-6">
            <aside className="bg-slate-900/80 border border-slate-800 rounded-2xl p-3 h-fit backdrop-blur-xl">
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-1 gap-2" role="tablist" aria-label="Settings tabs">
                {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`text-left px-4 py-3 rounded-xl text-sm font-semibold transition-all ${
                      activeTab === tab.id
                        ? "bg-gradient-to-r from-cyan-500 to-blue-600 text-white shadow-lg shadow-cyan-500/20"
                        : "text-slate-400 hover:bg-slate-800 hover:text-white"
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </aside>

            <form onSubmit={saveSettings} className="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 md:p-8 backdrop-blur-xl shadow-2xl">
              {activeTab === "profile" && (
                <section role="tabpanel" aria-label="Profile settings" className="space-y-6">
                  <div>
                    <h2 className="text-2xl font-bold text-white">Borrower Profile</h2>
                    <p className="text-slate-400 text-sm mt-1">Keep your contact channels updated for SMS and email alerts.</p>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                    <label className="space-y-2">
                      <span className="text-xs font-semibold text-slate-300">Display Name</span>
                      <input
                        value={displayName}
                        onChange={(event) => setDisplayName(event.target.value)}
                        className="w-full p-3.5 rounded-xl border border-slate-700 bg-slate-950/70 text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                      />
                    </label>

                    <label className="space-y-2">
                      <span className="text-xs font-semibold text-slate-300">Linked Email Address (Email Alerts)</span>
                      <input
                        type="email"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        className="w-full p-3.5 rounded-xl border border-slate-700 bg-slate-950/70 text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                      />
                      {emailError && <span className="text-xs text-red-400">{emailError}</span>}
                    </label>

                    <label className="space-y-2 md:col-span-2">
                      <span className="text-xs font-semibold text-slate-300">Mobile Phone Number (SMS Alerts)</span>
                      <input
                        type="tel"
                        value={phone}
                        onChange={(event) => setPhone(event.target.value)}
                        placeholder="+1 (555) 000-0000"
                        className="w-full p-3.5 rounded-xl border border-slate-700 bg-slate-950/70 text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 font-mono text-sm"
                      />
                      <span className="text-xs text-slate-400 block">
                        Used for urgent SMS notifications (e.g. escrow target reached, missed payment warnings).
                      </span>
                    </label>
                  </div>
                  <div className="mt-6 rounded-xl border border-slate-800 bg-slate-950/60 p-5">
                    <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                      <div>
                        <h3 className="text-sm font-semibold text-white">Guided Product Tour</h3>
                        <p className="text-xs text-slate-400 mt-1">
                          Re-run the first-time walkthrough of the dashboard features.
                        </p>
                      </div>
                      <button
                        onClick={() => getProductTourStore().getState().reset()}
                        className="btn-outline-blue whitespace-nowrap"
                      >
                        Replay Tour
                      </button>
                    </div>
                  </div>
                </section>
              )}

              {activeTab === "wallets" && (
                <section role="tabpanel" aria-label="Wallet settings" className="space-y-6">
                  <div>
                    <h2 className="text-2xl font-bold text-white">Stellar & Remittance Wallets</h2>
                    <p className="text-slate-400 text-sm mt-1">
                      View your connected Freighter address and verified remittance sending wallets.
                    </p>
                  </div>

                  <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-5">
                    <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                      <div>
                        <p className="text-xs text-slate-400 font-semibold uppercase">Connected Stellar Address</p>
                        <p className="font-mono text-sm break-all mt-1 text-cyan-300">
                          {stellarAddress || "No Stellar wallet connected"}
                        </p>
                      </div>
                      <button type="button" onClick={connectStellarWallet} className="btn-primary !py-2.5 !px-5 text-xs">
                        Connect Freighter
                      </button>
                    </div>
                    {walletMessage && <p className="text-xs text-slate-400 mt-3">{walletMessage}</p>}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {verifiedWallets.map((wallet) => (
                      <article key={`${wallet.chain}-${wallet.address}`} className="rounded-xl border border-slate-800 bg-slate-950/60 p-5">
                        <span className="inline-flex rounded-full bg-cyan-500/10 px-3 py-1 text-xs font-bold text-cyan-400 border border-cyan-500/20">
                          {wallet.chain}
                        </span>
                        <p className="font-mono text-xs break-all mt-3 text-slate-200" title={wallet.address}>
                          {shortenAddress(wallet.address)}
                        </p>
                        <p className="text-xs text-emerald-400 mt-2 font-medium">✓ {wallet.verifiedAt}</p>
                      </article>
                    ))}
                  </div>
                </section>
              )}

              {activeTab === "notifications" && (
                <section role="tabpanel" aria-label="Notification settings" className="space-y-8">
                  <div>
                    <h2 className="text-2xl font-bold text-white">Dynamic Notification Preferences</h2>
                    <p className="text-slate-400 text-sm mt-1">
                      Configure SMS and email alerts for escrow maturity goals, missed payments, and milestone disbursements.
                    </p>
                  </div>

                  {/* Channel Preferences */}
                  <div className="space-y-3">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-cyan-400">1. Delivery Channels</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {(["emailAlerts", "smsAlerts"] as NotificationKey[]).map((key) => {
                        const item = notificationDetails[key];
                        const enabled = notifications[key];
                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => toggleNotification(key)}
                            aria-pressed={enabled}
                            className={`rounded-xl border p-5 text-left transition-all ${
                              enabled
                                ? "border-cyan-500 bg-cyan-500/10 text-white shadow-lg shadow-cyan-500/10"
                                : "border-slate-800 bg-slate-950/40 text-slate-400 hover:border-slate-700"
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <span className="text-sm font-bold text-white">{item.label}</span>
                              <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold ${enabled ? "bg-cyan-500 text-slate-950" : "bg-slate-800 text-slate-400"}`}>
                                {enabled ? "ACTIVE" : "OFF"}
                              </span>
                            </div>
                            <p className="text-xs mt-2 text-slate-400 leading-relaxed">{item.description}</p>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Escrow Maturity Milestones */}
                  <div className="space-y-3">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-cyan-400">2. Escrow & Down-Payment Milestone Alerts</h3>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      {(["escrowApproaching", "escrowReached", "paymentMissed"] as NotificationKey[]).map((key) => {
                        const item = notificationDetails[key];
                        const enabled = notifications[key];
                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => toggleNotification(key)}
                            aria-pressed={enabled}
                            className={`rounded-xl border p-5 text-left transition-all flex flex-col justify-between ${
                              enabled
                                ? "border-emerald-500/50 bg-emerald-500/10 text-white"
                                : "border-slate-800 bg-slate-950/40 text-slate-400 hover:border-slate-700"
                            }`}
                          >
                            <div>
                              <div className="flex items-center justify-between mb-2">
                                <span className="text-xs font-semibold text-slate-400">Escrow Alert</span>
                                <span className={`w-3 h-3 rounded-full ${enabled ? "bg-emerald-400 shadow-sm shadow-emerald-400" : "bg-slate-700"}`} />
                              </div>
                              <span className="text-sm font-bold text-white leading-tight block">{item.label}</span>
                              <p className="text-xs text-slate-400 mt-2 leading-relaxed">{item.description}</p>
                            </div>
                            <span className="text-[11px] font-semibold mt-4 text-emerald-300">
                              {enabled ? "✓ Alert Enabled" : "Disabled"}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Loan & Construction Milestones */}
                  <div className="space-y-3">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-cyan-400">3. Construction & Loan Disbursement Alerts</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {(["loanMilestones", "loanApproval"] as NotificationKey[]).map((key) => {
                        const item = notificationDetails[key];
                        const enabled = notifications[key];
                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => toggleNotification(key)}
                            aria-pressed={enabled}
                            className={`rounded-xl border p-5 text-left transition-all ${
                              enabled
                                ? "border-indigo-500/50 bg-indigo-500/10 text-white"
                                : "border-slate-800 bg-slate-950/40 text-slate-400 hover:border-slate-700"
                            }`}
                          >
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-sm font-bold text-white">{item.label}</span>
                              <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold ${enabled ? "bg-indigo-500 text-white" : "bg-slate-800 text-slate-400"}`}>
                                {enabled ? "ENABLED" : "DISABLED"}
                              </span>
                            </div>
                            <p className="text-xs text-slate-400 mt-2 leading-relaxed">{item.description}</p>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Browser Push */}
                  <div className="space-y-3 pt-2 border-t border-slate-800">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-cyan-400">
                      4. Browser Push Notifications
                    </h3>
                    <PushNotificationPanel address={stellarAddress || email || "default_user"} />
                  </div>

                  {/* Partner Webhook Endpoint */}
                  <label className="block space-y-2 pt-2 border-t border-slate-800">
                    <span className="text-xs font-bold uppercase tracking-wider text-cyan-400">5. Partner Webhook Integration</span>
                    <p className="text-xs text-slate-400">Receive automated JSON webhooks when escrow maturity milestones occur.</p>
                    <div className="flex flex-col sm:flex-row gap-3 pt-2">
                      <input
                        value={webhookUrl}
                        onChange={(event) => {
                          setWebhookUrl(event.target.value);
                          setWebhookStatus("");
                        }}
                        placeholder="https://partner.example.com/webhook"
                        className="w-full p-3.5 rounded-xl border border-slate-700 bg-slate-950/70 text-white placeholder-slate-500 font-mono text-xs focus:outline-none focus:border-cyan-500"
                      />
                      <button type="button" onClick={checkWebhookAccessibility} className="btn-outline-blue text-xs !py-3 !px-5 whitespace-nowrap">
                        Test Webhook
                      </button>
                    </div>
                    {webhookError && <span className="text-xs text-red-400 block">{webhookError}</span>}
                    {webhookStatus && <span className="text-xs text-cyan-300 block">{webhookStatus}</span>}
                  </label>

                  <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 flex items-center justify-between text-xs text-slate-400">
                    <span>Active Notification Rules:</span>
                    <span className="font-bold text-white">{enabledNotificationCount} of 7 enabled</span>
                  </div>
                </section>
              )}

              {activeTab === "referrals" && (
                <section role="tabpanel" aria-label="Referral settings" className="space-y-6">
                  <ReferralInvitePanel ownerAddress={stellarAddress} />
                </section>
              )}

              {activeTab === "contractor" && (
                <section
                  role="tabpanel"
                  aria-label="Developer and contractor settings"
                  className="space-y-6"
                >
                  <div>
                    <h2 className="text-2xl font-bold text-white">Developer / Contractor Credentials</h2>
                    <p className="text-slate-400 text-sm mt-1">
                      Review whitelist status and registered credentials for construction disbursements.
                    </p>
                  </div>

                  <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-5">
                    <p className="text-xs font-semibold text-emerald-300 uppercase">Multisig Whitelist Status</p>
                    <p className="text-lg font-bold text-white mt-1">✓ Whitelisted Approved Contractor</p>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                    <label className="space-y-2">
                      <span className="text-xs font-semibold text-slate-300">Registered Business Name</span>
                      <input
                        value={businessName}
                        onChange={(event) => setBusinessName(event.target.value)}
                        className="w-full p-3.5 rounded-xl border border-slate-700 bg-slate-950/70 text-white focus:outline-none focus:border-cyan-500"
                      />
                    </label>
                    <label className="space-y-2">
                      <span className="text-xs font-semibold text-slate-300">Registration Number</span>
                      <input
                        value={registrationNumber}
                        onChange={(event) => setRegistrationNumber(event.target.value)}
                        className="w-full p-3.5 rounded-xl border border-slate-700 bg-slate-950/70 text-white focus:outline-none focus:border-cyan-500"
                      />
                    </label>
                    <label className="space-y-2">
                      <span className="text-xs font-semibold text-slate-300">Service Region</span>
                      <input
                        value={serviceRegion}
                        onChange={(event) => setServiceRegion(event.target.value)}
                        className="w-full p-3.5 rounded-xl border border-slate-700 bg-slate-950/70 text-white focus:outline-none focus:border-cyan-500"
                      />
                    </label>
                  </div>
                </section>
              )}

              <div className="mt-8 flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-t border-slate-800 pt-6">
                <p className="text-xs font-medium text-slate-400">
                  {saveStatus || "Preferences persist in backend PostgreSQL database configurations."}
                </p>
                <button type="submit" disabled={!canSave || isSaving} className="btn-cta disabled:opacity-60 disabled:cursor-not-allowed">
                  {isSaving ? "Saving Settings..." : "Save Preferences"}
                </button>
              </div>
            </form>
          </div>
        </div>
      </section>
    </main>
  );
}
