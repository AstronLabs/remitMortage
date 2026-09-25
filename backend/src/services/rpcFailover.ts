// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { rpc } from "@stellar/stellar-sdk";
import logger from "../utils/logger.js";

/**
 * RPC Gateway Manager with automatic round-robin load balancing and failover.
 * Distributes requests across multiple Soroban RPC nodes and automatically
 * switches providers when a node becomes unreachable.
 */
export class RpcFailoverManager {
  private servers: rpc.Server[];
  private urls: string[];
  private currentIndex: number = 0;
  private failedAttempts: Map<number, number> = new Map();
  private readonly maxFailures = 3;
  private readonly failureResetMs = 60000; // Reset failure count after 1 minute

  constructor(urls: string[]) {
    if (!urls || urls.length === 0) {
      throw new Error("At least one RPC URL must be provided");
    }

    this.urls = urls;
    this.servers = urls.map(
      (url) =>
        new rpc.Server(url, {
          allowHttp: url.startsWith("http://"),
        })
    );

    logger.info(`Initialized RPC failover with ${urls.length} nodes`, {
      urls,
    });
  }

  /**
   * Executes an RPC operation with automatic failover. Tries the current
   * server first, then round-robins through other healthy servers if needed.
   */
  async execute<T>(
    operation: (server: rpc.Server) => Promise<T>,
    context: string = "RPC operation"
  ): Promise<T> {
    const startTime = Date.now();
    let lastError: Error | null = null;
    const attemptedIndices: number[] = [];

    // Try all servers in round-robin order
    for (let i = 0; i < this.servers.length; i++) {
      const serverIndex = (this.currentIndex + i) % this.servers.length;

      // Skip servers that have failed too many times recently
      if (this.isServerUnhealthy(serverIndex)) {
        logger.warn(`Skipping unhealthy RPC node ${serverIndex}`, {
          url: this.urls[serverIndex],
          failures: this.failedAttempts.get(serverIndex),
        });
        continue;
      }

      attemptedIndices.push(serverIndex);
      const server = this.servers[serverIndex];
      const url = this.urls[serverIndex];

      try {
        logger.debug(`Attempting ${context} on RPC node ${serverIndex}`, {
          url,
        });

        const result = await this.executeWithTimeout(
          () => operation(server),
          3000 // 3 second timeout per node
        );

        const duration = Date.now() - startTime;

        // Success - reset failure count and update current index
        this.resetFailureCount(serverIndex);
        this.currentIndex = (serverIndex + 1) % this.servers.length;

        logger.info(`${context} succeeded`, {
          url,
          serverIndex,
          durationMs: duration,
        });

        return result;
      } catch (error) {
        lastError = error as Error;
        this.recordFailure(serverIndex);

        logger.warn(`${context} failed on RPC node ${serverIndex}`, {
          url,
          error: lastError.message,
          failureCount: this.failedAttempts.get(serverIndex),
        });
      }
    }

    // All servers failed
    const totalDuration = Date.now() - startTime;
    logger.error(`${context} failed on all RPC nodes`, {
      attemptedNodes: attemptedIndices,
      totalDurationMs: totalDuration,
      lastError: lastError?.message,
    });

    throw new Error(
      `${context} failed on all ${attemptedIndices.length} available RPC nodes. Last error: ${lastError?.message}`
    );
  }

  /**
   * Wraps an async operation with a timeout
   */
  private async executeWithTimeout<T>(
    operation: () => Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    return Promise.race([
      operation(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Operation timed out after ${timeoutMs}ms`)),
          timeoutMs
        )
      ),
    ]);
  }

  /**
   * Records a failure for a specific server and schedules failure count reset
   */
  private recordFailure(serverIndex: number): void {
    const currentFailures = this.failedAttempts.get(serverIndex) || 0;
    this.failedAttempts.set(serverIndex, currentFailures + 1);

    // Schedule failure count reset
    setTimeout(() => {
      this.resetFailureCount(serverIndex);
    }, this.failureResetMs);
  }

  /**
   * Resets the failure count for a server
   */
  private resetFailureCount(serverIndex: number): void {
    this.failedAttempts.delete(serverIndex);
  }

  /**
   * Checks if a server is considered unhealthy (too many recent failures)
   */
  private isServerUnhealthy(serverIndex: number): boolean {
    const failures = this.failedAttempts.get(serverIndex) || 0;
    return failures >= this.maxFailures;
  }

  /**
   * Gets the current active server (for direct access if needed)
   */
  getCurrentServer(): rpc.Server {
    return this.servers[this.currentIndex];
  }

  /**
   * Gets health status of all RPC nodes
   */
  getHealthStatus(): Array<{ url: string; healthy: boolean; failures: number }> {
    return this.urls.map((url, index) => ({
      url,
      healthy: !this.isServerUnhealthy(index),
      failures: this.failedAttempts.get(index) || 0,
    }));
  }
}
