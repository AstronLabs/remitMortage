// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  checkApproachingDsarDeadlines,
  clearDsarStore,
  createDsarRequest,
  DsarDeadlineAlert,
  transitionDsarStatus,
} from "../services/dsarTracker.js";

describe("DSAR tracker with statutory deadlines (#975)", () => {
  beforeEach(() => {
    clearDsarStore();
  });

  it("calculates statutory deadline from received date and enforces valid status transitions", () => {
    const req = createDsarRequest({
      type: "ACCESS",
      requester: "alice@example.com",
      receivedAt: "2026-06-01T00:00:00.000Z",
    });

    expect(req.status).toBe("RECEIVED");
    expect(req.statutoryDeadline).toBe("2026-07-01T00:00:00.000Z");

    // Skipping IDENTITY_VERIFIED must fail.
    expect(() => transitionDsarStatus(req.id, "IN_PROGRESS")).toThrow(/Cannot transition/);
    expect(() => transitionDsarStatus(req.id, "COMPLETED")).toThrow(/Cannot transition/);

    const verified = transitionDsarStatus(req.id, "IDENTITY_VERIFIED");
    expect(verified.status).toBe("IDENTITY_VERIFIED");

    // Backward transition must fail.
    expect(() => transitionDsarStatus(req.id, "RECEIVED")).toThrow(/Cannot transition/);

    const inProgress = transitionDsarStatus(req.id, "IN_PROGRESS");
    expect(inProgress.status).toBe("IN_PROGRESS");

    const completed = transitionDsarStatus(req.id, "COMPLETED");
    expect(completed.status).toBe("COMPLETED");

    // Further transitions after COMPLETED must fail.
    expect(() => transitionDsarStatus(req.id, "IN_PROGRESS")).toThrow(/Cannot transition/);
  });

  it("alerts admins exactly once when a request is within the deadline warning window", () => {
    const nearReq = createDsarRequest({
      type: "ERASURE",
      requester: "bob@example.com",
      receivedAt: "2026-06-01T00:00:00.000Z",
    });
    const farReq = createDsarRequest({
      type: "PORTABILITY",
      requester: "carol@example.com",
      receivedAt: "2026-06-25T00:00:00.000Z",
    });

    const sent: DsarDeadlineAlert[] = [];
    const checkTime = new Date("2026-06-28T00:00:00.000Z"); // 3 days before nearReq deadline

    const first = checkApproachingDsarDeadlines({
      now: checkTime,
      warningDays: 5,
      notify: (a) => sent.push(a),
    });
    expect(first).toHaveLength(1);
    expect(first[0].requestId).toBe(nearReq.id);
    expect(sent).toHaveLength(1);

    // Second check must NOT alert again for nearReq, and farReq is still outside window.
    const second = checkApproachingDsarDeadlines({
      now: checkTime,
      warningDays: 5,
      notify: (a) => sent.push(a),
    });
    expect(second).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(farReq.id).not.toBe(nearReq.id);
  });
});
