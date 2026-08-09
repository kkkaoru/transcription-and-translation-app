#!/usr/bin/env node
/**
 * Idempotent Cloudflare Access setup for the hosted compare UI and inference Worker.
 *
 * Creates OTP (and Google when env credentials exist), then self-hosted apps with
 * Managed OAuth. Inference stays closed to the public internet; compare allows only
 * configured teadea emails/domains. Secrets are never printed.
 *
 * Usage:
 *   node scripts/setup-cloudflare-access.mjs
 *   node scripts/setup-cloudflare-access.mjs --check
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDotEnv, resolveCloudflareApiToken } from "./setup-cursor-cloudflare-mcp.mjs";

const API_BASE = "https://api.cloudflare.com/client/v4";
const OTP_IDP_NAME = "One-time PIN login";
const GOOGLE_IDP_NAME = "Google";
const IDP_WRITE_PERMISSION = "Access: Organizations, Identity Providers, and Groups Edit";
const APPS_WRITE_PERMISSION = "Access: Apps and Policies Edit";

export const COMPARE_WORKER_NAME = "azookey-compare";
export const INFERENCE_WORKER_NAME = "kotoba-beacon-inference";
export const COMPARE_APP_NAME = "azookey-compare";
export const INFERENCE_APP_NAME = "kotoba-beacon-inference";
export const COMPARE_PUBLIC_HOST = "azookey-compare.kaoru.workers.dev";
export const INFERENCE_PUBLIC_HOST = "kotoba-beacon-inference.kaoru.workers.dev";
export const DEFAULT_ALLOW_EMAILS = ["kaoru@teadea.net"];
export const DEFAULT_ALLOW_EMAIL_DOMAINS = ["teadea.net"];

const present = (value) => typeof value === "string" && value.trim().length > 0;

export const parseCsvList = (value, fallback) => {
  if (!present(value)) {
    return [...fallback];
  }
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : [...fallback];
};

export const resolveAccountId = ({ env = process.env, dotenv = {} } = {}) => {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || dotenv.CLOUDFLARE_ACCOUNT_ID;
  return present(accountId) ? accountId.trim() : undefined;
};

export const hasGoogleOAuthCredentials = ({ env = process.env, dotenv = {} } = {}) =>
  present(env.GOOGLE_OAUTH_CLIENT_ID || dotenv.GOOGLE_OAUTH_CLIENT_ID) &&
  present(env.GOOGLE_OAUTH_CLIENT_SECRET || dotenv.GOOGLE_OAUTH_CLIENT_SECRET);

export const buildOtpIdentityProviderBody = () => ({
  name: OTP_IDP_NAME,
  type: "onetimepin",
  config: {},
});

export const buildGoogleIdentityProviderBody = ({ clientId, clientSecret }) => ({
  name: GOOGLE_IDP_NAME,
  type: "google",
  config: {
    client_id: clientId,
    client_secret: clientSecret,
  },
});

export const buildTeadeaAllowPolicy = ({
  emails = DEFAULT_ALLOW_EMAILS,
  domains = DEFAULT_ALLOW_EMAIL_DOMAINS,
} = {}) => ({
  name: "teadea allow",
  decision: "allow",
  include: [
    ...emails.map((email) => ({ email: { email } })),
    ...domains.map((domain) => ({ email_domain: { domain } })),
  ],
});

export const buildPublicDenyPolicy = () => ({
  name: "deny public",
  decision: "deny",
  include: [{ everyone: {} }],
});

const isEveryoneRule = (rule) =>
  Boolean(rule && typeof rule === "object" && rule.everyone && typeof rule.everyone === "object");

const isLoginMethodRule = (rule) =>
  Boolean(
    rule && typeof rule === "object" && rule.login_method && typeof rule.login_method === "object",
  );

export const assertPolicyIsNotWorldOpen = (policy) => {
  if (!policy || typeof policy !== "object") {
    throw new Error("Access policy is missing");
  }
  if (policy.decision !== "allow") {
    return;
  }
  const include = Array.isArray(policy.include) ? policy.include : [];
  if (include.some(isEveryoneRule)) {
    throw new Error("Allow policy must not include everyone");
  }
  if (include.some(isLoginMethodRule) && include.every(isLoginMethodRule)) {
    throw new Error("Allow policy must not be login_method-only (world-open OTP)");
  }
};

export const selectAllowedIdpIds = ({ identityProviders, includeGoogle }) => {
  const otp = identityProviders.find((idp) => idp?.type === "onetimepin");
  const google = identityProviders.find((idp) => idp?.type === "google");
  const ids = [];
  if (otp?.id) {
    ids.push(otp.id);
  }
  if (includeGoogle && google?.id) {
    ids.push(google.id);
  }
  return ids;
};

export const buildAccessDestinations = ({ destinationKind, workerId, publicHost }) => {
  if (destinationKind === "worker") {
    return [{ type: "worker", worker_id: workerId }];
  }
  return [{ type: "public", uri: publicHost }];
};

export const buildSelfHostedWorkerAppBody = ({
  name,
  workerId,
  publicHost,
  policies,
  allowedIdps,
  oauthEnabled = true,
  destinationKind = "public",
}) => {
  for (const policy of policies) {
    assertPolicyIsNotWorldOpen(policy);
  }
  const destinations = buildAccessDestinations({ destinationKind, workerId, publicHost });
  /** @type {Record<string, unknown>} */
  const body = {
    name,
    type: "self_hosted",
    destinations,
    session_duration: "24h",
    app_launcher_visible: false,
    auto_redirect_to_identity: allowedIdps.length === 1,
    enable_binding_cookie: true,
    http_only_cookie_attribute: true,
    oauth_configuration: { enabled: oauthEnabled },
    policies,
  };
  // Top-level domain must appear in destinations or Access returns
  // "domain not included in destinations". Worker-only apps omit it.
  if (destinationKind === "public") {
    body.domain = publicHost;
  }
  if (allowedIdps.length > 0) {
    body.allowed_idps = allowedIdps;
  }
  return body;
};

export const resolveAccessTeamDomain = (organization) => {
  const authDomain =
    (typeof organization?.auth_domain === "string" && organization.auth_domain.trim()) ||
    (typeof organization?.name === "string" && organization.name.trim()
      ? `${organization.name.trim()}.cloudflareaccess.com`
      : "");
  if (!authDomain) {
    return undefined;
  }
  const host = authDomain.replace(/^https?:\/\//u, "").replace(/\/+$/u, "");
  return host ? `https://${host}` : undefined;
};

export const resolveAccessJwtBindings = ({ app, organization }) => {
  const policyAud = typeof app?.aud === "string" ? app.aud.trim() : "";
  const teamDomain = resolveAccessTeamDomain(organization);
  if (!policyAud || !teamDomain) {
    return undefined;
  }
  return { policyAud, teamDomain };
};

export const resolveWorkerIdFromList = (workers, workerName) => {
  const worker = (workers || []).find((item) => item?.name === workerName);
  if (!worker) {
    return undefined;
  }
  if (typeof worker.id === "string" && worker.id.trim()) {
    return worker.id.trim();
  }
  if (worker.id && typeof worker.id === "object" && present(worker.id.tag)) {
    return worker.id.tag.trim();
  }
  return undefined;
};

export const describeAccessApiError = ({ status, errors = [], resource }) => {
  const messages = errors.map((error) => error?.message).filter(Boolean);
  if (status === 403) {
    const permission =
      resource === "identity_providers" || resource === "organizations"
        ? IDP_WRITE_PERMISSION
        : APPS_WRITE_PERMISSION;
    return `Cloudflare Access ${resource} returned 403. Add Account permission "${permission}".`;
  }
  return `Cloudflare Access ${resource} failed (${status}): ${messages.join("; ") || "unknown error"}`;
};

const loadDotEnv = (root) => {
  const envPath = join(root, ".env");
  return existsSync(envPath) ? parseDotEnv(readFileSync(envPath, "utf8")) : {};
};

const summarizeIdp = (idp) => ({
  id: idp?.id,
  type: idp?.type,
  name: idp?.name,
});

const summarizeApp = (app) => ({
  id: app?.id,
  name: app?.name,
  type: app?.type,
  oauthEnabled: Boolean(app?.oauth_configuration?.enabled),
  hasAud: typeof app?.aud === "string" && app.aud.trim().length > 0,
  destinationTypes: Array.isArray(app?.destinations)
    ? app.destinations.map((destination) => destination?.type).filter(Boolean)
    : [],
  allowedIdpCount: Array.isArray(app?.allowed_idps) ? app.allowed_idps.length : 0,
});

const createClient = ({ accountId, token }) => {
  const request = async (path, { method = "GET", body } = {}) => {
    const response = await fetch(`${API_BASE}/accounts/${accountId}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => null);
    return { status: response.status, data };
  };
  return { request };
};

const readResultList = (data) => (Array.isArray(data?.result) ? data.result : []);

const ensureIdentityProvider = async ({ client, type, name, body, existing, checkOnly }) => {
  const found =
    existing.find((idp) => idp?.type === type) || existing.find((idp) => idp?.name === name);
  if (found) {
    return { idp: found, created: false };
  }
  if (checkOnly) {
    return { idp: undefined, created: false, missing: true };
  }
  const { status, data } = await client.request("access/identity_providers", {
    method: "POST",
    body,
  });
  if (!data?.success || !data.result?.id) {
    throw new Error(
      describeAccessApiError({
        status,
        errors: data?.errors || [],
        resource: "identity_providers",
      }),
    );
  }
  return { idp: data.result, created: true };
};

const upsertAccessApp = async ({ client, body, existing, checkOnly }) => {
  const found = existing.find((app) => app?.name === body.name);
  if (checkOnly) {
    return { app: found, created: false, updated: false, missing: !found };
  }
  if (!found) {
    const { status, data } = await client.request("access/apps", {
      method: "POST",
      body,
    });
    if (!data?.success || !data.result?.id) {
      throw new Error(
        describeAccessApiError({
          status,
          errors: data?.errors || [],
          resource: "apps",
        }),
      );
    }
    return { app: data.result, created: true, updated: false };
  }
  const current = await client.request(`access/apps/${found.id}`);
  if (!current.data?.success || !current.data.result) {
    throw new Error(
      describeAccessApiError({
        status: current.status,
        errors: current.data?.errors || [],
        resource: "apps",
      }),
    );
  }
  const merged = {
    ...current.data.result,
    ...body,
    oauth_configuration: {
      ...(current.data.result.oauth_configuration || {}),
      ...(body.oauth_configuration || {}),
      enabled: true,
    },
  };
  delete merged.id;
  delete merged.aud;
  delete merged.created_at;
  delete merged.updated_at;
  const { status, data } = await client.request(`access/apps/${found.id}`, {
    method: "PUT",
    body: merged,
  });
  if (!data?.success || !data.result?.id) {
    throw new Error(
      describeAccessApiError({
        status,
        errors: data?.errors || [],
        resource: "apps",
      }),
    );
  }
  return { app: data.result, created: false, updated: true };
};

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const planAccessSetup = ({ env = process.env, dotenv = {} } = {}) => {
  const accountId = resolveAccountId({ env, dotenv });
  const tokenResolution = resolveCloudflareApiToken({ env, envFileContents: undefined });
  const dotenvToken = resolveCloudflareApiToken({
    env: {},
    envFileContents: Object.entries(dotenv)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
  });
  const googleEnabled = hasGoogleOAuthCredentials({ env, dotenv });
  return {
    accountId,
    tokenSource: tokenResolution.source || dotenvToken.source,
    googleEnabled,
    allowEmails: parseCsvList(
      env.ACCESS_ALLOW_EMAILS || dotenv.ACCESS_ALLOW_EMAILS,
      DEFAULT_ALLOW_EMAILS,
    ),
    allowEmailDomains: parseCsvList(
      env.ACCESS_ALLOW_EMAIL_DOMAINS || dotenv.ACCESS_ALLOW_EMAIL_DOMAINS,
      DEFAULT_ALLOW_EMAIL_DOMAINS,
    ),
  };
};

const run = async () => {
  const checkOnly = process.argv.includes("--check");
  const dotenv = loadDotEnv(repositoryRoot);
  const plan = planAccessSetup({ env: process.env, dotenv });
  if (!plan.accountId) {
    console.error("FAIL: CLOUDFLARE_ACCOUNT_ID is required (do not put it in wrangler.jsonc).");
    return 2;
  }
  const resolvedToken = resolveCloudflareApiToken({
    env: process.env,
    envFileContents: existsSync(join(repositoryRoot, ".env"))
      ? readFileSync(join(repositoryRoot, ".env"), "utf8")
      : undefined,
  });
  if (!resolvedToken.token) {
    console.error("FAIL: CLOUDFLARE_API_TOKEN (or CLOUDFLARE_DEBUG_TOKEN) is required.");
    return 2;
  }
  console.log(
    `Access setup ${checkOnly ? "check" : "apply"} account=${plan.accountId} token=${resolvedToken.source} google=${plan.googleEnabled ? "env" : "skip"}`,
  );

  const client = createClient({ accountId: plan.accountId, token: resolvedToken.token });
  const workersResponse = await client.request("workers/workers");
  if (!workersResponse.data?.success) {
    throw new Error(
      describeAccessApiError({
        status: workersResponse.status,
        errors: workersResponse.data?.errors || [],
        resource: "workers",
      }),
    );
  }
  const workers = readResultList(workersResponse.data);
  const compareWorkerId = resolveWorkerIdFromList(workers, COMPARE_WORKER_NAME);
  const inferenceWorkerId = resolveWorkerIdFromList(workers, INFERENCE_WORKER_NAME);
  if (!compareWorkerId || !inferenceWorkerId) {
    console.error(
      `FAIL: Worker IDs missing (compare=${Boolean(compareWorkerId)} inference=${Boolean(inferenceWorkerId)}). Deploy both Workers first.`,
    );
    return 2;
  }

  const idpResponse = await client.request("access/identity_providers");
  const idpWriteBlocked = idpResponse.status === 403;
  if (idpWriteBlocked) {
    console.warn(
      describeAccessApiError({
        status: 403,
        errors: idpResponse.data?.errors || [],
        resource: "identity_providers",
      }),
    );
    console.warn(
      "Continuing Access app setup without restricting IdPs. Rerun after granting the permission.",
    );
  } else if (!idpResponse.data?.success) {
    throw new Error(
      describeAccessApiError({
        status: idpResponse.status,
        errors: idpResponse.data?.errors || [],
        resource: "identity_providers",
      }),
    );
  }
  let identityProviders = idpWriteBlocked ? [] : readResultList(idpResponse.data);
  const otpResult = idpWriteBlocked
    ? { idp: undefined, created: false, missing: true }
    : await ensureIdentityProvider({
        client,
        type: "onetimepin",
        name: OTP_IDP_NAME,
        body: buildOtpIdentityProviderBody(),
        existing: identityProviders,
        checkOnly,
      });
  if (otpResult.idp && otpResult.created) {
    identityProviders = [...identityProviders, otpResult.idp];
  }
  let googleResult = {
    idp: identityProviders.find((idp) => idp?.type === "google"),
    created: false,
  };
  if (plan.googleEnabled && !idpWriteBlocked) {
    googleResult = await ensureIdentityProvider({
      client,
      type: "google",
      name: GOOGLE_IDP_NAME,
      body: buildGoogleIdentityProviderBody({
        clientId: (
          process.env.GOOGLE_OAUTH_CLIENT_ID ||
          dotenv.GOOGLE_OAUTH_CLIENT_ID ||
          ""
        ).trim(),
        clientSecret: (
          process.env.GOOGLE_OAUTH_CLIENT_SECRET ||
          dotenv.GOOGLE_OAUTH_CLIENT_SECRET ||
          ""
        ).trim(),
      }),
      existing: identityProviders,
      checkOnly,
    });
    if (googleResult.idp && googleResult.created) {
      identityProviders = [...identityProviders, googleResult.idp];
    }
  } else if (!plan.googleEnabled) {
    console.log(
      "Google IdP skipped (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET not set).",
    );
  }

  const allowedIdps = selectAllowedIdpIds({
    identityProviders,
    includeGoogle: plan.googleEnabled,
  });
  if (!checkOnly && allowedIdps.length === 0) {
    console.warn(
      "OTP IdP id unavailable; Access apps will use every IdP configured on the account until rerun.",
    );
  }

  const appsResponse = await client.request("access/apps");
  if (!appsResponse.data?.success) {
    throw new Error(
      describeAccessApiError({
        status: appsResponse.status,
        errors: appsResponse.data?.errors || [],
        resource: "apps",
      }),
    );
  }
  const existingApps = readResultList(appsResponse.data);
  const compareBody = buildSelfHostedWorkerAppBody({
    name: COMPARE_APP_NAME,
    workerId: compareWorkerId,
    publicHost: COMPARE_PUBLIC_HOST,
    destinationKind: "public",
    policies: [
      buildTeadeaAllowPolicy({ emails: plan.allowEmails, domains: plan.allowEmailDomains }),
    ],
    allowedIdps,
  });
  const inferenceBody = buildSelfHostedWorkerAppBody({
    name: INFERENCE_APP_NAME,
    workerId: inferenceWorkerId,
    publicHost: INFERENCE_PUBLIC_HOST,
    destinationKind: "worker",
    policies: [buildPublicDenyPolicy()],
    allowedIdps,
  });
  const compareApp = await upsertAccessApp({
    client,
    body: compareBody,
    existing: existingApps,
    checkOnly,
  });
  let inferenceApp = { app: undefined, created: false, updated: false, missing: true };
  try {
    inferenceApp = await upsertAccessApp({
      client,
      body: inferenceBody,
      existing: existingApps,
      checkOnly,
    });
  } catch (error) {
    console.warn(
      `Inference Access app skipped (public hostname stays closed): ${
        error instanceof Error ? error.message : error
      }`,
    );
  }

  const orgResponse = await client.request("access/organizations");
  const organization = orgResponse.data?.success
    ? orgResponse.data.result
    : Array.isArray(orgResponse.data?.result)
      ? orgResponse.data.result[0]
      : undefined;
  const jwtBindings = resolveAccessJwtBindings({
    app: compareApp.app,
    organization,
  });

  console.log(
    JSON.stringify(
      {
        checkOnly,
        googleIdp: plan.googleEnabled ? "enabled-or-present" : "skipped",
        otp: summarizeIdp(otpResult.idp),
        google: summarizeIdp(googleResult.idp),
        compare: summarizeApp(compareApp.app),
        inference: summarizeApp(inferenceApp.app),
        teamDomainConfigured: Boolean(resolveAccessTeamDomain(organization)),
        jwtBindingsReady: Boolean(jwtBindings),
        missing: {
          otp: Boolean(otpResult.missing),
          google: plan.googleEnabled && Boolean(googleResult.missing),
          compare: Boolean(compareApp.missing),
          inference: Boolean(inferenceApp.missing),
        },
      },
      null,
      2,
    ),
  );
  if (
    checkOnly &&
    (otpResult.missing || compareApp.missing || (plan.googleEnabled && googleResult.missing))
  ) {
    return 1;
  }
  if (!checkOnly && compareApp.missing) {
    return 1;
  }
  if (idpWriteBlocked) {
    return 3;
  }
  return 0;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
