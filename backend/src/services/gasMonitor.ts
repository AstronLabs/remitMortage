import logger from '../utils/logger';
import { loadConfig } from '../config';

interface GasFeeThreshold {
  network: 'stellar' | 'evm' | 'solana';
  maxBaseFee: number; // In smallest unit (stroops, wei, lamports)
  warningThreshold: number; // Percentage of max (e.g., 80 means 80% of max)
}

interface CircuitBreakerState {
  isOpen: boolean;
  network: string;
  openedAt?: Date;
  reason?: string;
  consecutiveSpikes: number;
}

class GasMonitorService {
  private circuitBreakers: Map<string, CircuitBreakerState>;
  private thresholds: GasFeeThreshold[];
  private readonly MAX_CONSECUTIVE_SPIKES = 3;
  private readonly COOLDOWN_MINUTES = 10;

  constructor() {
    this.circuitBreakers = new Map();
    const config = loadConfig();
    this.thresholds = [
      { network: 'stellar', maxBaseFee: config.maxStellarBaseFee || 100000, warningThreshold: 80 },
      { network: 'evm', maxBaseFee: config.maxEvmBaseFee || 100000000000, warningThreshold: 80 },
      { network: 'solana', maxBaseFee: config.maxSolanaBaseFee || 10000, warningThreshold: 80 },
    ];

    // Initialize circuit breakers
    this.thresholds.forEach((threshold) => {
      this.circuitBreakers.set(threshold.network, {
        isOpen: false,
        network: threshold.network,
        consecutiveSpikes: 0,
      });
    });
  }

  /**
   * Check if gas fees are within acceptable limits
   */
  async checkGasFee(network: string, currentFee: number): Promise<boolean> {
    const threshold = this.thresholds.find((t) => t.network === network);
    if (!threshold) {
      logger.warn(`No gas threshold configured for network: ${network}`);
      return true;
    }

    const breaker = this.circuitBreakers.get(network);
    if (!breaker) {
      return true;
    }

    // Check if circuit breaker is in cooldown
    if (breaker.isOpen && breaker.openedAt) {
      const elapsedMinutes = (Date.now() - breaker.openedAt.getTime()) / (1000 * 60);
      if (elapsedMinutes < this.COOLDOWN_MINUTES) {
        logger.warn({
          message: 'Circuit breaker still open',
          network,
          cooldownRemaining: `${Math.ceil(this.COOLDOWN_MINUTES - elapsedMinutes)}m`,
        });
        return false;
      }
    }

    // Check fee against threshold
    if (currentFee > threshold.maxBaseFee) {
      breaker.consecutiveSpikes += 1;
      logger.warn({
        message: 'Gas fee spike detected',
        network,
        currentFee,
        maxBaseFee: threshold.maxBaseFee,
        consecutiveSpikes: breaker.consecutiveSpikes,
      });

      // Open circuit breaker if threshold reached
      if (breaker.consecutiveSpikes >= this.MAX_CONSECUTIVE_SPIKES) {
        this.openCircuitBreaker(network, `Gas fee exceeded ${threshold.maxBaseFee} for ${breaker.consecutiveSpikes} consecutive checks`);
        return false;
      }

      return false; // Block transaction but don't open circuit yet
    }

    // Fee is acceptable - check warning threshold
    const warningFee = (threshold.maxBaseFee * threshold.warningThreshold) / 100;
    if (currentFee > warningFee) {
      logger.info({
        message: 'Gas fee approaching limit',
        network,
        currentFee,
        warningThreshold: warningFee,
        maxBaseFee: threshold.maxBaseFee,
      });
    }

    // Reset consecutive spikes on normal fee
    if (breaker.consecutiveSpikes > 0) {
      breaker.consecutiveSpikes = 0;
      logger.info({
        message: 'Gas fees normalized',
        network,
        currentFee,
      });
    }

    // Close circuit breaker if it was open
    if (breaker.isOpen) {
      this.closeCircuitBreaker(network);
    }

    return true;
  }

  /**
   * Open circuit breaker for a network
   */
  private openCircuitBreaker(network: string, reason: string): void {
    const breaker = this.circuitBreakers.get(network);
    if (breaker) {
      breaker.isOpen = true;
      breaker.openedAt = new Date();
      breaker.reason = reason;

      logger.error({
        message: '🚨 CIRCUIT BREAKER OPENED - Transactions paused',
        network,
        reason,
        cooldownMinutes: this.COOLDOWN_MINUTES,
      });

      // TODO: Send alert to admin (email, Slack, PagerDuty)
    }
  }

  /**
   * Close circuit breaker for a network
   */
  private closeCircuitBreaker(network: string): void {
    const breaker = this.circuitBreakers.get(network);
    if (breaker && breaker.isOpen) {
      breaker.isOpen = false;
      breaker.openedAt = undefined;
      breaker.reason = undefined;
      breaker.consecutiveSpikes = 0;

      logger.info({
        message: '✅ CIRCUIT BREAKER CLOSED - Transactions resumed',
        network,
      });

      // TODO: Send recovery notification to admin
    }
  }

  /**
   * Check if circuit breaker is open for a network
   */
  isCircuitOpen(network: string): boolean {
    const breaker = this.circuitBreakers.get(network);
    return breaker?.isOpen || false;
  }

  /**
   * Get circuit breaker status for all networks
   */
  getCircuitStatus() {
    const status: Record<string, any> = {};
    this.circuitBreakers.forEach((breaker, network) => {
      status[network] = {
        isOpen: breaker.isOpen,
        openedAt: breaker.openedAt,
        reason: breaker.reason,
        consecutiveSpikes: breaker.consecutiveSpikes,
      };
    });
    return status;
  }

  /**
   * Manually reset circuit breaker (admin override)
   */
  resetCircuitBreaker(network: string): void {
    const breaker = this.circuitBreakers.get(network);
    if (breaker) {
      breaker.isOpen = false;
      breaker.openedAt = undefined;
      breaker.reason = undefined;
      breaker.consecutiveSpikes = 0;

      logger.info({
        message: 'Circuit breaker manually reset',
        network,
      });
    }
  }
}

export const gasMonitor = new GasMonitorService();
