// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Rate Limit Evasion Audit Job
 *
 * This job analyzes recent request logs for patterns consistent with rate-limit evasion.
 * 
 * Detection Heuristics:
 * 1. Narrow IP Range Evasion: Multiple accounts authenticating or interacting from 
 *    a narrow IP range (e.g., /24 subnet) in a short window.
 * 2. Threshold Hugging: Accounts that consistently hit the API just under the 
 *    per-account or global threshold (e.g., 295 requests on a 300 request limit).
 * 
 * Instead of auto-blocking (which can cause false positives for NATs/corporate networks),
 * this job flags the detected patterns for manual security review.
 * 
 * Note: In a production environment, this would query Elasticsearch, Datadog, or 
 * CloudWatch logs. This implementation acts as the structural foundation.
 */

import logger from "../utils/logger.js";

// Mock log provider interface
interface RequestLog {
  ip: string;
  accountId: string | null;
  endpoint: string;
  timestamp: string;
  count: number;
}

async function fetchRecentRequestLogs(): Promise<RequestLog[]> {
  // In production, this would be an API call to the log provider
  // Returning mock simulated data for the sake of the job structure
  return [
    {
      ip: "192.168.1.100",
      accountId: "acc_1",
      endpoint: "/api/borrower/status",
      timestamp: new Date().toISOString(),
      count: 295,
    },
    {
      ip: "192.168.1.101",
      accountId: "acc_2",
      endpoint: "/api/borrower/status",
      timestamp: new Date().toISOString(),
      count: 298,
    }
  ];
}

export async function runRateLimitAuditJob() {
  try {
    logger.info("[RateLimitAudit] Starting rate limit evasion audit scan...");
    
    const logs = await fetchRecentRequestLogs();
    
    const flaggedPatterns: Array<{
      reason: string;
      ipOrSubnet: string;
      accountsInvolved: string[];
      requestCount: number;
    }> = [];

    // 1. Analyze for threshold hugging
    const THRESHOLD_LIMIT = 300;
    const HUGGING_THRESHOLD = THRESHOLD_LIMIT * 0.95; // 95% of limit
    
    logs.forEach(log => {
      if (log.count >= HUGGING_THRESHOLD && log.count <= THRESHOLD_LIMIT) {
        flaggedPatterns.push({
          reason: "Threshold Hugging",
          ipOrSubnet: log.ip,
          accountsInvolved: log.accountId ? [log.accountId] : [],
          requestCount: log.count
        });
      }
    });

    // 2. Analyze for narrow IP range evasion
    // Group by /24 subnet
    const subnetMap = new Map<string, Set<string>>();
    logs.forEach(log => {
      const parts = log.ip.split(".");
      if (parts.length === 4) {
        const subnet = `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
        if (!subnetMap.has(subnet)) {
          subnetMap.set(subnet, new Set());
        }
        if (log.accountId) {
          subnetMap.get(subnet)!.add(log.accountId);
        }
      }
    });

    for (const [subnet, accounts] of subnetMap.entries()) {
      if (accounts.size >= 5) {
        flaggedPatterns.push({
          reason: "Narrow IP Range Evasion",
          ipOrSubnet: subnet,
          accountsInvolved: Array.from(accounts),
          requestCount: 0 // aggregate count could be tracked here
        });
      }
    }

    if (flaggedPatterns.length > 0) {
      logger.warn("[RateLimitAudit] Rate limit evasion patterns detected. Manual review required.", {
        patterns: flaggedPatterns
      });
      // Here you would also optionally insert into an AuditReport DB table for a dashboard.
    } else {
      logger.info("[RateLimitAudit] No evasion patterns detected.");
    }

  } catch (error) {
    logger.error("[RateLimitAudit] Failed to complete rate limit audit scan.", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
