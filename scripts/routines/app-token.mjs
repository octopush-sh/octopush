#!/usr/bin/env node
// Mint a read-only installation token of the "Octopush Cycle" GitHub App for
// octopush-web, for a job that must NOT see the App's private key
// (web-audit.yml: the job that builds and renders the website runs the
// website's own code, so it gets only this token, revokes it before the build,
// and never holds the key — every secret a job references is on its runner).
//
//   OCTOPUSH_APP_ID=… OCTOPUSH_APP_PRIVATE_KEY=… node app-token.mjs read-token
//
// Prints the token on stdout (the caller writes it to a job output; the
// receiving job masks it first thing). `actions/create-github-app-token` can't
// be used for this: it masks its token, and GitHub drops masked job outputs.
// The token: octopush-web only, `contents: read` only, valid ≤ 1 h.
import { createSign } from "node:crypto";

const API = "https://api.github.com";
export const WEB_OWNER = "octopush-sh";
export const WEB_NAME = "octopush-web";
export const READ_PERMISSIONS = { contents: "read" };

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** The App's JWT (RS256, 9 minutes, backdated 60 s for clock skew) — pure, tested. */
export function appJwt(appId, privateKey, now = Math.floor(Date.now() / 1000)) {
  if (!/^\d+$/.test(String(appId ?? ""))) throw new Error("OCTOPUSH_APP_ID must be the numeric App ID");
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: String(appId) }));
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey);
  return `${head}.${body}.${b64url(sig)}`;
}

/** The access-token request: this one repo, read-only contents (pure, tested). */
export const tokenRequest = () => ({ repositories: [WEB_NAME], permissions: READ_PERMISSIONS });

async function call(method, path, jwt, body) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "octopush-cycle" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status}`); // never echo the response (it may hold a token)
  return JSON.parse(text);
}

async function main() {
  if (process.argv[2] !== "read-token") { console.error("usage: app-token.mjs read-token"); return 64; }
  const key = process.env.OCTOPUSH_APP_PRIVATE_KEY;
  if (!key) throw new Error("OCTOPUSH_APP_PRIVATE_KEY is not set");
  const jwt = appJwt(process.env.OCTOPUSH_APP_ID, key);
  const inst = await call("GET", `/repos/${WEB_OWNER}/${WEB_NAME}/installation`, jwt);
  const tok = await call("POST", `/app/installations/${inst.id}/access_tokens`, jwt, tokenRequest());
  if (!/^ghs_[A-Za-z0-9]+$/.test(tok.token ?? "")) throw new Error("unexpected token shape");
  const perms = Object.entries(tok.permissions ?? {}).filter(([k]) => k !== "metadata");
  if (perms.some(([k, v]) => k !== "contents" || v !== "read")) throw new Error("the token came back with more than contents:read — refusing");
  process.stdout.write(tok.token);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c), (e) => { console.error(`app-token: ${e.message}`); process.exit(2); });
}
