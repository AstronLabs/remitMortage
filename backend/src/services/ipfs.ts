import axios from "axios";
import logger from "../utils/logger.js";
import { loadConfig } from "../config.js";

const config = loadConfig();

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
    const response = await axios.post(url, formData, {
      headers: {
        "pinata_api_key": config.pinataApiKey,
        "pinata_secret_api_key": config.pinataSecretApiKey,
      },
    });

    if (!response.data || !response.data.IpfsHash) {
      throw new Error("Invalid response received from Pinata API");
    }

    return response.data.IpfsHash;
  } catch (error: any) {
    logger.error("[IPFSService] Error pinning file to IPFS", { error: error.response?.data || error.message });
    throw new Error(`Failed to pin file to IPFS: ${error.response?.data?.error?.details || error.message}`);
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
    const response = await axios.post(
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
    );

    if (!response.data || !response.data.IpfsHash) {
      throw new Error("Invalid response received from Pinata API");
    }

    return response.data.IpfsHash;
  } catch (error: any) {
    logger.error("[IPFSService] Error pinning JSON to IPFS", { error: error.response?.data || error.message });
    throw new Error(`Failed to pin JSON to IPFS: ${error.response?.data?.error?.details || error.message}`);
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
    const response = await axios.delete(url, {
      headers: {
        pinata_api_key: config.pinataApiKey,
        pinata_secret_api_key: config.pinataSecretApiKey,
      },
    });

    return { status: response.status, cid };
  } catch (error: any) {
    logger.error("[IPFSService] Error unpinning file from IPFS", { error: error.response?.data || error.message });
    throw new Error(`Failed to unpin file from IPFS: ${error.response?.data?.error?.details || error.message}`);
  }
}
