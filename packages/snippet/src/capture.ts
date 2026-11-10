/**
 * Pure capture helpers shared with server-side tools (e.g. the site scanner),
 * so every path that records traffic applies identical normalisation and redaction.
 */
export { intentOf, parseBody, type ParsedBody } from "./body.ts";
export { describeFields, scrub, shapeOf } from "./redact.ts";
export { normalizeUrl, pathMatches, routeKeysOf, type NormalizedUrl } from "./url.ts";
export { readMessage } from "./socket.ts";
