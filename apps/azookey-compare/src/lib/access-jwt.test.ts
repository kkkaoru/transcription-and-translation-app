import { describe, expect, it, vi } from "vitest";
import {
  ACCESS_JWT_HEADER,
  ACCESS_JWT_UNAUTHORIZED_STATUS,
  accessJwtUnauthorizedResponse,
  createJoseAccessJwtVerifier,
  enforceAccessJwt,
  normalizeTeamDomain,
  readAccessJwtAssertion,
  resolveAccessJwtMode,
} from "./access-jwt";

const requestWithJwt = (token?: string) => {
  const headers = token === undefined ? undefined : { [ACCESS_JWT_HEADER]: token };
  return new Request("https://azookey-compare.kaoru.workers.dev/", { headers });
};

const readUnauthorized = async (response: Response | null) => {
  expect(response).not.toBeNull();
  if (!response) {
    throw new Error("expected an Access JWT denial");
  }
  return {
    status: response.status,
    authenticate: response.headers.get("WWW-Authenticate"),
    contentType: response.headers.get("Content-Type"),
    body: await response.text(),
  };
};

describe("compare Worker Access JWT gate", () => {
  it("stays disabled until both Access audience and team domain are set", () => {
    expect(resolveAccessJwtMode({})).toEqual({ status: "disabled" });
    expect(resolveAccessJwtMode({ POLICY_AUD: "   ", TEAM_DOMAIN: "" })).toEqual({
      status: "disabled",
    });
    expect(resolveAccessJwtMode({ POLICY_AUD: "aud" })).toEqual({ status: "incomplete" });
    expect(resolveAccessJwtMode({ TEAM_DOMAIN: "https://team.cloudflareaccess.com" })).toEqual({
      status: "incomplete",
    });
  });

  it("normalizes the team domain and builds the JWKS URL", () => {
    expect(normalizeTeamDomain(" https://team.cloudflareaccess.com/ ")).toBe(
      "https://team.cloudflareaccess.com",
    );
    expect(
      resolveAccessJwtMode({
        POLICY_AUD: " aud-tag ",
        TEAM_DOMAIN: "https://team.cloudflareaccess.com/",
      }),
    ).toEqual({
      status: "enabled",
      config: {
        policyAud: "aud-tag",
        teamDomain: "https://team.cloudflareaccess.com",
        certsUrl: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
      },
    });
  });

  it("reads the Access assertion header and ignores blanks", () => {
    expect(readAccessJwtAssertion(requestWithJwt(" signed-jwt "))).toBe("signed-jwt");
    expect(readAccessJwtAssertion(requestWithJwt("   "))).toBeNull();
    expect(readAccessJwtAssertion(requestWithJwt())).toBeNull();
  });

  it("returns 401 with WWW-Authenticate for denials", async () => {
    const response = accessJwtUnauthorizedResponse("Missing required CF Access JWT");
    await expect(readUnauthorized(response)).resolves.toEqual({
      status: ACCESS_JWT_UNAUTHORIZED_STATUS,
      authenticate: "Bearer",
      contentType: "text/plain; charset=utf-8",
      body: "Missing required CF Access JWT",
    });
  });

  it("passes through when Access JWT validation is not configured", async () => {
    const verify = vi.fn();
    await expect(enforceAccessJwt(requestWithJwt(), {}, verify)).resolves.toBeNull();
    expect(verify).not.toHaveBeenCalled();
  });

  it("fails closed when only one of POLICY_AUD or TEAM_DOMAIN is set", async () => {
    const verify = vi.fn();
    const denied = await enforceAccessJwt(requestWithJwt("jwt"), { POLICY_AUD: "aud" }, verify);
    await expect(readUnauthorized(denied)).resolves.toMatchObject({
      status: 401,
      authenticate: "Bearer",
      body: "Access JWT configuration incomplete",
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it("rejects missing or invalid assertions once Access vars are set", async () => {
    const env = {
      POLICY_AUD: "aud-tag",
      TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    };
    const missing = await enforceAccessJwt(requestWithJwt(), env, vi.fn());
    await expect(readUnauthorized(missing)).resolves.toMatchObject({
      body: "Missing required CF Access JWT",
    });

    const verify = vi.fn(() => Promise.reject(new Error("bad signature")));
    const invalid = await enforceAccessJwt(requestWithJwt("forged"), env, verify);
    await expect(readUnauthorized(invalid)).resolves.toMatchObject({
      body: "Invalid CF Access JWT",
    });
    expect(verify).toHaveBeenCalledWith("forged", {
      policyAud: "aud-tag",
      teamDomain: "https://team.cloudflareaccess.com",
      certsUrl: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
    });
  });

  it("allows a verified Access JWT through", async () => {
    const verify = vi.fn(() => Promise.resolve({ payload: { email: "kaoru@teadea.net" } }));
    await expect(
      enforceAccessJwt(
        requestWithJwt("valid-jwt"),
        {
          POLICY_AUD: "aud-tag",
          TEAM_DOMAIN: "https://team.cloudflareaccess.com",
        },
        verify,
      ),
    ).resolves.toBeNull();
    expect(verify).toHaveBeenCalledOnce();
  });

  it("verifies with jose helpers and caches JWKS by certs URL", async () => {
    const urls: string[] = [];
    const jwks = { kid: "test" } as never;
    const createJwks = (url: URL) => {
      urls.push(url.href);
      return jwks;
    };
    const verify = vi.fn((token, key, options) => {
      expect(token).toBe("jwt");
      expect(key).toBe(jwks);
      expect(options).toEqual({
        issuer: "https://team.cloudflareaccess.com",
        audience: "aud-tag",
      });
      return Promise.resolve({ payload: {}, protectedHeader: { alg: "RS256" } } as never);
    });
    const verifier = createJoseAccessJwtVerifier(createJwks, verify);
    const config = {
      policyAud: "aud-tag",
      teamDomain: "https://team.cloudflareaccess.com",
      certsUrl: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
    };
    await verifier("jwt", config);
    await verifier("jwt", config);
    expect(urls).toEqual(["https://team.cloudflareaccess.com/cdn-cgi/access/certs"]);
    expect(verify).toHaveBeenCalledTimes(2);
  });
});
