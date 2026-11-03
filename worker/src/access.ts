import type { MiddlewareHandler } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./env";
import { errorFields, log } from "./logger";

const jwksByDomain = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(teamOrigin: string) {
  let jwks = jwksByDomain.get(teamOrigin);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${teamOrigin}/cdn-cgi/access/certs`));
    jwksByDomain.set(teamOrigin, jwks);
  }
  return jwks;
}

// Access を経由しない経路(workers.dev など)からのアクセスを拒否する
export const requireAccess: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (c.env.DEV_SKIP_ACCESS === "true") {
    await next();
    return;
  }
  const token = c.req.header("Cf-Access-Jwt-Assertion");
  if (!token) {
    log.warn("access.missing_token", { path: c.req.path });
    return c.json({ error: "unauthorized" }, 401);
  }
  try {
    const domain = c.env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const issuer = `https://${domain}`;
    await jwtVerify(token, getJwks(issuer), { issuer, audience: c.env.ACCESS_AUD });
  } catch (err) {
    log.warn("access.invalid_token", { path: c.req.path, ...errorFields(err) });
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
};
