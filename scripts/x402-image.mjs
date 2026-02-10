#!/usr/bin/env node
/**
 * x402-image.mjs — Generate an image with automatic x402 payment
 *
 * Supports both EVM (Base USDC) and Solana (USDC) payments.
 *
 * Usage:
 *   # Pay with Base (EVM):
 *   EVM_PRIVATE_KEY=0x... node scripts/x402-image.mjs "prompt" [aspectRatio] [agentId]
 *
 *   # Pay with Solana:
 *   SOLANA_PRIVATE_KEY=... node scripts/x402-image.mjs "prompt" [aspectRatio] [agentId]
 */

const API_BASE = 'https://api.clawdvine.sh';
const prompt = process.argv[2];
const aspectRatio = process.argv[3] || '9:16';
const agentId = process.argv[4] || process.env.CLAWDVINE_AGENT_ID || '1:22831';

if (!prompt) { console.error('Usage: [EVM_PRIVATE_KEY=0x... | SOLANA_PRIVATE_KEY=...] node scripts/x402-image.mjs "prompt" [aspectRatio] [agentId]'); process.exit(1); }

const evmKey = process.env.EVM_PRIVATE_KEY;
const solanaKey = process.env.SOLANA_PRIVATE_KEY;

if (!evmKey && !solanaKey) {
  console.error('Error: Set EVM_PRIVATE_KEY (Base) or SOLANA_PRIVATE_KEY (Solana)');
  process.exit(1);
}

// --- Setup x402 payment-wrapped fetch ---
let fetchWithPayment;
let paymentNetwork = 'unknown';

// Try Dexter SDK first (supports both Solana + EVM)
if (solanaKey) {
  try {
    const { wrapFetch } = await import('@dexterai/x402/client');
    fetchWithPayment = wrapFetch(fetch, {
      walletPrivateKey: solanaKey,
      ...(evmKey ? { evmPrivateKey: evmKey } : {}),
      preferredNetwork: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    });
    paymentNetwork = 'solana';
    console.log('💳 Payment: Solana USDC (via Dexter)');
  } catch (e) {
    console.warn('[x402] @dexterai/x402 not available, falling back to EVM');
  }
}

// Fallback to @x402/fetch (EVM only)
if (!fetchWithPayment && evmKey) {
  try {
    const { privateKeyToAccount } = await import('viem/accounts');
    const signer = privateKeyToAccount(evmKey.startsWith('0x') ? evmKey : `0x${evmKey}`);
    const { wrapFetchWithPayment, x402Client } = await import('@x402/fetch');
    const { registerExactEvmScheme } = await import('@x402/evm/exact/client');
    const client = new x402Client();
    registerExactEvmScheme(client, { signer });
    fetchWithPayment = wrapFetchWithPayment(fetch, client);
    paymentNetwork = 'base';
    console.log('💳 Payment: Base USDC (via x402)');
  } catch {
    try {
      const { privateKeyToAccount } = await import('viem/accounts');
      const signer = privateKeyToAccount(evmKey.startsWith('0x') ? evmKey : `0x${evmKey}`);
      const { wrapFetchWithPayment } = await import('x402-fetch');
      fetchWithPayment = wrapFetchWithPayment(fetch, signer);
      paymentNetwork = 'base';
      console.log('💳 Payment: Base USDC (via x402-fetch legacy)');
    } catch {
      console.error('Error: Could not initialize payment client.');
      process.exit(1);
    }
  }
}

if (!fetchWithPayment) {
  console.error('Error: No payment client initialized');
  process.exit(1);
}

console.log(`\n🖼️  Generating image...`);
console.log(`   Prompt: "${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}"`);
console.log(`   Ratio:  ${aspectRatio}`);
console.log(`   Agent:  ${agentId}\n`);

const res = await fetchWithPayment(`${API_BASE}/mcp`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'generate_image', arguments: { prompt, agentId, aspectRatio } }
  })
});

const data = await res.json();

if (data.result?.content) {
  for (const c of data.result.content) {
    if (c.type === 'text') console.log(c.text);
    if (c.type === 'image') console.log(`🖼️  Image: ${c.data || c.url || JSON.stringify(c)}`);
  }
} else {
  console.log(JSON.stringify(data, null, 2));
}
