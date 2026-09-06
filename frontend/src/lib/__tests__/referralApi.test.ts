import {
  persistReferralCode,
  readPersistedReferralCode,
  REFERRAL_QUERY_PARAM,
  REFERRAL_STORAGE_KEY,
} from "../referralApi";

describe("referralApi storage helpers", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("persists and reads referral codes from localStorage", () => {
    persistReferralCode("RM-TESTCODE");
    expect(readPersistedReferralCode()).toBe("RM-TESTCODE");
    expect(window.localStorage.getItem(REFERRAL_STORAGE_KEY)).toBe("RM-TESTCODE");
  });

  it("exports the onboarding query param key", () => {
    expect(REFERRAL_QUERY_PARAM).toBe("ref");
  });
});
