#!/usr/bin/env node
// Grainlify contributor helper — DEVNET TEST TOKENS ONLY.
//
// No dependencies; needs Node 18+. Read it before running it: it is short.
//
//   node grainlify-contributor.mjs link <github-username>   make a devnet wallet (first run) and print your link comment
//   node grainlify-contributor.mjs balance                  show your devnet wallet and its test tokens
//
// The wallet it creates is for Solana DEVNET only and lives in
// ~/.grainlify-devnet/wallet.json on this computer. This script never prints,
// uploads or sends the private key anywhere. Never paste a private key or
// seed phrase into GitHub, chat, or any website.

import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = join(homedir(), '.grainlify-devnet');
const WALLET = join(DIR, 'wallet.json');
const DEVNET_RPC = 'https://api.devnet.solana.com';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function b58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) s = '1' + s;
    else break;
  }
  return s;
}

function loadOrCreateWallet() {
  if (existsSync(WALLET)) return Uint8Array.from(JSON.parse(readFileSync(WALLET, 'utf8')));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const secret = Uint8Array.from(Buffer.concat([seed, pub])); // Solana keypair file format
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  writeFileSync(WALLET, JSON.stringify(Array.from(secret)), { mode: 0o600 });
  console.log(`Created a new DEVNET wallet at ${WALLET} (keep this file private; it holds only test tokens).\n`);
  return secret;
}

const address = (secret) => b58(secret.slice(32));

function signMessage(secret, message) {
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(secret.slice(0, 32))]);
  return b58(sign(null, Buffer.from(message, 'utf8'), createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })));
}

// Must match the agent's packages/gate/src/link.ts exactly.
export function linkMessage(login, wallet, issuedAt) {
  return ['Grainlify bounty agent: link this wallet to my GitHub account', `GitHub: ${login.toLowerCase()}`, `Wallet: ${wallet}`, `Issued: ${issuedAt}`].join('\n');
}

export function linkComment(secret, login, issuedAt = new Date().toISOString()) {
  const wallet = address(secret);
  return `/grainlify link ${wallet} ${signMessage(secret, linkMessage(login, wallet, issuedAt))} ${issuedAt}`;
}

async function rpc(method, params) {
  const r = await fetch(DEVNET_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

async function main() {
  const [cmd, login] = process.argv.slice(2);
  if (cmd === 'link') {
    if (!login || !/^[A-Za-z0-9-]{1,39}$/.test(login)) throw new Error('usage: node grainlify-contributor.mjs link <your-github-username>');
    const secret = loadOrCreateWallet();
    console.log('Post this as a comment on the bounty issue, from your GitHub account, within 24 hours:\n');
    console.log(linkComment(secret, login));
    console.log(`\nYour devnet wallet address: ${address(secret)}`);
    return;
  }
  if (cmd === 'balance') {
    if (!existsSync(WALLET)) throw new Error('no wallet yet; run: node grainlify-contributor.mjs link <your-github-username>');
    const owner = address(Uint8Array.from(JSON.parse(readFileSync(WALLET, 'utf8'))));
    const res = await rpc('getTokenAccountsByOwner', [owner, { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, { encoding: 'jsonParsed' }]);
    console.log(`Devnet wallet ${owner}`);
    console.log(`Explorer: https://explorer.solana.com/address/${owner}?cluster=devnet`);
    if (!res.value.length) console.log('No test tokens yet.');
    for (const a of res.value) {
      const info = a.account.data.parsed.info;
      console.log(`  ${info.tokenAmount.uiAmountString} test tokens (mint ${info.mint})`);
    }
    return;
  }
  console.log('usage:\n  node grainlify-contributor.mjs link <your-github-username>\n  node grainlify-contributor.mjs balance');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  });
}
