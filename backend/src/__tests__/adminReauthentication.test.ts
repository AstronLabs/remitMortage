import {
  ADMIN_REAUTH_WINDOW_MS,
  hasRecentAdminReauthentication,
  recordAdminReauthentication,
} from "../services/adminReauthentication.js";

jest.mock("../services/totpAuth.js", () => ({
  authenticateAdmin2FA: jest.fn(() => ({ authenticated: true })),
}));

describe("admin reauthentication window", () => {
  it("allows an action just inside the window", () => {
    const now = 1_000_000;
    recordAdminReauthentication("ADMIN", "123456", now);
    expect(hasRecentAdminReauthentication("ADMIN", now + ADMIN_REAUTH_WINDOW_MS - 1)).toBe(true);
  });

  it("rejects an action just outside the window", () => {
    const now = 2_000_000;
    recordAdminReauthentication("ADMIN-EXPIRED", "123456", now);
    expect(hasRecentAdminReauthentication("ADMIN-EXPIRED", now + ADMIN_REAUTH_WINDOW_MS + 1)).toBe(false);
  });

  it("does not require reauthentication for unrelated actions", () => {
    expect(hasRecentAdminReauthentication("OTHER-ACTION", 3_000_000)).toBe(false);
  });
});
