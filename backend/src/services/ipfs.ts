import axios from "axios";
import logger from "../utils/logger.js";
import { loadConfig } from "../config.js";

const config = loadConfig();
export const PINATA_MAX_RETRIES = 3;
export const PINATA_RETRY_BASE_DELAY_MS = 1000;
interface PinataHashResponse {
  IpfsHash: string;
}

export function calculatePinataRetryDelay(retryCount: number): number {
  return 2 ** retryCount * PINATA_RETRY_BASE_DELAY_MS;
}

function isPinataRateLimitError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "response" in error &&
    typeof (error as { response?: { status?: number } }).response?.status === "number" &&
    (error as { response?: { status?: number } }).response?.status === 429
  );
}

function extractPinataErrorDetail(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "response" in error &&
    typeof (error as { response?: { data?: { error?: { details?: string } } } }).response?.data
      ?.error?.details === "string"
  ) {
    return (error as { response?: { data?: { error?: { details?: string } } } }).response!.data!
      .error!.details!;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message?: string }).message === "string"
  ) {
    return (error as { message: string }).message;
  }

  return "Unknown Pinata error";
}

async function waitForRetry(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function executePinataRequest<T>(
  request: () => Promise<{ data: T; status: number }>
): Promise<{ data: T; status: number }> {
  let retryCount = 0;

  while (true) {
    try {
      return await request();
    } catch (error) {
      if (!isPinataRateLimitError(error) || retryCount >= PINATA_MAX_RETRIES) {
        throw error;
      }

      retryCount += 1;
      const delayMs = calculatePinataRetryDelay(retryCount);
      console.warn(
        `[IPFSService] Pinata rate limit hit. Retrying request ${retryCount}/${PINATA_MAX_RETRIES} in ${delayMs}ms.`
      );
      await waitForRetry(delayMs);
    }
  }
}

/**
 * Uploads a file buffer to Pinata IPFS.
 * @param fileBuffer The Buffer of the file to pin.
 * @param fileName The original filename.
 * @returns The IPFS CID hash.
 */
export async function pinFileToIPFS(fileBuffer: Buffer, fileName: string): Promise<string> {
  const url = "https://api.pinata.cloud/pinning/pinFileToIPFS";

  if (!config.pinataApiKey || !config.pinataSecretApiKey) {
    throw new Error("Pinata credentials are not configured in environment variables.");
  }

  // Create a Blob from the file buffer
  const blob = new Blob([new Uint8Array(fileBuffer)]);

  // Construct form data payload
  const formData = new FormData();
  formData.append("file", blob, fileName);

  // Optional: add pinataMetadata name
  const pinataMetadata = JSON.stringify({
    name: fileName,
  });
  formData.append("pinataMetadata", pinataMetadata);

  try {
    const response = await executePinataRequest<PinataHashResponse>(() =>
      axios.post<PinataHashResponse>(url, formData, {
        headers: {
          "pinata_api_key": config.pinataApiKey,
          "pinata_secret_api_key": config.pinataSecretApiKey,
        },
      })
    );

    if (!response.data || !response.data.IpfsHash) {
      throw new Error("Invalid response received from Pinata API");
    }

    return response.data.IpfsHash;
  } catch (error) {
    console.error(
      "[IPFSService] Error pinning file to IPFS:",
      typeof error === "object" && error !== null && "response" in error
        ? (error as { response?: { data?: unknown } }).response?.data
        : extractPinataErrorDetail(error)
    );
    throw new Error(`Failed to pin file to IPFS: ${extractPinataErrorDetail(error)}`);
  }
}

/**
 * Pins a JSON object (milestone details, timestamps, file references) to Pinata.
 * @param metadata The JSON metadata object.
 * @returns The IPFS CID hash.
 */
export async function pinJSONToIPFS(metadata: any): Promise<string> {
  const url = "https://api.pinata.cloud/pinning/pinJSONToIPFS";

  if (!config.pinataApiKey || !config.pinataSecretApiKey) {
    throw new Error("Pinata credentials are not configured in environment variables.");
  }

  try {
    const response = await executePinataRequest<PinataHashResponse>(() =>
      axios.post<PinataHashResponse>(
        url,
        {
          pinataContent: metadata,
        },
        {
          headers: {
            "Content-Type": "application/json",
            "pinata_api_key": config.pinataApiKey,
            "pinata_secret_api_key": config.pinataSecretApiKey,
          },
        }
      )
    );

    if (!response.data || !response.data.IpfsHash) {
      throw new Error("Invalid response received from Pinata API");
    }

    return response.data.IpfsHash;
  } catch (error) {
    console.error(
      "[IPFSService] Error pinning JSON to IPFS:",
      typeof error === "object" && error !== null && "response" in error
        ? (error as { response?: { data?: unknown } }).response?.data
        : extractPinataErrorDetail(error)
    );
    throw new Error(`Failed to pin JSON to IPFS: ${extractPinataErrorDetail(error)}`);
  }
}

export interface UnpinResult {
  status: number;
  cid: string;
}

/**
 * Unpins a file from Pinata IPFS by CID.
 * @param cid The IPFS content identifier to unpin.
 * @returns Pinata API response status and CID.
 */
export async function unpinFileFromIPFS(cid: string): Promise<UnpinResult> {
  const url = `https://api.pinata.cloud/pinning/unpin/${encodeURIComponent(cid)}`;

  if (!config.pinataApiKey || !config.pinataSecretApiKey) {
    throw new Error("Pinata credentials are not configured in environment variables.");
  }

  try {
    const response = await executePinataRequest(() =>
      axios.delete(url, {
        headers: {
          pinata_api_key: config.pinataApiKey,
          pinata_secret_api_key: config.pinataSecretApiKey,
        },
      })
    );

    return { status: response.status, cid };
  } catch (error) {
    console.error(
      "[IPFSService] Error unpinning file from IPFS:",
      typeof error === "object" && error !== null && "response" in error
        ? (error as { response?: { data?: unknown } }).response?.data
        : extractPinataErrorDetail(error)
    );
    throw new Error(`Failed to unpin file from IPFS: ${extractPinataErrorDetail(error)}`);
  }
}
