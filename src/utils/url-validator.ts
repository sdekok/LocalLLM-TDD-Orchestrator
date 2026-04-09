import { isIP } from 'net';
import dns from 'dns/promises';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
  'metadata.google.internal', // GCP metadata
  '169.254.169.254',          // AWS/GCP/Azure IMDS endpoint
]);

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Validate that a URL is safe to fetch — blocks SSRF vectors including:
 *   - Non-http/https protocols (file://, ftp://, etc.)
 *   - Known internal hostnames (localhost, metadata services)
 *   - Literal private/loopback IP addresses
 *   - Hostnames that DNS-resolve to private IP ranges
 *
 * DNS resolution is attempted with a 3 s timeout and fails open (allows the
 * request) when the hostname cannot be resolved, so legitimate public URLs
 * are never blocked due to transient DNS issues.
 */
export async function validateExternalUrl(urlString: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error(`Invalid URL: ${urlString}`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error(`Blocked protocol "${url.protocol}" in URL: ${urlString}`);
  }

  // Strip IPv6 brackets before checking (e.g. [::1] → ::1)
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error(`Blocked internal hostname: ${hostname}`);
  }

  // Check literal IP addresses (no DNS lookup needed)
  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    if (isPrivateIPv4(hostname)) {
      throw new Error(`Blocked private IPv4 address: ${hostname}`);
    }
    return url;
  }
  if (ipVersion === 6) {
    if (isPrivateIPv6(hostname)) {
      throw new Error(`Blocked private IPv6 address: ${hostname}`);
    }
    return url;
  }

  // Resolve hostname to IPs and check each
  let addresses: string[] = [];
  try {
    addresses = await Promise.race<string[]>([
      dns.resolve4(hostname),
      new Promise<string[]>((_, reject) =>
        setTimeout(() => reject(new Error('DNS timeout')), 3_000)
      ),
    ]);
  } catch {
    // DNS failed or timed out — fail open so legitimate public URLs aren't
    // blocked due to transient network issues. The protocol + hostname
    // blocklist above already covers the most dangerous cases.
    return url;
  }

  for (const addr of addresses) {
    if (isPrivateIPv4(addr)) {
      throw new Error(`Blocked: "${hostname}" resolved to private IP ${addr}`);
    }
  }

  return url;
}

/**
 * Returns true if the IPv4 address string falls in a private/reserved range.
 * Exported for testing.
 */
export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 10 ||                             // 10.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) ||    // 172.16.0.0/12
    (a === 192 && b === 168) ||             // 192.168.0.0/16
    a === 127 ||                            // 127.0.0.0/8 loopback
    (a === 169 && b === 254)               // 169.254.0.0/16 link-local / IMDS
  );
}

/**
 * Returns true for IPv6 loopback and private ranges.
 * Exported for testing.
 */
export function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return (
    lower === '::1' ||           // loopback
    lower.startsWith('fc') ||    // fc00::/7 unique local
    lower.startsWith('fd') ||    // fd00::/8 unique local
    lower.startsWith('fe80')     // fe80::/10 link-local
  );
}
