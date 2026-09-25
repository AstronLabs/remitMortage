// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import Irys from "@irys/sdk";
import logger from "../utils/logger.js";
import { loadConfig } from "../config.js";

const config = loadConfig();

let irysClient: Irys | null = null;

function getIrys(): Irys | null {
  if (irysClient) return irysClient;

  if (!config.irysPrivateKey) {
    logger.warn("[Arweave] Irys private key not configured. Arweave uploads will be skipped.");
    return null;
  }

  try {
    irysClient = new Irys({
      url: "https://node2.irys.xyz", // using devnet or node2 for cheap/free uploads if possible
      token: config.irysNetworkToken,
      key: config.irysPrivateKey,
    });
    return irysClient;
  } catch (error) {
    logger.error("[Arweave] Failed to initialize Irys client", { error });
    return null;
  }
}

/**
 * Uploads a file buffer to Arweave via the Irys bundler network.
 * 
 * @param buffer The file buffer to upload
 * @param mimeType The MIME type of the file
 * @returns The Arweave transaction ID if successful, or null if unconfigured/failed
 */
export async function uploadToArweave(buffer: Buffer, mimeType: string): Promise<string | null> {
  const irys = getIrys();
  if (!irys) {
    return null;
  }

  try {
    const tags = [{ name: "Content-Type", value: mimeType }];
    const receipt = await irys.upload(buffer, { tags });
    logger.info("[Arweave] File uploaded successfully", { id: receipt.id });
    return receipt.id;
  } catch (error) {
    logger.error("[Arweave] Upload failed", { error });
    throw new Error("Failed to upload file to Arweave");
  }
}
