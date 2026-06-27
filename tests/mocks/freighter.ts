const MOCK_PUBLIC_KEY = "GAXI4LZGQ7F3CKOBU7S6MFYKZRCNFRQVXJXKOMZ7GM7MIFST5W54AAAA";

interface FreighterMock {
  isConnected: () => Promise<boolean>;
  getPublicKey: () => Promise<string>;
  signBlob: (blob: string) => Promise<string>;
  requestAccess: () => Promise<void>;
  getNetwork: () => Promise<string>;
}

export function createFreighterMock(
  overrides: Partial<FreighterMock> = {}
): FreighterMock {
  return {
    isConnected: async () => true,
    getPublicKey: async () => MOCK_PUBLIC_KEY,
    signBlob: async (_blob: string) => "mock_signature_hex",
    requestAccess: async () => {},
    getNetwork: async () => "https://horizon-testnet.stellar.org",
    ...overrides,
  };
}

export function injectFreighterMock(overrides: Partial<FreighterMock> = void 0 as any): FreighterMock {
  const mock = createFreighterMock(overrides);
  (window as any).freighterApi = mock;
  return mock;
}

export function removeFreighterMock(): void {
  delete (window as any).freighterApi;
}

export { MOCK_PUBLIC_KEY };
