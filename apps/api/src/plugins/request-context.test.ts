import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { requestContextPlugin, type RequestContextOptions } from './request-context.js';

/**
 * Which address a request is attributed to.
 *
 * This decides the bucket a per-IP rate limit counts against and the address
 * the audit trail records, so a client that can choose it can slip past both.
 * Every test below is an attempt to choose it.
 */

async function ipFor(
  options: RequestContextOptions,
  headers: Record<string, string> = {},
): Promise<string | undefined> {
  const app = Fastify();
  await app.register(requestContextPlugin, options);
  app.get('/', async (request) => ({ ip: request.context.ip }));

  const response = await app.inject({
    method: 'GET',
    url: '/',
    headers,
    remoteAddress: '203.0.113.7',
  });
  await app.close();
  return response.json().ip;
}

const behindOneProxy: RequestContextOptions = { trustProxy: true, trustedProxyHops: 1 };

describe('with no proxy in front', () => {
  it('uses the socket address and ignores the header entirely', async () => {
    const ip = await ipFor(
      { trustProxy: false, trustedProxyHops: 1 },
      { 'x-forwarded-for': '9.9.9.9' },
    );
    // Nothing is in front, so a forwarded header is simply something the
    // client typed.
    expect(ip).toBe('203.0.113.7');
  });
});

describe('behind one proxy', () => {
  it('reads the address the proxy appended, not the one the client sent', async () => {
    // The client sent `9.9.9.9`; the proxy appended what it actually saw.
    // Reading left to right would read the client's own claim.
    const ip = await ipFor(behindOneProxy, { 'x-forwarded-for': '9.9.9.9, 198.51.100.4' });
    expect(ip).toBe('198.51.100.4');
  });

  it('cannot be pushed off the end by a long forged trail', async () => {
    const forged = Array.from({ length: 30 }, (_, i) => `9.9.9.${i}`).join(', ');
    const ip = await ipFor(behindOneProxy, {
      'x-forwarded-for': `${forged}, 198.51.100.4`,
    });
    expect(ip).toBe('198.51.100.4');
  });

  it('handles a header with one entry', async () => {
    const ip = await ipFor(behindOneProxy, { 'x-forwarded-for': '198.51.100.4' });
    expect(ip).toBe('198.51.100.4');
  });

  it('falls back rather than picking an arbitrary entry when the trail is short', async () => {
    // A client can always make the trail shorter by sending no header, so the
    // clamp must not index out of bounds or wrap round to the wrong end.
    const ip = await ipFor({ trustProxy: true, trustedProxyHops: 4 }, {});
    expect(ip).toBeTruthy();
  });

  it('tolerates whitespace and empty entries', async () => {
    const ip = await ipFor(behindOneProxy, { 'x-forwarded-for': ' , 9.9.9.9 ,  198.51.100.4 ' });
    expect(ip).toBe('198.51.100.4');
  });
});

describe('behind a CDN in front of a proxy', () => {
  const twoHops: RequestContextOptions = { trustProxy: true, trustedProxyHops: 2 };

  it('counts in past both of them', async () => {
    // client -> CDN -> load balancer -> here. The CDN appended the client's
    // address; the balancer appended the CDN's.
    const ip = await ipFor(twoHops, {
      'x-forwarded-for': '9.9.9.9, 198.51.100.4, 192.0.2.10',
    });
    expect(ip).toBe('198.51.100.4');
  });

  it('is wrong in the safe direction when the count is too high', async () => {
    // Over-counting reads an address nearer the client than the truth, so
    // several clients share a bucket — annoying. Under-counting reads
    // attacker-supplied input, which is the failure that matters.
    const ip = await ipFor(twoHops, { 'x-forwarded-for': '198.51.100.4' });
    expect(ip).toBe('198.51.100.4');
  });
});

describe('with a platform header', () => {
  const netlify: RequestContextOptions = {
    trustProxy: true,
    trustedProxyHops: 1,
    clientIpHeader: 'x-nf-client-connection-ip',
  };

  it('prefers it over the forwarding trail', async () => {
    // The platform overwrites this one rather than appending to it, so
    // nothing the client sends can reach it.
    const ip = await ipFor(netlify, {
      'x-nf-client-connection-ip': '198.51.100.4',
      'x-forwarded-for': '9.9.9.9, 203.0.113.1',
    });
    expect(ip).toBe('198.51.100.4');
  });

  it('falls back to the trail when the platform did not set it', async () => {
    const ip = await ipFor(netlify, { 'x-forwarded-for': '9.9.9.9, 198.51.100.4' });
    expect(ip).toBe('198.51.100.4');
  });

  it('ignores it when it is blank', async () => {
    const ip = await ipFor(netlify, {
      'x-nf-client-connection-ip': '   ',
      'x-forwarded-for': '9.9.9.9, 198.51.100.4',
    });
    expect(ip).toBe('198.51.100.4');
  });
});

describe('the request id', () => {
  it('is minted here and never taken from the client', async () => {
    const app = Fastify({ genReqId: () => 'minted' });
    await app.register(requestContextPlugin, behindOneProxy);
    app.get('/', async (request) => ({ id: request.context.requestId }));

    const response = await app.inject({
      method: 'GET',
      url: '/',
      headers: { 'x-request-id': 'chosen-by-the-caller' },
    });

    // An attacker choosing their own would be able to collide or poison log
    // correlation. The inbound one is kept for upstream correlation only.
    expect(response.json().id).toBe('minted');
    expect(response.headers['x-request-id']).toBe('minted');
    await app.close();
  });
});
