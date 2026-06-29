"use client";

import React, { useState } from 'react';
import { X, Wallet, CheckCircle2, AlertCircle, Loader2, Link } from 'lucide-react';
import { useWallet } from '../context/WalletContext';

interface MultiWalletModalProps {
  isOpen: boolean;
  onClose: () => void;
  onVerificationComplete: (address: string, chainType: string, signature: string) => void;
}

export const MultiWalletModal: React.FC<MultiWalletModalProps> = ({ isOpen, onClose, onVerificationComplete }) => {
  const wallet = useWallet();
  const [isSigning, setIsSigning] = useState(false);
  const [signStatus, setSignStatus] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleConnectAndSign = async (type: 'evm' | 'solana') => {
    let address: string | null = null;
    if (type === 'evm') {
      address = await wallet.connectEVM();
    } else {
      address = await wallet.connectSolana();
    }

    if (!address) return;

    await executeSignFlow(address, type);
  };

  const executeSignFlow = async (address: string, chainType: string) => {
    setIsSigning(true);
    setSignStatus('Fetching challenge from server...');

    try {
      const challengeRes = await fetch('/api/verification/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, chainType })
      });

      const { message } = await challengeRes.json();

      if (!message) throw new Error('Invalid challenge received from server');

      setSignStatus('Please sign the message in your wallet...');

      const signature = await wallet.signMessage(message);

      if (!signature) throw new Error('Signature was rejected or failed');

      setSignStatus('Verifying signature on server...');

      const verifyRes = await fetch('/api/verification/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, chainType, signature })
      });

      if (!verifyRes.ok) throw new Error('Verification failed on the server');

      setSignStatus('Verification successful!');
      onVerificationComplete(address, chainType, signature);
    } catch (err: unknown) {
      console.error(err);
      setSignStatus(null);
    } finally {
      setIsSigning(false);
    }
  };

  const handleDisconnect = () => {
    wallet.disconnectAll();
    setIsSigning(false);
    setSignStatus(null);
  };

  const connectedAddress = wallet.walletType === 'evm' ? wallet.evmAddress : wallet.walletType === 'solana' ? wallet.solanaAddress : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm transition-opacity">
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />

      <div className="relative w-full max-w-md bg-zinc-950 border border-zinc-800 shadow-2xl rounded-2xl overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-zinc-800/80 bg-zinc-900/50">
          <div className="flex items-center space-x-3">
            <div className="p-2 bg-indigo-500/10 rounded-lg">
              <Wallet className="w-5 h-5 text-indigo-400" />
            </div>
            <h2 className="text-lg font-bold text-zinc-100 tracking-tight">Connect Remittance Wallet</h2>
          </div>
          <button onClick={onClose} className="p-2 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors focus:outline-none">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6">
          <p className="text-zinc-400 text-sm mb-6 leading-relaxed">
            Please connect the wallet you previously used for sending remittances (Ethereum or Solana) to securely sign a proof-of-ownership message.
          </p>

          {wallet.error && (
            <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start text-red-400 shadow-inner">
              <AlertCircle className="w-5 h-5 mr-3 shrink-0 mt-0.5" />
              <span className="text-sm font-medium">{wallet.error}</span>
            </div>
          )}

          {!wallet.isConnected ? (
            <div className="space-y-3">
              <button
                onClick={() => handleConnectAndSign('evm')}
                disabled={wallet.isConnecting}
                className="w-full flex items-center justify-between p-4 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-indigo-500/50 rounded-xl transition-all group disabled:opacity-50"
              >
                <div className="flex items-center">
                  <div className="w-10 h-10 rounded-full bg-orange-500/10 flex items-center justify-center mr-4 group-hover:scale-110 transition-transform">
                    <div className="w-5 h-5 rounded-full bg-orange-500 border-2 border-orange-400 shadow-[0_0_10px_rgba(249,115,22,0.5)]" />
                  </div>
                  <div className="text-left">
                    <span className="block font-bold text-zinc-100">Ethereum (EVM)</span>
                    <span className="block text-xs text-zinc-500 font-medium">MetaMask, Trust Wallet</span>
                  </div>
                </div>
                {wallet.isConnecting && wallet.walletType === 'evm' ? <Loader2 className="w-5 h-5 text-indigo-400 animate-spin" /> : <Link className="w-5 h-5 text-zinc-600 group-hover:text-indigo-400 transition-colors" />}
              </button>

              <button
                onClick={() => handleConnectAndSign('solana')}
                disabled={wallet.isConnecting}
                className="w-full flex items-center justify-between p-4 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-purple-500/50 rounded-xl transition-all group disabled:opacity-50"
              >
                <div className="flex items-center">
                  <div className="w-10 h-10 rounded-full bg-purple-500/10 flex items-center justify-center mr-4 group-hover:scale-110 transition-transform">
                    <div className="w-5 h-5 rounded-full bg-purple-500 border-2 border-purple-400 shadow-[0_0_10px_rgba(168,85,247,0.5)]" />
                  </div>
                  <div className="text-left">
                    <span className="block font-bold text-zinc-100">Solana</span>
                    <span className="block text-xs text-zinc-500 font-medium">Phantom</span>
                  </div>
                </div>
                {wallet.isConnecting && wallet.walletType === 'solana' ? <Loader2 className="w-5 h-5 text-purple-400 animate-spin" /> : <Link className="w-5 h-5 text-zinc-600 group-hover:text-purple-400 transition-colors" />}
              </button>
            </div>
          ) : (
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 relative overflow-hidden shadow-inner">
              <div className="absolute top-0 left-0 w-full h-1 bg-emerald-500" />

              <div className="flex justify-between items-start mb-6">
                <div>
                  <div className="flex items-center space-x-2 mb-1.5">
                    <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                    <span className="text-xs font-bold text-emerald-500 uppercase tracking-wider">{wallet.walletType === 'evm' ? 'Ethereum' : 'Solana'} Connected</span>
                  </div>
                  <p className="text-zinc-300 font-mono text-sm truncate max-w-[200px]" title={connectedAddress || ''}>
                    {connectedAddress}
                  </p>
                </div>
                <button
                  onClick={handleDisconnect}
                  className="text-xs font-medium text-zinc-500 hover:text-red-400 transition-colors underline underline-offset-2"
                >
                  Disconnect
                </button>
              </div>

              {isSigning ? (
                <div className="flex items-center justify-center p-4 bg-zinc-950 rounded-lg border border-zinc-800/80 shadow-inner">
                  <Loader2 className="w-5 h-5 text-indigo-400 animate-spin mr-3" />
                  <span className="text-sm text-zinc-300 font-medium tracking-wide">{signStatus}</span>
                </div>
              ) : signStatus === 'Verification successful!' ? (
                <div className="flex items-center justify-center p-4 bg-emerald-500/10 rounded-lg border border-emerald-500/20 shadow-inner">
                  <CheckCircle2 className="w-5 h-5 text-emerald-400 mr-3" />
                  <span className="text-sm text-emerald-400 font-semibold tracking-wide">Identity successfully verified</span>
                </div>
              ) : (
                <button
                  onClick={() => executeSignFlow(connectedAddress!, wallet.walletType!)}
                  className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl transition-all shadow-lg shadow-indigo-900/20 border border-indigo-500 hover:scale-[1.02]"
                >
                  Retry Signature
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
