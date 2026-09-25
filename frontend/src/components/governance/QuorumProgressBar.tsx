// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";

interface QuorumProgressBarProps {
  currentVotes: number;
  requiredVotes: number;
  quorumThresholdPercent: number;
}

export const QuorumProgressBar: React.FC<QuorumProgressBarProps> = ({
  currentVotes,
  requiredVotes,
  quorumThresholdPercent,
}) => {
  const progressPercent = Math.min((currentVotes / requiredVotes) * 100, 100);
  const isQuorumMet = currentVotes >= requiredVotes;

  return (
    <div className="w-full flex flex-col space-y-2">
      <div className="flex justify-between items-center text-sm">
        <span className="text-zinc-400 font-medium">
          {currentVotes}/{requiredVotes} votes cast
        </span>
        <span
          className={`${isQuorumMet ? "text-emerald-400" : "text-zinc-500"} font-semibold tracking-wide`}
        >
          {isQuorumMet
            ? `${quorumThresholdPercent}% quorum met`
            : `${quorumThresholdPercent}% quorum required`}
        </span>
      </div>
      <div className="w-full bg-zinc-800 rounded-full h-2.5 overflow-hidden border border-zinc-700/50 shadow-inner">
        <div
          className={`h-2.5 rounded-full transition-all duration-500 ease-out ${
            isQuorumMet
              ? "bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]"
              : "bg-cyan-500 shadow-[0_0_10px_rgba(6,182,212,0.5)]"
          }`}
          style={{ width: `${progressPercent}%` }}
        />
      </div>
    </div>
  );
};
