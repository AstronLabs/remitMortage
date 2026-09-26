import { prisma, resolveOrCreateApplicant } from "./db.js";

export type CommunicationCategory = "DEPOSITS" | "MILESTONES" | "GOVERNANCE" | "SECURITY";
export type CommunicationChannel = "EMAIL" | "SMS" | "PUSH";

export const COMMUNICATION_CATEGORIES: CommunicationCategory[] = [
  "DEPOSITS",
  "MILESTONES",
  "GOVERNANCE",
  "SECURITY",
];

export const COMMUNICATION_CHANNELS: CommunicationChannel[] = ["EMAIL", "SMS", "PUSH"];

/**
 * Default enabled state for a category/channel cell that has no stored row
 * yet. SMS defaults to opted OUT — many jurisdictions require affirmative,
 * demonstrable opt-in before sending SMS (transactional or otherwise), so
 * the absence of a preference must mean "off," not "on by default." Email
 * and push default to opted IN, matching the pre-existing
 * NotificationPreference behavior (emailAlerts, loanMilestones, etc. all
 * default true).
 */
const DEFAULT_ENABLED: Record<CommunicationChannel, boolean> = {
  EMAIL: true,
  SMS: false,
  PUSH: true,
};

const DEFAULT_CONSENT_SOURCE = "user_settings_update";

export interface CommunicationPreferenceCell {
  enabled: boolean;
  consentTimestamp: string | null;
  consentSource: string | null;
}

export type CommunicationPreferenceMatrix = Record<
  CommunicationCategory,
  Record<CommunicationChannel, CommunicationPreferenceCell>
>;

function defaultMatrix(): CommunicationPreferenceMatrix {
  const matrix = {} as CommunicationPreferenceMatrix;
  for (const category of COMMUNICATION_CATEGORIES) {
    const row = {} as Record<CommunicationChannel, CommunicationPreferenceCell>;
    for (const channel of COMMUNICATION_CHANNELS) {
      row[channel] = { enabled: DEFAULT_ENABLED[channel], consentTimestamp: null, consentSource: null };
    }
    matrix[category] = row;
  }
  return matrix;
}

/**
 * Returns the full category x channel opt-in matrix for a user, filling in
 * defaults for any cell without a stored row. Purely a read — nothing is
 * persisted just by calling this, including for a user seen for the first
 * time (their Applicant record is still created, matching
 * getNotificationPreference's existing behavior, but no preference rows are).
 */
export async function getCommunicationPreferences(
  stellarAddressOrId: string
): Promise<CommunicationPreferenceMatrix> {
  const matrix = defaultMatrix();

  const applicant = await resolveOrCreateApplicant(stellarAddressOrId);
  if (!applicant) return matrix;

  const rows = await prisma.communicationPreference.findMany({
    where: { applicantId: applicant.id },
  });

  for (const row of rows) {
    matrix[row.category as CommunicationCategory][row.channel as CommunicationChannel] = {
      enabled: row.enabled,
      consentTimestamp: row.consentTimestamp ? row.consentTimestamp.toISOString() : null,
      consentSource: row.consentSource,
    };
  }

  return matrix;
}

export interface CommunicationPreferenceUpdate {
  category: CommunicationCategory;
  channel: CommunicationChannel;
  enabled: boolean;
  /** Where this consent decision came from, e.g. "user_settings_update", "onboarding". */
  source?: string;
}

/**
 * Applies a batch of category/channel opt-in changes for a user and returns
 * the resulting full matrix.
 *
 * Enabling a channel that was not already enabled stamps a fresh
 * consentTimestamp/consentSource — that transition is the compliance-relevant
 * event. Disabling a channel, or re-enabling one that was already enabled,
 * leaves any existing consent record untouched: it should reflect when
 * consent was actually granted, not the last time this endpoint happened to
 * be called with the same value.
 */
export async function updateCommunicationPreferences(
  stellarAddressOrId: string,
  updates: CommunicationPreferenceUpdate[]
): Promise<CommunicationPreferenceMatrix> {
  const applicant = await resolveOrCreateApplicant(stellarAddressOrId);
  if (!applicant) {
    throw new Error(`Could not resolve or create an applicant for "${stellarAddressOrId}"`);
  }

  const existingRows = await prisma.communicationPreference.findMany({
    where: { applicantId: applicant.id },
  });
  const existingByKey = new Map(existingRows.map((row) => [`${row.category}:${row.channel}`, row]));

  for (const update of updates) {
    const existing = existingByKey.get(`${update.category}:${update.channel}`);
    const isFreshOptIn = update.enabled && !(existing?.enabled ?? false);
    const consentFields = isFreshOptIn
      ? { consentTimestamp: new Date(), consentSource: update.source || DEFAULT_CONSENT_SOURCE }
      : {};

    await prisma.communicationPreference.upsert({
      where: {
        applicantId_category_channel: {
          applicantId: applicant.id,
          category: update.category,
          channel: update.channel,
        },
      },
      update: { enabled: update.enabled, ...consentFields },
      create: {
        applicantId: applicant.id,
        category: update.category,
        channel: update.channel,
        enabled: update.enabled,
        ...consentFields,
      },
    });
  }

  return getCommunicationPreferences(stellarAddressOrId);
}
