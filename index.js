/**
 * Polymarket Fresh Wallet Detection Bot
 * 
 * Detects when 10+ fresh wallets (first-ever transaction) bet on the same
 * market outcome within a 24-hour window.
 * 
 * Usage:
 *   npm install
 *   node index.js
 * 
 * Environment variables:
 *   POLYGON_RPC_URL - Your Polygon RPC endpoint (default: public endpoint)
 */

const { ethers } = require('ethers');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Polygon RPC - replace with your own for better performance
  rpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
  
  // Polymarket CTF Exchange contract on Polygon
  // This is the main exchange where trades happen
  ctfExchangeAddress: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
  
  // Detection thresholds
  freshWalletThreshold: 10,      // Number of fresh wallets to trigger alert
  timeWindowMs: 24 * 60 * 60 * 1000, // 24 hours in milliseconds
  
  // Polling interval (how often to check for new events)
  pollIntervalMs: 30 * 1000, // 30 seconds
  
  // How many blocks back to start scanning (keep low for free tier)
  startBlocksBack: 50,
};

// ============================================================================
// CTF EXCHANGE ABI (relevant events only)
// ============================================================================

const CTF_EXCHANGE_ABI = [
  // OrderFilled event - emitted when an order is filled
  'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)',
  
  // OrdersMatched event - emitted when orders are matched
  'event OrdersMatched(bytes32 indexed takerOrderHash, address indexed takerOrderMaker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled)',
];

// ============================================================================
// DATA STRUCTURES
// ============================================================================

// Track bets by market outcome
// Key: marketOutcomeId (assetId), Value: array of { wallet, timestamp, txHash }
const betsByOutcome = new Map();

// Cache for wallet freshness checks
// Key: wallet address, Value: { isFresh: boolean, checkedAt: timestamp }
const walletCache = new Map();

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Check if a wallet is "fresh" (has only 1 transaction ever - this one)
 */
async function isWalletFresh(provider, walletAddress) {
  // Check cache first
  const cached = walletCache.get(walletAddress.toLowerCase());
  if (cached && Date.now() - cached.checkedAt < 60 * 60 * 1000) { // 1 hour cache
    return cached.isFresh;
  }
  
  try {
    const txCount = await provider.getTransactionCount(walletAddress);
    // A truly fresh wallet would have txCount of 1 (just this transaction)
    // But we check <= 2 to account for timing and nonce increments
    const isFresh = txCount <= 2;
    
    walletCache.set(walletAddress.toLowerCase(), {
      isFresh,
      checkedAt: Date.now()
    });
    
    return isFresh;
  } catch (error) {
    console.error(`Error checking wallet ${walletAddress}:`, error.message);
    return false;
  }
}

/**
 * Clean up old bets outside the time window
 */
function cleanupOldBets() {
  const cutoff = Date.now() - CONFIG.timeWindowMs;
  
  for (const [outcomeId, bets] of betsByOutcome.entries()) {
    const filteredBets = bets.filter(bet => bet.timestamp > cutoff);
    if (filteredBets.length === 0) {
      betsByOutcome.delete(outcomeId);
    } else {
      betsByOutcome.set(outcomeId, filteredBets);
    }
  }
}

// Track which outcomes we've already alerted on
const alertedOutcomes = new Set();

// Cache for market info
const marketCache = new Map();

/**
 * Fetch market info from Polymarket Gamma API
 */
async function getMarketInfo(tokenId) {
  // Check cache first
  if (marketCache.has(tokenId)) {
    return marketCache.get(tokenId);
  }
  
  try {
    // Try Gamma API - search by clob_token_ids
    const response = await fetch(`https://gamma-api.polymarket.com/markets?clob_token_ids=${tokenId}`);
    if (response.ok) {
      const data = await response.json();
      if (data && data.length > 0) {
        const market = data[0];
        
        // Figure out which outcome this token represents
        let outcome = 'Unknown';
        let price = null;
        
        // Parse the clobTokenIds to find which outcome matches
        const tokenIds = JSON.parse(market.clobTokenIds || '[]');
        const outcomes = JSON.parse(market.outcomes || '[]');
        const prices = JSON.parse(market.outcomePrices || '[]');
        
        const tokenIndex = tokenIds.indexOf(tokenId);
        if (tokenIndex !== -1) {
          outcome = outcomes[tokenIndex] || 'Unknown';
          price = prices[tokenIndex] ? parseFloat(prices[tokenIndex]) : null;
        }
        
        const marketInfo = {
          question: market.question || 'Unknown Market',
          outcome: outcome,
          price: price,
          slug: market.slug,
        };
        
        marketCache.set(tokenId, marketInfo);
        return marketInfo;
      }
    }
    
    // Fallback: try CLOB API for price at least
    try {
      const priceRes = await fetch(`https://clob.polymarket.com/price?token_id=${tokenId}&side=BUY`);
      if (priceRes.ok) {
        const priceData = await priceRes.json();
        const marketInfo = {
          question: null,
          outcome: null,
          price: priceData.price ? parseFloat(priceData.price) : null,
        };
        marketCache.set(tokenId, marketInfo);
        return marketInfo;
      }
    } catch (e) {
      // Ignore
    }
    
    return null;
  } catch (error) {
    console.error(`Error fetching market info: ${error.message}`);
    return null;
  }
}

/**
 * Check if threshold is met and alert (only once per outcome)
 */
async function checkAndAlert(outcomeId) {
  // Don't alert twice for the same outcome
  if (alertedOutcomes.has(outcomeId)) return;
  
  const bets = betsByOutcome.get(outcomeId) || [];
  const freshBets = bets.filter(bet => bet.isFresh);
  
  if (freshBets.length >= CONFIG.freshWalletThreshold) {
    alertedOutcomes.add(outcomeId);
    
    // Fetch market info
    const marketInfo = await getMarketInfo(outcomeId);
    
    console.log('\n' + '='.repeat(80));
    console.log('🚨 ALERT: FRESH WALLET CLUSTER DETECTED!');
    console.log('='.repeat(80));
    
    if (marketInfo && marketInfo.question) {
      console.log(`\n📊 MARKET: ${marketInfo.question}`);
      console.log(`🎯 BETTING ON: ${marketInfo.outcome}`);
      if (marketInfo.price !== null) {
        console.log(`💰 CURRENT PRICE: ${(marketInfo.price * 100).toFixed(1)}%`);
      }
      if (marketInfo.slug) {
        console.log(`🔗 https://polymarket.com/event/${marketInfo.slug}`);
      }
    } else {
      console.log(`\n📊 Token ID: ${outcomeId}`);
      if (marketInfo && marketInfo.price !== null) {
        console.log(`💰 CURRENT PRICE: ${(marketInfo.price * 100).toFixed(1)}%`);
      }
    }
    
    console.log(`\n👛 Fresh wallets: ${freshBets.length}`);
    console.log(`⏱️  First bet: ${new Date(freshBets[0].timestamp).toISOString()}`);
    console.log(`⏱️  Latest bet: ${new Date(freshBets[freshBets.length - 1].timestamp).toISOString()}`);
    
    // Show sample transaction on Polygonscan
    console.log(`\n🔍 Sample TX: https://polygonscan.com/tx/${freshBets[0].txHash}`);
    
    console.log(`\nFirst 10 wallets:`);
    freshBets.slice(0, 10).forEach((bet, i) => {
      console.log(`  ${i + 1}. ${bet.wallet}`);
    });
    if (freshBets.length > 10) {
      console.log(`  ... and ${freshBets.length - 10} more`);
    }
    console.log('\n' + '='.repeat(80) + '\n');
  }
}

/**
 * Process a trade event
 */
async function processTrade(provider, event) {
  const { maker, taker, makerAssetId, takerAssetId } = event.args;
  const txHash = event.transactionHash;
  const timestamp = Date.now(); // Approximate, could fetch block timestamp for precision
  
  // Both maker and taker are betting - check both
  const participants = [
    { wallet: maker, assetId: makerAssetId.toString() },
    { wallet: taker, assetId: takerAssetId.toString() }
  ];
  
  for (const { wallet, assetId } of participants) {
    // Skip zero address
    if (wallet === ethers.ZeroAddress) continue;
    
    // Check if wallet is fresh
    const isFresh = await isWalletFresh(provider, wallet);
    
    if (isFresh) {
      // Add to tracking (silently)
      if (!betsByOutcome.has(assetId)) {
        betsByOutcome.set(assetId, []);
      }
      
      // Check if we already have this wallet for this outcome
      const existingBets = betsByOutcome.get(assetId);
      const alreadyTracked = existingBets.some(
        bet => bet.wallet.toLowerCase() === wallet.toLowerCase()
      );
      
      if (!alreadyTracked) {
        existingBets.push({
          wallet,
          timestamp,
          txHash,
          isFresh: true
        });
        
        // Check if we should alert (only alerts when threshold hit)
        checkAndAlert(assetId);
      }
    }
  }
}

// ============================================================================
// MAIN BOT
// ============================================================================

async function main() {
  console.log('🤖 Polymarket Fresh Wallet Detection Bot');
  console.log('=========================================');
  console.log(`RPC: ${CONFIG.rpcUrl}`);
  console.log(`Exchange: ${CONFIG.ctfExchangeAddress}`);
  console.log(`Threshold: ${CONFIG.freshWalletThreshold} fresh wallets`);
  console.log(`Time window: 24 hours`);
  console.log('');
  
  // Connect to Polygon
  const provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
  
  // Verify connection
  const network = await provider.getNetwork();
  console.log(`Connected to network: ${network.name} (chainId: ${network.chainId})`);
  
  // Create contract instance
  const exchange = new ethers.Contract(
    CONFIG.ctfExchangeAddress,
    CTF_EXCHANGE_ABI,
    provider
  );
  
  // Get current block
  const currentBlock = await provider.getBlockNumber();
  let lastProcessedBlock = currentBlock - CONFIG.startBlocksBack;
  
  console.log(`Starting from block: ${lastProcessedBlock}`);
  console.log(`Current block: ${currentBlock}`);
  console.log('\nListening for trades...\n');
  
  // Main polling loop
  while (true) {
    try {
      const latestBlock = await provider.getBlockNumber();
      
      if (latestBlock > lastProcessedBlock) {
        // Query in chunks of 10 blocks (Alchemy free tier limit)
        const CHUNK_SIZE = 10;
        let fromBlock = lastProcessedBlock + 1;
        
        while (fromBlock <= latestBlock) {
          const toBlock = Math.min(fromBlock + CHUNK_SIZE - 1, latestBlock);
          
          // Query OrderFilled events for this chunk
          const events = await exchange.queryFilter(
            'OrderFilled',
            fromBlock,
            toBlock
          );
          
          if (events.length > 0) {
            console.log(`[${new Date().toISOString()}] Processing ${events.length} trades from blocks ${fromBlock} to ${toBlock}`);
            
            for (const event of events) {
              await processTrade(provider, event);
            }
          }
          
          fromBlock = toBlock + 1;
          
          // Small delay between chunks to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        lastProcessedBlock = latestBlock;
      }
      
      // Cleanup old bets periodically
      cleanupOldBets();
      
    } catch (error) {
      console.error(`Error in main loop: ${error.message}`);
    }
    
    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, CONFIG.pollIntervalMs));
  }
}

// Run the bot
main().catch(console.error);
