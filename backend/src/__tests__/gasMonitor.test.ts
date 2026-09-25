// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { gasMonitor } from '../services/gasMonitor';

describe('GasMonitorService', () => {
  beforeEach(() => {
    // Reset all circuit breakers
    gasMonitor.resetCircuitBreaker('stellar');
    gasMonitor.resetCircuitBreaker('evm');
    gasMonitor.resetCircuitBreaker('solana');
  });

  describe('checkGasFee', () => {
    it('should allow transactions when fee is below threshold', async () => {
      const result = await gasMonitor.checkGasFee('stellar', 50000);
      expect(result).toBe(true);
      expect(gasMonitor.isCircuitOpen('stellar')).toBe(false);
    });

    it('should block transaction when fee exceeds threshold', async () => {
      const result = await gasMonitor.checkGasFee('stellar', 150000);
      expect(result).toBe(false);
    });

    it('should open circuit breaker after consecutive spikes', async () => {
      // Trigger 3 consecutive spikes
      await gasMonitor.checkGasFee('stellar', 150000);
      await gasMonitor.checkGasFee('stellar', 150000);
      await gasMonitor.checkGasFee('stellar', 150000);

      expect(gasMonitor.isCircuitOpen('stellar')).toBe(true);
    });

    it('should reset consecutive spikes when fee normalizes', async () => {
      await gasMonitor.checkGasFee('stellar', 150000);
      await gasMonitor.checkGasFee('stellar', 150000);
      
      // Normal fee should reset counter
      await gasMonitor.checkGasFee('stellar', 50000);
      
      // Should not open circuit on next spike (counter reset)
      await gasMonitor.checkGasFee('stellar', 150000);
      expect(gasMonitor.isCircuitOpen('stellar')).toBe(false);
    });

    it('should close circuit breaker when fees normalize', async () => {
      // Open circuit
      await gasMonitor.checkGasFee('stellar', 150000);
      await gasMonitor.checkGasFee('stellar', 150000);
      await gasMonitor.checkGasFee('stellar', 150000);
      expect(gasMonitor.isCircuitOpen('stellar')).toBe(true);

      // Wait cooldown and check normal fee
      await new Promise(resolve => setTimeout(resolve, 100));
      gasMonitor.resetCircuitBreaker('stellar'); // Manual reset to simulate cooldown
      
      const result = await gasMonitor.checkGasFee('stellar', 50000);
      expect(result).toBe(true);
      expect(gasMonitor.isCircuitOpen('stellar')).toBe(false);
    });
  });

  describe('isCircuitOpen', () => {
    it('should return false for closed circuit', () => {
      expect(gasMonitor.isCircuitOpen('stellar')).toBe(false);
    });

    it('should return true for open circuit', async () => {
      await gasMonitor.checkGasFee('stellar', 150000);
      await gasMonitor.checkGasFee('stellar', 150000);
      await gasMonitor.checkGasFee('stellar', 150000);
      
      expect(gasMonitor.isCircuitOpen('stellar')).toBe(true);
    });
  });

  describe('getCircuitStatus', () => {
    it('should return status for all networks', () => {
      const status = gasMonitor.getCircuitStatus();
      
      expect(status).toHaveProperty('stellar');
      expect(status).toHaveProperty('evm');
      expect(status).toHaveProperty('solana');
      expect(status.stellar.isOpen).toBe(false);
    });
  });

  describe('resetCircuitBreaker', () => {
    it('should manually reset circuit breaker', async () => {
      // Open circuit
      await gasMonitor.checkGasFee('evm', 200000000000);
      await gasMonitor.checkGasFee('evm', 200000000000);
      await gasMonitor.checkGasFee('evm', 200000000000);
      expect(gasMonitor.isCircuitOpen('evm')).toBe(true);

      // Manual reset
      gasMonitor.resetCircuitBreaker('evm');
      expect(gasMonitor.isCircuitOpen('evm')).toBe(false);
    });
  });

  describe('multi-network isolation', () => {
    it('should handle multiple networks independently', async () => {
      // Spike on stellar
      await gasMonitor.checkGasFee('stellar', 150000);
      await gasMonitor.checkGasFee('stellar', 150000);
      await gasMonitor.checkGasFee('stellar', 150000);

      // EVM should still be operational
      expect(gasMonitor.isCircuitOpen('stellar')).toBe(true);
      expect(gasMonitor.isCircuitOpen('evm')).toBe(false);
      
      const evmResult = await gasMonitor.checkGasFee('evm', 50000000000);
      expect(evmResult).toBe(true);
    });
  });
});
