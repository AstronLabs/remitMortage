// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Minimal tracking-issue sink used by report-only audit jobs.
 *
 * In production this would call the GitHub Issues API; here it logs
 * structured output (and persists via audit log in the caller) so audits
 * never silently drop a candidate when no issue tracker is configured.
 * Never deletes or mutates code — it only files a human-review task.
 */

import logger from "../utils/logger.js";

export interface IssueRecord {
  title: string;
  body: string;
  labels: string[];
}

export interface IssueSink {
  open: (issue: IssueRecord) => Promise<void>;
}

export function createIssueNotifier(): IssueSink {
  return {
    async open(issue: IssueRecord): Promise<void> {
      logger.info("[issue-notifier] Tracking issue filed", {
        title: issue.title,
        labels: issue.labels,
      });
    },
  };
}
