import { createRemoteJWKSet, type JWTVerifyGetKey, type JWTVerifyResult, jwtVerify } from "jose";

export const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";
export const ACCESS_JWT_UNAUTHORIZED_STATUS = 401;

export type AccessJwtEnv = {
  POLICY_AUD?: string;
  TEAM_DOMAIN?: string;
};

export type AccessJwtConfig = {
  policyAud: string;
  teamDomain: string;
  certsUrl: string;
};

export type AccessJwtMode =
  | { status: "disabled" }
  | { status: "incomplete" }
  | { status: "enabled"; config: AccessJwtConfig };

export type AccessJwtVerifyFn = (token: string, config: AccessJwtConfig) => Promise<unknown>;

export const normalizeTeamDomain = (value: string): string => value.trim().replace(/\/+$/u, "");

export const resolveAccessJwtMode = (env: AccessJwtEnv): AccessJwtMode => {
  const policyAud = env.POLICY_AUD?.trim() ?? "";
  const teamDomainRaw = env.TEAM_DOMAIN?.trim() ?? "";
  if (!policyAud && !teamDomainRaw) {
    return { status: "disabled" };
  }
  if (!policyAud || !teamDomainRaw) {
    return { status: "incomplete" };
  }
  const teamDomain = normalizeTeamDomain(teamDomainRaw);
  return {
    status: "enabled",
    config: {
      policyAud,
      teamDomain,
      certsUrl: `${teamDomain}/cdn-cgi/access/certs`,
    },
  };
};

export const readAccessJwtAssertion = (request: Request): string | null => {
  const token = request.headers.get(ACCESS_JWT_HEADER)?.trim();
  return token && token.length > 0 ? token : null;
};

export const accessJwtUnauthorizedResponse = (message: string): Response =>
  new Response(message, {
    status: ACCESS_JWT_UNAUTHORIZED_STATUS,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "WWW-Authenticate": "Bearer",
    },
  });

export type CreateAccessJwks = (url: URL) => JWTVerifyGetKey;
export type VerifyAccessJwtToken = (
  token: string,
  key: JWTVerifyGetKey,
  options: { issuer: string; audience: string },
) => Promise<JWTVerifyResult>;

export const createJoseAccessJwtVerifier = (
  createJwks: CreateAccessJwks = createRemoteJWKSet,
  verify: VerifyAccessJwtToken = jwtVerify,
): AccessJwtVerifyFn => {
  const jwksByCertsUrl = new Map<string, JWTVerifyGetKey>();
  return async (token, config) => {
    let jwks = jwksByCertsUrl.get(config.certsUrl);
    if (!jwks) {
      jwks = createJwks(new URL(config.certsUrl));
      jwksByCertsUrl.set(config.certsUrl, jwks);
    }
    await verify(token, jwks, {
      issuer: config.teamDomain,
      audience: config.policyAud,
    });
  };
};

export const verifyAccessJwtWithJose = createJoseAccessJwtVerifier();

export const enforceAccessJwt = async (
  request: Request,
  env: AccessJwtEnv,
  verify: AccessJwtVerifyFn = verifyAccessJwtWithJose,
): Promise<Response | null> => {
  const mode = resolveAccessJwtMode(env);
  if (mode.status === "disabled") {
    return null;
  }
  if (mode.status === "incomplete") {
    return accessJwtUnauthorizedResponse("Access JWT configuration incomplete");
  }
  const token = readAccessJwtAssertion(request);
  if (!token) {
    return accessJwtUnauthorizedResponse("Missing required CF Access JWT");
  }
  try {
    await verify(token, mode.config);
    return null;
  } catch {
    return accessJwtUnauthorizedResponse("Invalid CF Access JWT");
  }
};
