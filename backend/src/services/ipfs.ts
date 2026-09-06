import axios from "axios";
import logger from "../utils/logger.js";
import { loadConfig } from "../config.js";

export const PINATA_MAX_RETRIES = 3;
export const PINATA_RETRY_BASE_DELAY_MS = 1000;

interface PinataHashResponse {
  IpfsHash: string;
}

interface NFTStorageResponse {
  ok: boolean;
  value: {
    cid: string;
  };
}

interface Web3StorageResponse {
  cid: string;
}

export interface ProviderPinResult {
  provider: string;
  cid: string;
  success: boolean;
  error?: string;
}

export interface MultiProviderPinResult {
  cid: string;
  fileName: string;
  providers: ProviderPinResult[];
  successCount: number;
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
 * Pins a file to Pinata IPFS.
 */
async function pinFileToPinata(fileBuffer: Buffer, fileName: string): Promise<string> {
  const config = loadConfig();
  const url = "https://api.pinata.cloud/pinning/pinFileToIPFS";

  if (!config.pinataApiKey || !config.pinataSecretApiKey) {
    throw new Error("Pinata credentials are not configured in environment variables.");
  }

  const blob = new Blob([new Uint8Array(fileBuffer)]);
  const formData = new FormData();
  formData.append("file", blob, fileName);

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
      "[IPFSService] Error pinning file to Pinata:",
      typeof error === "object" && error !== null && "response" in error
        ? (error as { response?: { data?: unknown } }).response?.data
        : extractPinataErrorDetail(error)
    );
    throw new Error(`Failed to pin file to Pinata: ${extractPinataErrorDetail(error)}`);
  }
}

/**
 * Pins a file to NFT.storage.
 */
async function pinFileToNFTStorage(fileBuffer: Buffer, fileName: string): Promise<string> {
  const config = loadConfig();
  const url = "https://api.nft.storage/upload";

  if (!config.secondaryIpfsApiKey) {
    throw new Error("NFT.storage API key is not configured.");
  }

  try {
    const formData = new FormData();
    const blob = new Blob([fileBuffer]);
    formData.append("file", blob, fileName);

    const response = await axios.post<NFTStorageResponse>(url, formData, {
      headers: {
        Authorization: `Bearer ${config.secondaryIpfsApiKey}`,
      },
    });

    if (!response.data.ok || !response.data.value?.cid) {
      throw new Error("Invalid response from NFT.storage API");
    }

    return response.data.value.cid;
  } catch (error) {
    const errorMsg =
      typeof error === "object" && error !== null && "message" in error
        ? (error as { message: string }).message
        : "Unknown NFT.storage error";
    console.error("[IPFSService] Error pinning file to NFT.storage:", errorMsg);
    throw new Error(`Failed to pin file to NFT.storage: ${errorMsg}`);
  }
}

/**
 * Pins a file to Web3.storage.
 */
async function pinFileToWeb3Storage(fileBuffer: Buffer, fileName: string): Promise<string> {
  const config = loadConfig();
  const url = "https://api.web3.storage/upload";

  if (!config.secondaryIpfsApiKey) {
    throw new Error("Web3.storage API key is not configured.");
  }

  try {
    const formData = new FormData();
    const blob = new Blob([fileBuffer]);
    formData.append("file", blob, fileName);

    const response = await axios.post<Web3StorageResponse>(url, formData, {
      headers: {
        Authorization: `Bearer ${config.secondaryIpfsApiKey}`,
      },
    });

    if (!response.data.cid) {
      throw new Error("Invalid response from Web3.storage API");
    }

    return response.data.cid;
  } catch (error) {
    const errorMsg =
      typeof error === "object" && error !== null && "message" in error
        ? (error as { message: string }).message
        : "Unknown Web3.storage error";
    console.error("[IPFSService] Error pinning file to Web3.storage:", errorMsg);
    throw new Error(`Failed to pin file to Web3.storage: ${errorMsg}`);
  }
}

/**
 * Pins a JSON object to Pinata.
 */
async function pinJSONToPinata(metadata: any): Promise<string> {
  const config = loadConfig();
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
      "[IPFSService] Error pinning JSON to Pinata:",
      typeof error === "object" && error !== null && "response" in error
        ? (error as { response?: { data?: unknown } }).response?.data
        : extractPinataErrorDetail(error)
    );
    throw new Error(`Failed to pin JSON to Pinata: ${extractPinataErrorDetail(error)}`);
  }
}

/**
 * Uploads a file buffer to Pinata IPFS.
 * @param fileBuffer The Buffer of the file to pin.
 * @param fileName The original filename.
 * @returns The IPFS CID hash.
 */
export async function pinFileToIPFS(fileBuffer: Buffer, fileName: string): Promise<string> {
  return pinFileToPinata(fileBuffer, fileName);
}

/**
 * Uploads a file buffer to multiple IPFS providers for redundancy.
 * @param fileBuffer The Buffer of the file to pin.
 * @param fileName The original filename.
 * @returns Result object with CID and per-provider status.
 */
export async function pinFileToMultipleProviders(
  fileBuffer: Buffer,
  fileName: string
): Promise<MultiProviderPinResult> {
  const config = loadConfig();
  const providers: ProviderPinResult[] = [];
  let primaryCid: string | null = null;
  let successCount = 0;

  // Always pin to Pinata (primary)
  try {
    primaryCid = await pinFileToPinata(fileBuffer, fileName);
    providers.push({
      provider: "pinata",
      cid: primaryCid,
      success: true,
    });
    successCount++;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    providers.push({
      provider: "pinata",
      cid: "",
      success: false,
      error: errorMsg,
    });
  }

  // Pin to secondary provider if configured
  if (config.secondaryIpfsProvider && config.secondaryIpfsApiKey) {
    try {
      let secondaryCid: string;
      if (config.secondaryIpfsProvider === "nft.storage") {
        secondaryCid = await pinFileToNFTStorage(fileBuffer, fileName);
      } else if (config.secondaryIpfsProvider === "web3.storage") {
        secondaryCid = await pinFileToWeb3Storage(fileBuffer, fileName);
      } else {
        throw new Error(`Unknown secondary IPFS provider: ${config.secondaryIpfsProvider}`);
      }

      providers.push({
        provider: config.secondaryIpfsProvider,
        cid: secondaryCid,
        success: true,
      });
      successCount++;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      providers.push({
        provider: config.secondaryIpfsProvider,
        cid: "",
        success: false,
        error: errorMsg,
      });
    }
  }

  // Determine effective CID - prefer primary, fallback to secondary if primary failed
  const effectiveCid = primaryCid || providers.find((p) => p.success)?.cid || null;

  if (!effectiveCid) {
    throw new Error("Failed to pin to primary provider (Pinata)");
  }

  // Warn if redundancy not achieved but don't hard-fail when at least one provider succeeded
  // This keeps content retrievable via secondary during primary outage (acceptance criteria #2)
  if (config.secondaryIpfsProvider && successCount < 2) {
    console.warn(
      `[IPFSService] Redundancy warning: only ${successCount} provider(s) succeeded. Require minimum 2 for full redundancy.`
    );
  }

  return {
    cid: effectiveCid,
    fileName,
    providers,
    successCount,
  };
}

/**
 * Pins a JSON object (milestone details, timestamps, file references) to Pinata.
 * @param metadata The JSON metadata object.
 * @returns The IPFS CID hash.
 */
export async function pinJSONToIPFS(metadata: any): Promise<string> {
  return pinJSONToPinata(metadata);
}

/**
 * Pins a JSON object to multiple IPFS providers for redundancy.
 * @param metadata The JSON metadata object.
 * @returns Result object with CID and per-provider status.
 */
export async function pinJSONToMultipleProviders(
  metadata: any
): Promise<MultiProviderPinResult> {
  const providers: ProviderPinResult[] = [];
  let primaryCid: string | null = null;
  let successCount = 0;

  // Always pin to Pinata (primary)
  try {
    primaryCid = await pinJSONToPinata(metadata);
    providers.push({
      provider: "pinata",
      cid: primaryCid,
      success: true,
    });
    successCount++;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    providers.push({
      provider: "pinata",
      cid: "",
      success: false,
      error: errorMsg,
    });
  }

  // Secondary providers don't typically support JSON pinning directly,
  // so this is primarily for file-based pinning via multiProviders.
  // For now, just return the Pinata result.

  if (!primaryCid) {
    throw new Error("Failed to pin JSON to primary provider (Pinata)");
  }

  return {
    cid: primaryCid,
    fileName: "metadata",
    providers,
    successCount,
  };
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
  const config = loadConfig();
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
