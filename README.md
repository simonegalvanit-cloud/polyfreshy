# Polymarket Fresh Wallet Detection Bot

Monitors Polymarket on Polygon and alerts when 10+ fresh wallets (wallets making their first-ever transaction) bet on the same market outcome within 24 hours.

## Setup

```bash
# Install dependencies
npm install

# Run the bot
npm start

# Or with auto-restart on changes
npm run dev
```

## Configuration

Edit the `CONFIG` object in `index.js`:

```javascript
const CONFIG = {
  // Your Polygon RPC endpoint (get one from Alchemy, Infura, or QuickNode)
  rpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
  
  // Number of fresh wallets to trigger alert
  freshWalletThreshold: 10,
  
  // Time window (24 hours)
  timeWindowMs: 24 * 60 * 60 * 1000,
  
  // How often to check for new events
  pollIntervalMs: 30 * 1000,
  
  // How many blocks back to start scanning
  startBlocksBack: 1000,
};
```

## Environment Variables

```bash
# Optional: Use your own RPC for better rate limits
export POLYGON_RPC_URL="https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY"
```

## How It Works

1. Connects to Polygon and monitors the Polymarket CTF Exchange contract
2. Listens for `OrderFilled` events (trades)
3. For each trade, checks if the maker/taker wallet is "fresh" (transaction count ≤ 2)
4. Tracks fresh wallets by market outcome (asset ID)
5. Alerts when 10+ unique fresh wallets bet on the same outcome within 24 hours

## Output Example

```
🤖 Polymarket Fresh Wallet Detection Bot
=========================================
RPC: https://polygon-rpc.com
Exchange: 0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E
Threshold: 10 fresh wallets
Time window: 24 hours

Connected to network: matic (chainId: 137)
Starting from block: 52345678
Current block: 52346678

Listening for trades...

[2024-01-15T10:30:45.123Z] Fresh wallet detected: 0x1234...
  Asset ID: 12345678901234567890
  TX: 0xabcd...

================================================================================
🚨 ALERT: FRESH WALLET CLUSTER DETECTED!
================================================================================
Market Outcome ID: 12345678901234567890
Fresh wallets betting: 10
Time window: Last 24 hours

Fresh wallets:
  1. 0x1234...
     TX: 0xabcd...
     Time: 2024-01-15T10:30:45.123Z
  ...
================================================================================
```

## Extending the Bot

### Add Discord Alerts

```javascript
const DISCORD_WEBHOOK = 'https://discord.com/api/webhooks/...';

async function sendDiscordAlert(outcomeId, freshBets) {
  await fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: `🚨 **Fresh Wallet Cluster Detected!**\nOutcome: ${outcomeId}\nFresh wallets: ${freshBets.length}`
    })
  });
}
```

### Add Market Name Resolution

The asset IDs map to specific market outcomes. To get human-readable names, you can use Polymarket's API:

```javascript
async function getMarketInfo(assetId) {
  const res = await fetch(`https://gamma-api.polymarket.com/markets?asset_id=${assetId}`);
  return res.json();
}
```

## Notes

- The public Polygon RPC may rate-limit you. Consider using Alchemy, Infura, or QuickNode.
- "Fresh wallet" is defined as a wallet with ≤2 total transactions (to account for the current tx).
- The bot caches wallet freshness checks for 1 hour to reduce RPC calls.
