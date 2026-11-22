/**
 * S8 review (spec §7.9): owner pages refuse to be framed (clickjacking). worker/index.ts applies this to
 * every response from the app router. Share routes never reach it: worker/share.ts sets their framing
 * itself, and `/s/:token/embed` is the one page any site may frame.
 *
 * Only HTML documents are changed. An existing Content-Security-Policy is kept: `frame-ancestors 'none'`
 * is appended unless the policy already has a `frame-ancestors` directive, and an existing
 * X-Frame-Options is left as it is.
 */
export function refuseFraming(response: Response): Response {
  if (!/^\s*text\/html\b/i.test(response.headers.get("content-type") ?? "")) return response;
  const csp = response.headers.get("content-security-policy");
  const hasAncestors = csp != null && /(^|;)\s*frame-ancestors(\s|;|$)/i.test(csp);
  const hasXfo = response.headers.has("x-frame-options");
  if (hasAncestors && hasXfo) return response;
  // A copy, because a fetched or framework response's headers may be immutable.
  const framed = new Response(response.body, response);
  if (!hasAncestors) framed.headers.set("Content-Security-Policy", csp?.trim() ? `${csp.trim().replace(/;\s*$/, "")}; frame-ancestors 'none'` : "frame-ancestors 'none'");
  if (!hasXfo) framed.headers.set("X-Frame-Options", "DENY");
  return framed;
}
