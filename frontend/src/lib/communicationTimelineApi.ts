// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type CommunicationChannel = "EMAIL" | "SMS" | "IN_APP";

export interface CommunicationTimelineEntry {
  id: string;
  channel: CommunicationChannel;
  status: string;
  summary: string;
  recipient: string;
  occurredAt: string;
  attempts?: number;
  lastError?: string | null;
  read?: boolean;
}

export interface ApplicantCommunicationTimeline {
  applicantId: string;
  stellarAddress: string;
  email: string | null;
  phone: string | null;
  entries: CommunicationTimelineEntry[];
}

/**
 * Fetches the unified email/SMS/in-app notification timeline for one
 * applicant. `applicantId` may be an applicant id or a stellar address.
 */
export async function fetchApplicantCommunicationTimeline(
  applicantId: string,
  token?: string
): Promise<ApplicantCommunicationTimeline> {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const response = await fetch(
    `${API_BASE}/api/admin/applicants/${encodeURIComponent(applicantId)}/communications`,
    { headers }
  );

  if (response.status === 404) {
    throw new Error("Applicant not found");
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch communication timeline: ${response.statusText}`);
  }

  return response.json();
}
