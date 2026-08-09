import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  assertPolicyIsNotWorldOpen,
  buildGoogleIdentityProviderBody,
  buildOtpIdentityProviderBody,
  buildPublicDenyPolicy,
  buildSelfHostedWorkerAppBody,
  buildTeadeaAllowPolicy,
  DEFAULT_ALLOW_EMAIL_DOMAINS,
  DEFAULT_ALLOW_EMAILS,
  describeAccessApiError,
  hasGoogleOAuthCredentials,
  parseCsvList,
  planAccessSetup,
  resolveAccountId,
  resolveWorkerIdFromList,
  selectAllowedIdpIds,
} from "./setup-cloudflare-access.mjs";

describe("setup-cloudflare-access", () => {
  it("reads CLOUDFLARE_ACCOUNT_ID from env or dotenv without inventing it", () => {
    assert.equal(resolveAccountId({ env: {}, dotenv: {} }), undefined);
    assert.equal(resolveAccountId({ env: { CLOUDFLARE_ACCOUNT_ID: "abc" }, dotenv: {} }), "abc");
    assert.equal(resolveAccountId({ env: {}, dotenv: { CLOUDFLARE_ACCOUNT_ID: "def" } }), "def");
  });

  it("skips Google IdP unless both client id and secret are present", () => {
    assert.equal(hasGoogleOAuthCredentials({ env: {}, dotenv: {} }), false);
    assert.equal(
      hasGoogleOAuthCredentials({
        env: { GOOGLE_OAUTH_CLIENT_ID: "id-only" },
        dotenv: {},
      }),
      false,
    );
    assert.equal(
      hasGoogleOAuthCredentials({
        env: {
          GOOGLE_OAUTH_CLIENT_ID: "client-id",
          GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
        },
        dotenv: {},
      }),
      true,
    );
  });

  it("builds OTP and Google IdP bodies from the current Access API shape", () => {
    assert.deepEqual(buildOtpIdentityProviderBody(), {
      name: "One-time PIN login",
      type: "onetimepin",
      config: {},
    });
    assert.deepEqual(
      buildGoogleIdentityProviderBody({
        clientId: "client-id",
        clientSecret: "client-secret",
      }),
      {
        name: "Google",
        type: "google",
        config: { client_id: "client-id", client_secret: "client-secret" },
      },
    );
  });

  it("allows only teadea emails/domains and denies public inference", () => {
    const allow = buildTeadeaAllowPolicy();
    assert.equal(allow.decision, "allow");
    assert.deepEqual(allow.include, [
      { email: { email: DEFAULT_ALLOW_EMAILS[0] } },
      { email_domain: { domain: DEFAULT_ALLOW_EMAIL_DOMAINS[0] } },
    ]);
    assert.doesNotThrow(() => assertPolicyIsNotWorldOpen(allow));
    assert.throws(
      () => assertPolicyIsNotWorldOpen({ decision: "allow", include: [{ everyone: {} }] }),
      /everyone/,
    );
    assert.throws(
      () =>
        assertPolicyIsNotWorldOpen({
          decision: "allow",
          include: [{ login_method: { id: "otp" } }],
        }),
      /login_method-only/,
    );
    const deny = buildPublicDenyPolicy();
    assert.equal(deny.decision, "deny");
    assert.deepEqual(deny.include, [{ everyone: {} }]);
    assert.doesNotThrow(() => assertPolicyIsNotWorldOpen(deny));
  });

  it("protects workers.dev apps with worker destinations and Managed OAuth", () => {
    const body = buildSelfHostedWorkerAppBody({
      name: "azookey-compare",
      workerId: "0123456789abcdef0123456789abcdef",
      publicHost: "azookey-compare.kaoru.workers.dev",
      policies: [buildTeadeaAllowPolicy()],
      allowedIdps: ["otp-id"],
    });
    assert.equal(body.type, "self_hosted");
    assert.deepEqual(body.destinations, [
      { type: "worker", worker_id: "0123456789abcdef0123456789abcdef" },
    ]);
    assert.equal(body.oauth_configuration.enabled, true);
    assert.deepEqual(body.allowed_idps, ["otp-id"]);
    assert.equal(body.auto_redirect_to_identity, true);
    assert.equal(body.app_launcher_visible, false);
  });

  it("omits allowed_idps when none are known so Access keeps account IdPs", () => {
    const body = buildSelfHostedWorkerAppBody({
      name: "azookey-compare",
      workerId: "0123456789abcdef0123456789abcdef",
      publicHost: "azookey-compare.kaoru.workers.dev",
      policies: [buildTeadeaAllowPolicy()],
      allowedIdps: [],
    });
    assert.equal(body.allowed_idps, undefined);
    assert.equal(body.auto_redirect_to_identity, false);
  });

  it("selects OTP and optional Google IdP ids only", () => {
    assert.deepEqual(
      selectAllowedIdpIds({
        identityProviders: [
          { id: "otp-1", type: "onetimepin" },
          { id: "cf-1", type: "onetimepinx" },
          { id: "google-1", type: "google" },
        ],
        includeGoogle: false,
      }),
      ["otp-1"],
    );
    assert.deepEqual(
      selectAllowedIdpIds({
        identityProviders: [
          { id: "otp-1", type: "onetimepin" },
          { id: "google-1", type: "google" },
        ],
        includeGoogle: true,
      }),
      ["otp-1", "google-1"],
    );
  });

  it("resolves worker ids from the Workers API list", () => {
    assert.equal(
      resolveWorkerIdFromList([{ name: "azookey-compare", id: "abc123" }], "azookey-compare"),
      "abc123",
    );
    assert.equal(
      resolveWorkerIdFromList(
        [{ name: "azookey-compare", id: { tag: "def456" } }],
        "azookey-compare",
      ),
      "def456",
    );
    assert.equal(resolveWorkerIdFromList([], "azookey-compare"), undefined);
  });

  it("explains 403s with the documented Access permission names", () => {
    assert.match(
      describeAccessApiError({ status: 403, resource: "identity_providers" }),
      /Organizations, Identity Providers, and Groups Edit/,
    );
    assert.match(
      describeAccessApiError({ status: 403, resource: "apps" }),
      /Apps and Policies Edit/,
    );
  });

  it("plans Google skip and default allow lists from env", () => {
    const plan = planAccessSetup({
      env: { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "token" },
      dotenv: {},
    });
    assert.equal(plan.accountId, "acct");
    assert.equal(plan.googleEnabled, false);
    assert.deepEqual(plan.allowEmails, DEFAULT_ALLOW_EMAILS);
    assert.deepEqual(plan.allowEmailDomains, DEFAULT_ALLOW_EMAIL_DOMAINS);
    assert.deepEqual(parseCsvList("a@x.test, b@y.test", DEFAULT_ALLOW_EMAILS), [
      "a@x.test",
      "b@y.test",
    ]);
  });
});
