// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { uploadToArweave } from "../services/arweave";
import Irys from "@irys/sdk";

jest.mock("@irys/sdk", () => {
  return jest.fn().mockImplementation(() => {
    return {
      upload: jest.fn().mockResolvedValue({ id: "mock_tx_id_123" }),
    };
  });
});

jest.mock("../config", () => ({
  loadConfig: jest.fn().mockReturnValue({
    irysPrivateKey: "fake-private-key",
    irysNetworkToken: "matic",
  }),
}));

describe("Arweave Service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should upload file to Arweave and return receipt ID when configured", async () => {
    const buffer = Buffer.from("test file content");
    const mimeType = "text/plain";
    
    const txId = await uploadToArweave(buffer, mimeType);
    
    expect(txId).toBe("mock_tx_id_123");
    
    // Check if Irys was instantiated
    expect(Irys).toHaveBeenCalledWith({
      url: "https://node2.irys.xyz",
      token: "matic",
      key: "fake-private-key",
    });
  });
});
