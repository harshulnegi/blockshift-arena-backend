const COUNTRY_HEADER_NAMES = [
  "cf-ipcountry",
  "x-vercel-ip-country",
  "x-appengine-country",
  "cloudfront-viewer-country",
  "x-country-code",
  "x-geo-country"
];

export function detectCountryFromRequest(req, fallbackCountry = "GLOBAL") {
  const edgeCountry = firstHeaderCountry(req);
  if (edgeCountry) return { country: edgeCountry, source: "ip-edge" };
  const fallback = normalizeCountryCode(fallbackCountry);
  if (fallback && fallback !== "GLOBAL") return { country: fallback, source: "device-locale" };
  return { country: "GLOBAL", source: privateOrLocalIp(clientIp(req)) ? "local-network" : "unknown" };
}

export function resolveProfileCountry(req, requestedCountry, fallbackCountry = "GLOBAL") {
  const requested = normalizeCountryCode(requestedCountry);
  if (requested && requested !== "GLOBAL") return requested;
  return detectCountryFromRequest(req, fallbackCountry).country;
}

export function normalizeCountryCode(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw || raw === "GLOBAL") return "GLOBAL";
  const compact = raw.replace(/[^A-Z]/g, "");
  return compact.length === 2 ? compact : "GLOBAL";
}

function firstHeaderCountry(req) {
  for (const name of COUNTRY_HEADER_NAMES) {
    const value = req.get?.(name) || req.headers?.[name];
    const country = normalizeCountryCode(Array.isArray(value) ? value[0] : value);
    if (country && country !== "GLOBAL" && country !== "XX") return country;
  }
  return null;
}

function clientIp(req) {
  const forwarded = String(req.get?.("x-forwarded-for") || "").split(",")[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || "";
}

function privateOrLocalIp(ip) {
  const clean = String(ip || "").replace(/^::ffff:/, "");
  return clean === "::1" ||
    clean === "127.0.0.1" ||
    clean.startsWith("10.") ||
    clean.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(clean);
}
