/**
 * @jest-environment node
 */
import { GET, POST } from "../src/app/api/user/settings/route";

function postRequest(body: unknown): any {
  return new Request("http://localhost/api/user/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getRequest(userId: string): any {
  return new Request(`http://localhost/api/user/settings?userId=${encodeURIComponent(userId)}`);
}

describe("GET /api/user/settings — text size default", () => {
  it("defaults to the default step for a brand-new user", async () => {
    const res = await GET(getRequest("brand-new-text-size-user") as any);
    const body = await res.json();

    expect(body.settings.textSize).toBe("default");
  });
});

describe("POST /api/user/settings — text size persistence", () => {
  it("the chosen size is reflected on the next fetch", async () => {
    const userId = "text-size-persistence-user";

    await POST(postRequest({ userId, textSize: "x-large" }) as any);

    const res = await GET(getRequest(userId) as any);
    const body = await res.json();

    expect(body.settings.textSize).toBe("x-large");
  });

  it("rejects an unknown size", async () => {
    const res = await POST(postRequest({ userId: "bad-text-size-user", textSize: "gigantic" }) as any);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_text_size");
    expect(body.field).toBe("textSize");
  });

  it("does not persist a rejected size, even alongside valid fields", async () => {
    const userId = "text-size-reject-bundled-user";

    await POST(
      postRequest({ userId, textSize: "gigantic", profile: { displayName: "Ada" } }) as any
    );

    const res = await GET(getRequest(userId) as any);
    const body = await res.json();
    // Falls through to the default, proving the invalid value was never saved.
    expect(body.settings.textSize).toBe("default");
  });
});
