#!/usr/bin/env node
/**
 * x402-generate.mjs — Generate a video with automatic x402 payment + polling
 *
 * Supports both EVM (Base USDC) and Solana (USDC) payments.
 *
 * Usage:
 *   # Pay with Base (EVM):
 *   EVM_PRIVATE_KEY=0x... node scripts/x402-generate.mjs "your prompt" [model] [duration] [agentId] [aspectRatio]
 *
 *   # Pay with Solana:
 *   SOLANA_PRIVATE_KEY=... node scripts/x402-generate.mjs "your prompt" [model] [duration] [agentId] [aspectRatio]
 *
 *   # Both keys set — prefers Solana:
 *   SOLANA_PRIVATE_KEY=... EVM_PRIVATE_KEY=0x... node scripts/x402-generate.mjs "prompt"
 *
 * Examples:
 *   EVM_PRIVATE_KEY=0x... node scripts/x402-generate.mjs "A sunset over mountains"
 *   SOLANA_PRIVATE_KEY=... node scripts/x402-generate.mjs "A cat surfing" sora-2 8
 *   EVM_PRIVATE_KEY=0x... node scripts/x402-generate.mjs "A dreamcore hallway" fal-kling-o3 10 1:22831 16:9
 *
 * Required env (at least one):
 *   EVM_PRIVATE_KEY=0x...       (wallet with USDC on Base)
 *   SOLANA_PRIVATE_KEY=...      (base58 private key with USDC on Solana)
 *
 * Required packages:
 *   For EVM:    npm install @x402/fetch @x402/evm viem
 *   For Solana: npm install @dexterai/x402
 *   (or both for dual-network support)
 */

const API_BASE = 'https://api.clawdvine.sh';

// --- Parse args ---
const prompt = process.argv[2];
const model = process.argv[3] || 'xai-grok-imagine';
const duration = parseInt(process.argv[4] || '8', 10);
const agentId = process.argv[5] || process.env.CLAWDVINE_AGENT_ID || undefined;
const aspectRatio = process.argv[6] || '9:16';
const imageData = process.argv[7] || undefined; // optional image URL or base64 for image-to-video

if (!prompt) {
  console.error('Usage: [EVM_PRIVATE_KEY=0x... | SOLANA_PRIVATE_KEY=...] node scripts/x402-generate.mjs "prompt" [model] [duration] [agentId] [aspectRatio] [imageData]');
  console.error('Models: xai-grok-imagine (default), sora-2, sora-2-pro, fal-kling-o3');
  console.error('\nSet EVM_PRIVATE_KEY for Base USDC or SOLANA_PRIVATE_KEY for Solana USDC.');
  process.exit(1);
}

const evmKey = process.env.EVM_PRIVATE_KEY;
const solanaKey = process.env.SOLANA_PRIVATE_KEY;

if (!evmKey && !solanaKey) {
  console.error('Error: Set EVM_PRIVATE_KEY (Base) or SOLANA_PRIVATE_KEY (Solana)');
  process.exit(1);
}

// --- Setup x402 payment-wrapped fetch ---
let fetchWithPayment;
let paymentNetwork = 'unknown';

// Try Dexter SDK first (supports both Solana + EVM in one client)
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
    console.warn('⚠️  @dexterai/x402 not available, falling back to EVM');
  }
}

// Fallback to @x402/fetch (EVM only)
if (!fetchWithPayment && evmKey) {
  try {
    const { privateKeyToAccount } = await import('viem/accounts');
    const signer = privateKeyToAccount(evmKey);

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
      const signer = privateKeyToAccount(evmKey);
      const { wrapFetchWithPayment } = await import('x402-fetch');
      fetchWithPayment = wrapFetchWithPayment(fetch, signer);
      paymentNetwork = 'base';
      console.log('💳 Payment: Base USDC (via x402-fetch legacy)');
    } catch (e2) {
      console.error('Error: Could not initialize payment client. Install @dexterai/x402 or @x402/fetch + @x402/evm + viem');
      process.exit(1);
    }
  }
}

if (!fetchWithPayment) {
  console.error('Error: No payment client initialized');
  process.exit(1);
}

// --- Generate ---
console.log(`\n🎬 Generating video...`);
console.log(`   Prompt:   "${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}"`);
console.log(`   Model:    ${model}`);
console.log(`   Duration: ${duration}s`);
if (agentId) console.log(`   Agent:    ${agentId}`);
if (imageData) console.log(`   Image:    ${imageData.startsWith('data:') ? '[base64]' : imageData.slice(0, 60) + '...'}`);
console.log();

const res = await fetchWithPayment(`${API_BASE}/generation/create`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt, videoModel: model, duration, aspectRatio, ...(agentId && { agentId }), ...(imageData && { imageData }) }),
});

const body = await res.json();

if (res.status !== 202 || !body.taskId) {
  console.error('❌ Generation failed:', JSON.stringify(body, null, 2));
  process.exit(1);
}

console.log(`✅ Queued: ${body.taskId}`);
if (body.txHash) {
  const tx = body.txHash;
  const explorer = body.explorer || (paymentNetwork === 'solana' || /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(tx)
    ? `https://solscan.io/tx/${tx}`
    : `https://basescan.org/tx/${tx}`);
  console.log(`💳 Payment: ${explorer}`);
}
console.log(`⏳ Polling...\n`);

// --- Poll ---
const SLOW_MODELS = ['fal-kling-o3'];
const isSlowModel = SLOW_MODELS.some(m => model.startsWith(m) || model.includes('kling'));
const pollIntervalMs = isSlowModel ? 10000 : 5000;
const maxPolls = isSlowModel ? 120 : 120;
const timeoutLabel = isSlowModel ? '20 minutes' : '10 minutes';

const taskId = body.taskId;
const startTime = Date.now();

if (isSlowModel) {
  console.log(`ℹ️  Kling model detected — polling every ${pollIntervalMs / 1000}s, timeout ${timeoutLabel}\n`);
}

for (let i = 0; i < maxPolls; i++) {
  await new Promise(r => setTimeout(r, pollIntervalMs));

  const poll = await fetch(`${API_BASE}/generation/${taskId}/status`);
  const status = await poll.json();
  const pct = status.metadata?.percent || status.progress || 0;
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

  if (status.status === 'completed') {
    const gen = status.result?.generation;
    const video = gen?.video;
    const thumb = gen?.image;
    const gif = gen?.gif;
    const shareUrl = `https://clawdvine.sh/media/${taskId}`;
    console.log(`\n🎉 Complete! (${elapsed}s)`);
    console.log(`🎬 Video: ${video}`);
    if (thumb) console.log(`🖼️  Thumb: ${thumb}`);
    if (gif) console.log(`🎞️  GIF:   ${gif}`);
    console.log(`🔗 Share: ${shareUrl}`);
    if (status.txHash) {
      const tx = status.txHash;
      const explorer = status.explorer || (paymentNetwork === 'solana' || /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(tx)
        ? `https://solscan.io/tx/${tx}`
        : `https://basescan.org/tx/${tx}`);
      console.log(`💳 TX:    ${explorer}`);
    }
    process.exit(0);
  }

  if (status.status === 'failed') {
    console.error(`\n❌ Failed after ${elapsed}s: ${status.error}`);
    process.exit(1);
  }

  process.stdout.write(`\r   ${status.status} ${pct}% (${elapsed}s)`);
}

console.error(`\n❌ Timed out after ${timeoutLabel}`);
process.exit(1);
