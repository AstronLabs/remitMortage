// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useState, useEffect } from "react";
import { TransactionBuilder, Networks } from "@stellar/stellar-sdk";

export type GasEstimate = {
  standardFeeXlm: string;
  standardFeeUsd: string;
  highFeeXlm: string;
  highFeeUsd: string;
};

/**
 * Custom hook to extract and calculate standard/high fees in XLM and USD
 * from a simulated Soroban transaction XDR.
 */
export function useGasEstimate(txXdr: string | null, xlmPriceUsd: number | null) {
  const [estimate, setEstimate] = useState<GasEstimate | null>(null);

  useEffect(() => {
    if (!txXdr || !xlmPriceUsd) {
      setEstimate(null);
      return;
    }

    try {
      const networkPassphrase = process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET;
      const tx = TransactionBuilder.fromXDR(txXdr, networkPassphrase);
      
      // The simulated/assembled fee is preserved in the XDR in stroops
      const feeStroops = parseInt(tx.fee, 10);
      
      const standardFeeXlmNum = feeStroops / 10_000_000;
      // Assume high congestion requires 3x the standard fee
      const highFeeXlmNum = (feeStroops * 3) / 10_000_000;
      
      setEstimate({
        standardFeeXlm: standardFeeXlmNum.toFixed(7),
        standardFeeUsd: (standardFeeXlmNum * xlmPriceUsd).toFixed(4),
        highFeeXlm: highFeeXlmNum.toFixed(7),
        highFeeUsd: (highFeeXlmNum * xlmPriceUsd).toFixed(4),
      });
    } catch (e) {
      console.error("Failed to estimate gas from XDR:", e);
      setEstimate(null);
    }
  }, [txXdr, xlmPriceUsd]);

  return estimate;
}
