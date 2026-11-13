import dns from "dns";
import net from "net";

// uploadHandler's `url` field (fileStorage.ts) lets any authenticated caller
// have this server make an outbound GET to a URL *they* supply — avatars,
// store logos, portfolio media, tender attachments, digital-product
// deliverables all accept it. With no restriction, that's a full SSRF
// primitive: an attacker can point it at the cloud metadata endpoint, an
// internal-only service, or a loopback port, and (if the response happens
// to pass the caller's mime allowlist) get the fetched bytes republished
// under this app's own /public URL — confirmed live against a local
// listener. This blocks the private/loopback/link-local ranges and
// anything that isn't plain http(s); it does NOT stop DNS-rebinding (a
// name that resolves to a public IP at check-time and a private one at
// request-time) since axios does its own independent lookup after this
// check passes, but that's a narrow, hard-to-land attack compared to the
// wide-open "any RFC1918/loopback host" hole this closes.
const isBlockedIp = (ip: string): boolean => {
  const family = net.isIP(ip);

  if (family === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 0) return true; // "this network"
    return false;
  }

  if (family === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === "::1") return true; // loopback
    if (normalized.startsWith("fe80:") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true; // link-local
    if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true; // unique local (fc00::/7)
    if (normalized.startsWith("::ffff:")) return isBlockedIp(normalized.slice(7)); // IPv4-mapped
    return false;
  }

  return true; // couldn't parse as an IP at all — refuse rather than guess
};

export const assertPublicHttpUrl = async (rawUrl: string): Promise<void> => {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http/https URLs are allowed");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost") {
    throw new Error("URL resolves to a disallowed host");
  }

  const literalFamily = net.isIP(hostname);
  if (literalFamily) {
    if (isBlockedIp(hostname)) throw new Error("URL resolves to a disallowed host");
    return;
  }

  const records = await dns.promises.lookup(hostname, { all: true, verbatim: true }).catch(() => []);
  if (records.length === 0) throw new Error("URL host could not be resolved");

  if (records.some((record) => isBlockedIp(record.address))) {
    throw new Error("URL resolves to a disallowed host");
  }
};
