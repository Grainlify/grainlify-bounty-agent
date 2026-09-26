import { describe, expect, it } from 'vitest';
import { corsHeaders } from '../src/public.ts';

describe('CORS answers every caller, whatever Origin they send', () => {
  // The wallet card broke because the server withheld the header from a
  // request whose Origin a browser extension had rewritten. It answered 400 --
  // a real reply, correctly formed -- and Chrome then refused to let the page
  // read it, reporting a CORS failure for a request that had succeeded end to
  // end. Nothing this API exposes is authorised by origin, so withholding the
  // header protected nothing and hid a working response.
  const allowed = ['https://grainlify.com'];

  it('echoes an origin it recognises', () => {
    expect(corsHeaders('https://grainlify.com', allowed, 'POST, OPTIONS')['access-control-allow-origin']).toBe('https://grainlify.com');
  });

  it('still answers when the Origin header is missing entirely', () => {
    expect(corsHeaders(undefined, allowed, 'POST, OPTIONS')['access-control-allow-origin']).toBe('*');
  });

  it('still answers an origin it does not recognise', () => {
    // An extension re-issuing the fetch is the real case. It gets a readable
    // reply; it does not get authorisation, which lives in the signatures.
    expect(corsHeaders('chrome-extension://abc', allowed, 'POST, OPTIONS')['access-control-allow-origin']).toBe('*');
  });

  it('always varies on Origin, so a cache cannot serve one caller another answer', () => {
    expect(corsHeaders(undefined, allowed).vary).toBe('Origin');
    expect(corsHeaders('https://grainlify.com', allowed).vary).toBe('Origin');
  });

  it('allows any header on POST routes, not just content-type', () => {
    // An extension that adds one header to the page's fetch makes it a
    // preflighted request. Listing only content-type meant the browser refused
    // to send the real request at all -- reproduced with a single injected
    // header against an otherwise correct call.
    expect(corsHeaders('https://x.test', allowed, 'POST, OPTIONS')['access-control-allow-headers']).toBe('*');
  });
});
