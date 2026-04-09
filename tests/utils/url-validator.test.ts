import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dns/promises before importing the validator so we control resolution.
vi.mock('dns/promises', () => ({
  default: {
    resolve4: vi.fn(),
  },
}));

import dns from 'dns/promises';
import { validateExternalUrl, isPrivateIPv4, isPrivateIPv6 } from '../../src/utils/url-validator.js';

// Helper: set what dns.resolve4 returns for the next call(s)
function mockDnsResolve(addresses: string[]) {
  vi.mocked(dns.resolve4).mockResolvedValue(addresses as any);
}

function mockDnsReject(msg = 'ENOTFOUND') {
  vi.mocked(dns.resolve4).mockRejectedValue(new Error(msg));
}

// ─── isPrivateIPv4 ────────────────────────────────────────────────

describe('isPrivateIPv4', () => {
  it('identifies 10.x.x.x as private', () => {
    expect(isPrivateIPv4('10.0.0.1')).toBe(true);
    expect(isPrivateIPv4('10.255.255.255')).toBe(true);
  });

  it('identifies 172.16-31.x.x as private', () => {
    expect(isPrivateIPv4('172.16.0.1')).toBe(true);
    expect(isPrivateIPv4('172.31.255.255')).toBe(true);
  });

  it('does not flag 172.15.x.x or 172.32.x.x', () => {
    expect(isPrivateIPv4('172.15.0.1')).toBe(false);
    expect(isPrivateIPv4('172.32.0.1')).toBe(false);
  });

  it('identifies 192.168.x.x as private', () => {
    expect(isPrivateIPv4('192.168.1.1')).toBe(true);
    expect(isPrivateIPv4('192.168.0.0')).toBe(true);
  });

  it('identifies 127.x.x.x as loopback (private)', () => {
    expect(isPrivateIPv4('127.0.0.1')).toBe(true);
    expect(isPrivateIPv4('127.1.2.3')).toBe(true);
  });

  it('identifies 169.254.x.x as link-local / IMDS (private)', () => {
    expect(isPrivateIPv4('169.254.169.254')).toBe(true);
    expect(isPrivateIPv4('169.254.0.1')).toBe(true);
  });

  it('does not flag public IPs', () => {
    expect(isPrivateIPv4('8.8.8.8')).toBe(false);
    expect(isPrivateIPv4('1.1.1.1')).toBe(false);
    expect(isPrivateIPv4('93.184.216.34')).toBe(false);
  });

  it('handles malformed input gracefully', () => {
    expect(isPrivateIPv4('not-an-ip')).toBe(false);
    expect(isPrivateIPv4('')).toBe(false);
    expect(isPrivateIPv4('256.0.0.1')).toBe(false);
  });
});

// ─── isPrivateIPv6 ────────────────────────────────────────────────

describe('isPrivateIPv6', () => {
  it('identifies ::1 as loopback', () => {
    expect(isPrivateIPv6('::1')).toBe(true);
  });

  it('identifies fc::/7 unique local', () => {
    expect(isPrivateIPv6('fc00::1')).toBe(true);
  });

  it('identifies fd::/8 unique local', () => {
    expect(isPrivateIPv6('fd12:3456::1')).toBe(true);
  });

  it('identifies fe80::/10 link-local', () => {
    expect(isPrivateIPv6('fe80::1')).toBe(true);
  });

  it('does not flag public IPv6', () => {
    expect(isPrivateIPv6('2001:4860:4860::8888')).toBe(false);
    expect(isPrivateIPv6('2606:4700:4700::1111')).toBe(false);
  });
});

// ─── validateExternalUrl ──────────────────────────────────────────

describe('validateExternalUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: DNS resolution returns a benign public IP so tests that
    // reach DNS don't accidentally block on unresolvable names.
    mockDnsResolve(['1.2.3.4']);
  });

  // Protocol checks
  it('allows http:// URLs', async () => {
    await expect(validateExternalUrl('http://example.com/page')).resolves.toBeDefined();
  });

  it('allows https:// URLs', async () => {
    await expect(validateExternalUrl('https://example.com/page')).resolves.toBeDefined();
  });

  it('blocks file:// protocol', async () => {
    await expect(validateExternalUrl('file:///etc/passwd')).rejects.toThrow('Blocked protocol');
  });

  it('blocks ftp:// protocol', async () => {
    await expect(validateExternalUrl('ftp://example.com/file')).rejects.toThrow('Blocked protocol');
  });

  it('blocks javascript: protocol', async () => {
    await expect(validateExternalUrl('javascript:alert(1)')).rejects.toThrow('Blocked protocol');
  });

  it('rejects a completely invalid URL', async () => {
    await expect(validateExternalUrl('not a url')).rejects.toThrow('Invalid URL');
  });

  // Blocked hostnames
  it('blocks localhost', async () => {
    await expect(validateExternalUrl('http://localhost/admin')).rejects.toThrow('Blocked internal hostname');
  });

  it('blocks 127.0.0.1 as a hostname (blocked list)', async () => {
    await expect(validateExternalUrl('http://127.0.0.1/')).rejects.toThrow();
  });

  it('blocks 0.0.0.0', async () => {
    await expect(validateExternalUrl('http://0.0.0.0/')).rejects.toThrow('Blocked internal hostname');
  });

  it('blocks metadata.google.internal', async () => {
    await expect(validateExternalUrl('http://metadata.google.internal/computeMetadata/v1/')).rejects.toThrow('Blocked internal hostname');
  });

  it('blocks 169.254.169.254 (IMDS endpoint) in hostname list', async () => {
    await expect(validateExternalUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow();
  });

  // Literal private IPv4 addresses
  it('blocks literal 10.x.x.x IP', async () => {
    await expect(validateExternalUrl('http://10.0.0.1/')).rejects.toThrow('Blocked private IPv4');
  });

  it('blocks literal 192.168.x.x IP', async () => {
    await expect(validateExternalUrl('http://192.168.1.100/api')).rejects.toThrow('Blocked private IPv4');
  });

  it('blocks literal 172.16.x.x IP', async () => {
    await expect(validateExternalUrl('http://172.16.0.1/')).rejects.toThrow('Blocked private IPv4');
  });

  it('blocks literal 127.0.0.1 IP (loopback)', async () => {
    await expect(validateExternalUrl('http://127.0.0.1:8080/')).rejects.toThrow();
  });

  // Literal private IPv6 addresses
  it('blocks [::1] IPv6 loopback', async () => {
    await expect(validateExternalUrl('http://[::1]/')).rejects.toThrow();
  });

  it('blocks [fd00::1] unique local IPv6', async () => {
    await expect(validateExternalUrl('http://[fd00::1]/')).rejects.toThrow('Blocked private IPv6');
  });

  // DNS-resolved private IPs
  it('blocks a hostname that DNS-resolves to a private IP', async () => {
    mockDnsResolve(['192.168.1.50']);
    await expect(validateExternalUrl('http://internal.corp.example/')).rejects.toThrow('resolved to private IP');
  });

  it('blocks a hostname that resolves to a 10.x.x.x address', async () => {
    mockDnsResolve(['10.20.30.40']);
    await expect(validateExternalUrl('http://evil-redirect.example.com/')).rejects.toThrow('resolved to private IP');
  });

  it('allows a hostname that resolves to a public IP', async () => {
    mockDnsResolve(['93.184.216.34']); // example.com
    await expect(validateExternalUrl('https://example.com/')).resolves.toBeDefined();
  });

  // DNS failure → fail open
  it('allows a URL when DNS resolution fails (fail open)', async () => {
    mockDnsReject('ENOTFOUND example.com');
    await expect(validateExternalUrl('https://example.com/')).resolves.toBeDefined();
  });

  it('allows a URL when DNS times out (fail open)', async () => {
    // Simulate a timeout by making resolve4 never resolve within 3 s.
    // We mock it to reject immediately with "DNS timeout" to keep tests fast.
    vi.mocked(dns.resolve4).mockRejectedValue(new Error('DNS timeout'));
    await expect(validateExternalUrl('https://slow-dns.example.com/')).resolves.toBeDefined();
  });

  // Valid public URLs
  it('returns the parsed URL object on success', async () => {
    mockDnsResolve(['1.1.1.1']);
    const url = await validateExternalUrl('https://docs.example.com/guide?v=2');
    expect(url.hostname).toBe('docs.example.com');
    expect(url.pathname).toBe('/guide');
  });
});
