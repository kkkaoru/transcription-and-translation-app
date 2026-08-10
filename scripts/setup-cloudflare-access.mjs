#!/usr/bin/env node
/**
 * Idempotent Cloudflare Access setup for the hosted compare UI and inference Worker.
 *
 * Creates OTP (and Google when env credentials exist), then self-hosted apps with
 * Managed OAuth. Inference stays closed to the public internet; compare allows only
 * configured allow emails/domains (teadea + avita) plus a Service Auth policy
 * for the verify
 * Service Token. Secrets are never printed.
 *
 * Usage:
 *   node scripts/setup-cloudflare-access.mjs
 *   node scripts/setup-cloudflare-access.mjs --check
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDotEnv, resolveCloudflareApiToken } from "./setup-cursor-cloudflare-mcp.mjs";

const API_BASE = "https://api.cloudflare.com/client/v4";
const OTP_IDP_NAME = "One-time PIN login";
const GOOGLE_IDP_NAME = "Google";
const IDP_WRITE_PERMISSION = "Access: Organizations, Identity Providers, and Groups Edit";
const APPS_WRITE_PERMISSION = "Access: Apps and Policies Edit";
const SERVICE_TOKEN_WRITE_PERMISSION = "Access: Service Tokens Write";

export const COMPARE_VERIFY_SERVICE_TOKEN_NAME = "cursor-azookey-compare-verify";
export const COMPARE_SERVICE_AUTH_POLICY_NAME = "cursor verify service auth";
export const CF_ACCESS_CLIENT_ID_KEY = "CF_ACCESS_CLIENT_ID";
export const CF_ACCESS_CLIENT_SECRET_KEY = "CF_ACCESS_CLIENT_SECRET";
export const SERVICE_TOKEN_DURATION = "8760h";

export const COMPARE_WORKER_NAME = "azookey-compare";
export const INFERENCE_WORKER_NAME = "kotoba-beacon-inference";
export const COMPARE_APP_NAME = "azookey-compare";
export const INFERENCE_APP_NAME = "kotoba-beacon-inference";
export const COMPARE_PUBLIC_HOST = "azookey-compare.kaoru.workers.dev";
export const INFERENCE_PUBLIC_HOST = "kotoba-beacon-inference.kaoru.workers.dev";
export const DEFAULT_ALLOW_EMAILS = ["kaoru@teadea.net"];
export const DEFAULT_ALLOW_EMAIL_DOMAINS = ["teadea.net", "avita.co.jp"];

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

export const buildServiceAuthPolicy = ({ tokenId }) => ({
  name: COMPARE_SERVICE_AUTH_POLICY_NAME,
  decision: "non_identity",
  include: [{ service_token: { token_id: tokenId } }],
});

const isEveryoneRule = (rule) =>
  Boolean(rule && typeof rule === "object" && rule.everyone && typeof rule.everyone === "object");

const isLoginMethodRule = (rule) =>
  Boolean(
    rule && typeof rule === "object" && rule.login_method && typeof rule.login_method === "object",
  );

const isAnyValidServiceTokenRule = (rule) =>
  Boolean(
    rule &&
      typeof rule === "object" &&
      rule.any_valid_service_token &&
      typeof rule.any_valid_service_token === "object",
  );

const serviceTokenIdFromRule = (rule) => {
  const tokenId = rule?.service_token?.token_id;
  return typeof tokenId === "string" && tokenId.trim() ? tokenId.trim() : undefined;
};

export const assertPolicyIsNotWorldOpen = (policy) => {
  if (!policy || typeof policy !== "object") {
    throw new Error("Access policy is missing");
  }
  const include = Array.isArray(policy.include) ? policy.include : [];
  if (policy.decision === "non_identity") {
    if (include.some(isEveryoneRule)) {
      throw new Error("Service Auth policy must not include everyone");
    }
    if (include.some(isAnyValidServiceTokenRule)) {
      throw new Error("Service Auth policy must not allow any valid service token");
    }
    if (!include.some(serviceTokenIdFromRule)) {
      throw new Error("Service Auth policy must include a specific service token");
    }
    return;
  }
  if (policy.decision !== "allow") {
    return;
  }
  if (include.some(isEveryoneRule)) {
    throw new Error("Allow policy must not include everyone");
  }
  if (include.some(isLoginMethodRule) && include.every(isLoginMethodRule)) {
    throw new Error("Allow policy must not be login_method-only (world-open OTP)");
  }
};

export const upsertDotEnvAssignments = (contents, assignments) => {
  const parsed = parseDotEnv(contents);
  let lines = contents.length > 0 ? contents.split(/\r?\n/) : [];
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines = lines.slice(0, -1);
  }
  /** @type {string[]} */
  const appended = [];
  /** @type {string[]} */
  const reused = [];
  /** @type {string[]} */
  const replaced = [];
  for (const [key, value] of Object.entries(assignments)) {
    if (!present(value)) {
      continue;
    }
    if (present(parsed[key])) {
      reused.push(key);
      continue;
    }
    const index = lines.findIndex((line) => {
      const trimmed = line.trim();
      return trimmed === key || trimmed.startsWith(`${key}=`);
    });
    if (index >= 0) {
      lines[index] = `${key}=${value}`;
      replaced.push(key);
    } else {
      lines.push(`${key}=${value}`);
      appended.push(key);
    }
  }
  return {
    contents: lines.length > 0 ? `${lines.join("\n")}\n` : "",
    appended,
    reused,
    replaced,
  };
};

export const writeDotEnvAssignments = (envPath, assignments) => {
  const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const result = upsertDotEnvAssignments(current, assignments);
  if (result.appended.length === 0 && result.replaced.length === 0) {
    return result;
  }
  writeFileSync(envPath, result.contents, { encoding: "utf8" });
  try {
    chmodSync(envPath, 0o600);
  } catch {
    // Windows and some shared FS mounts do not support POSIX modes.
  }
  return result;
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
        : resource === "service_tokens"
          ? SERVICE_TOKEN_WRITE_PERMISSION
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
  policyDecisions: Array.isArray(app?.policies)
    ? app.policies.map((policy) => policy?.decision).filter(Boolean)
    : [],
});

const summarizeServiceToken = (token) => ({
  id: token?.id,
  name: token?.name,
  hasClientId: typeof token?.client_id === "string" && token.client_id.trim().length > 0,
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

export const selectServiceTokenByName = (tokens, name = COMPARE_VERIFY_SERVICE_TOKEN_NAME) =>
  (tokens || []).find((token) => token?.name === name);

export const buildCompareAccessPolicies = ({
  emails = DEFAULT_ALLOW_EMAILS,
  domains = DEFAULT_ALLOW_EMAIL_DOMAINS,
  serviceTokenId,
} = {}) => {
  const policies = [buildTeadeaAllowPolicy({ emails, domains })];
  if (present(serviceTokenId)) {
    policies.push(buildServiceAuthPolicy({ tokenId: serviceTokenId }));
  }
  return policies;
};

export const ensureCompareVerifyServiceToken = async ({
  client,
  existing,
  dotenv = {},
  checkOnly,
}) => {
  const found = selectServiceTokenByName(existing);
  const localClientId = (dotenv[CF_ACCESS_CLIENT_ID_KEY] || "").trim();
  const localSecret = (dotenv[CF_ACCESS_CLIENT_SECRET_KEY] || "").trim();
  if (found) {
    if (checkOnly) {
      return {
        token: found,
        created: false,
        rotated: false,
        missingSecret: !present(localSecret),
      };
    }
    if (present(localSecret)) {
      return {
        token: {
          ...found,
          client_id: present(found.client_id) ? found.client_id : localClientId || undefined,
        },
        clientSecret: localSecret,
        created: false,
        rotated: false,
        reusedSecret: true,
      };
    }
    const { status, data } = await client.request(`access/service_tokens/${found.id}/rotate`, {
      method: "POST",
    });
    if (status === 403 || !data?.success || !data.result?.id) {
      return {
        token: found,
        created: false,
        rotated: false,
        forbidden: status === 403,
        missingSecret: true,
        error: describeAccessApiError({
          status,
          errors: data?.errors || [],
          resource: "service_tokens",
        }),
      };
    }
    return {
      token: data.result,
      clientSecret: data.result?.client_secret,
      created: false,
      rotated: true,
    };
  }
  if (checkOnly) {
    return {
      token: undefined,
      created: false,
      missing: true,
      missingSecret: !present(localSecret),
    };
  }
  const { status, data } = await client.request("access/service_tokens", {
    method: "POST",
    body: {
      name: COMPARE_VERIFY_SERVICE_TOKEN_NAME,
      duration: SERVICE_TOKEN_DURATION,
    },
  });
  if (status === 403 || !data?.success || !data.result?.id) {
    return {
      token: undefined,
      created: false,
      missing: true,
      forbidden: status === 403,
      error: describeAccessApiError({
        status,
        errors: data?.errors || [],
        resource: "service_tokens",
      }),
    };
  }
  return {
    token: data.result,
    clientSecret: data.result?.client_secret,
    created: true,
    rotated: false,
  };
};

const persistServiceTokenDotEnv = ({ envPath, token, clientSecret }) => {
  /** @type {Record<string, string>} */
  const assignments = {};
  if (present(token?.client_id)) {
    assignments[CF_ACCESS_CLIENT_ID_KEY] = token.client_id.trim();
  }
  if (present(clientSecret)) {
    assignments[CF_ACCESS_CLIENT_SECRET_KEY] = clientSecret.trim();
  }
  if (Object.keys(assignments).length === 0) {
    return { appended: [], reused: [], replaced: [] };
  }
  return writeDotEnvAssignments(envPath, assignments);
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

  const tokensResponse = await client.request("access/service_tokens");
  const serviceTokensWriteBlocked = tokensResponse.status === 403;
  if (serviceTokensWriteBlocked) {
    console.warn(
      describeAccessApiError({
        status: 403,
        errors: tokensResponse.data?.errors || [],
        resource: "service_tokens",
      }),
    );
    console.warn(
      "Continuing Access app setup without the compare Service Auth policy. Rerun after granting the permission.",
    );
  } else if (!tokensResponse.data?.success) {
    throw new Error(
      describeAccessApiError({
        status: tokensResponse.status,
        errors: tokensResponse.data?.errors || [],
        resource: "service_tokens",
      }),
    );
  }
  const existingServiceTokens = serviceTokensWriteBlocked
    ? []
    : readResultList(tokensResponse.data);
  const serviceTokenResult = serviceTokensWriteBlocked
    ? { token: undefined, created: false, missing: true, forbidden: true }
    : await ensureCompareVerifyServiceToken({
        client,
        existing: existingServiceTokens,
        dotenv,
        checkOnly,
      });
  if (serviceTokenResult.error) {
    console.warn(serviceTokenResult.error);
  }
  if (!checkOnly && serviceTokenResult.token && present(serviceTokenResult.clientSecret)) {
    const written = persistServiceTokenDotEnv({
      envPath: join(repositoryRoot, ".env"),
      token: serviceTokenResult.token,
      clientSecret: serviceTokenResult.clientSecret,
    });
    console.log(
      `dotenv Access ST keys: client_id=${
        written.reused.includes(CF_ACCESS_CLIENT_ID_KEY)
          ? "reused"
          : written.appended.includes(CF_ACCESS_CLIENT_ID_KEY) ||
              written.replaced.includes(CF_ACCESS_CLIENT_ID_KEY)
            ? "written"
            : "unchanged"
      } client_secret=${
        written.reused.includes(CF_ACCESS_CLIENT_SECRET_KEY)
          ? "reused"
          : written.appended.includes(CF_ACCESS_CLIENT_SECRET_KEY) ||
              written.replaced.includes(CF_ACCESS_CLIENT_SECRET_KEY)
            ? "written"
            : "unchanged"
      }`,
    );
  } else if (!checkOnly && serviceTokenResult.missingSecret) {
    console.warn(
      "Access Service Token secret is not in .env and could not be recovered. Verify will skip authenticated checks.",
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
    policies: buildCompareAccessPolicies({
      emails: plan.allowEmails,
      domains: plan.allowEmailDomains,
      serviceTokenId: serviceTokenResult.token?.id,
    }),
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
        serviceToken: summarizeServiceToken(serviceTokenResult.token),
        serviceTokenCreated: Boolean(serviceTokenResult.created),
        serviceTokenRotated: Boolean(serviceTokenResult.rotated),
        serviceTokenReusedSecret: Boolean(serviceTokenResult.reusedSecret),
        teamDomainConfigured: Boolean(resolveAccessTeamDomain(organization)),
        jwtBindingsReady: Boolean(jwtBindings),
        missing: {
          otp: Boolean(otpResult.missing),
          google: plan.googleEnabled && Boolean(googleResult.missing),
          compare: Boolean(compareApp.missing),
          inference: Boolean(inferenceApp.missing),
          serviceToken: Boolean(serviceTokenResult.missing),
        },
      },
      null,
      2,
    ),
  );
  if (
    checkOnly &&
    (otpResult.missing ||
      compareApp.missing ||
      serviceTokenResult.missing ||
      (plan.googleEnabled && googleResult.missing))
  ) {
    return 1;
  }
  if (!checkOnly && compareApp.missing) {
    return 1;
  }
  if (idpWriteBlocked || serviceTokensWriteBlocked || serviceTokenResult.forbidden) {
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
