/**
 * Polymarket Fresh Wallet Detection Dashboard
 * 
 * Real-time web dashboard for monitoring fresh wallet clusters
 * 
 * Usage:
 *   npm install
 *   POLYGON_RPC_URL=your_url node server.js
 *   Open http://localhost:3000
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { ethers } = require('ethers');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  rpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
  ctfExchangeAddress: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
  freshWalletThreshold: 10,
  timeWindowMs: 24 * 60 * 60 * 1000,
  pollIntervalMs: 30 * 1000,
  startBlocksBack: 50,
  port: process.env.PORT || 3000,
};

// ============================================================================
// CTF EXCHANGE ABI
// ============================================================================

const CTF_EXCHANGE_ABI = [
  'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)',
];

// ============================================================================
// DATA STRUCTURES
// ============================================================================

const betsByOutcome = new Map();
const walletCache = new Map();
const alertedOutcomes = new Set();
const marketCache = new Map();

// Stats for dashboard
const stats = {
  totalTrades: 0,
  freshWalletsDetected: 0,
  alertsTriggered: 0,
  startTime: Date.now(),
  lastBlock: 0,
  isConnected: false,
};

// Store alerts for dashboard
const alerts = [];

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function isWalletFresh(provider, walletAddress) {
  const cached = walletCache.get(walletAddress.toLowerCase());
  if (cached && Date.now() - cached.checkedAt < 60 * 60 * 1000) {
    return cached.isFresh;
  }
  
  try {
    const txCount = await provider.getTransactionCount(walletAddress);
    const isFresh = txCount <= 2;
    walletCache.set(walletAddress.toLowerCase(), { isFresh, checkedAt: Date.now() });
    return isFresh;
  } catch (error) {
    return false;
  }
}

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

async function getMarketInfo(tokenId) {
  if (marketCache.has(tokenId)) {
    return marketCache.get(tokenId);
  }
  
  try {
    const response = await fetch(`https://gamma-api.polymarket.com/markets?clob_token_ids=${tokenId}`);
    if (response.ok) {
      const data = await response.json();
      if (data && data.length > 0) {
        const market = data[0];
        let outcome = 'Unknown';
        let price = null;
        
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
          image: market.image,
          conditionId: market.conditionId,
        };
        
        marketCache.set(tokenId, marketInfo);
        return marketInfo;
      }
    }
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Check if market should be filtered out (crypto short-term markets)
 */
function shouldFilterMarket(marketInfo) {
  if (!marketInfo || !marketInfo.question) return false;
  
  const question = marketInfo.question.toLowerCase();
  
  // Filter out ALL crypto short-term price markets (1min, 5min, 15min, up/down)
  const filterPatterns = [
    // Time-based patterns
    /\d+[\s-]?min/i,
    /\d+[\s-]?minute/i,
    /1-min/i,
    /5-min/i,
    /15-min/i,
    
    // Up or down patterns
    /up or down/i,
    /higher or lower/i,
    /above or below/i,
    
    // Price at specific time
    /price.*\d+[:\d]*\s*(am|pm|utc|et|pt)/i,
    /at \d+[:\d]*\s*(am|pm|utc|et|pt)/i,
    
    // Crypto + short term indicators
    /(bitcoin|btc|ethereum|eth|solana|sol|doge|xrp|crypto).*\d+[:\d]*\s*(am|pm|utc)/i,
    /(bitcoin|btc|ethereum|eth|solana|sol|doge|xrp|crypto).*(up|down|higher|lower)/i,
  ];
  
  return filterPatterns.some(pattern => pattern.test(question));
}

async function checkAndAlert(outcomeId) {
  if (alertedOutcomes.has(outcomeId)) {
    // Update existing alert count and amount
    const existingAlert = alerts.find(a => a.outcomeId === outcomeId);
    if (existingAlert) {
      const bets = betsByOutcome.get(outcomeId) || [];
      const freshBets = bets.filter(b => b.isFresh);
      existingAlert.freshWallets = freshBets.length;
      existingAlert.totalAmount = freshBets.reduce((sum, b) => sum + (b.amount || 0), 0);
      existingAlert.latestBet = new Date().toISOString();
      io.emit('alertUpdate', existingAlert);
    }
    return;
  }
  
  const bets = betsByOutcome.get(outcomeId) || [];
  const freshBets = bets.filter(bet => bet.isFresh);
  
  if (freshBets.length >= CONFIG.freshWalletThreshold) {
    const marketInfo = await getMarketInfo(outcomeId);
    
    // Filter out crypto short-term markets
    if (shouldFilterMarket(marketInfo)) {
      console.log(`⏭️  Filtered: ${marketInfo?.question || outcomeId} (short-term crypto)`);
      alertedOutcomes.add(outcomeId);
      return;
    }
    
    alertedOutcomes.add(outcomeId);
    stats.alertsTriggered++;
    
    // Calculate total amount bet by cluster
    const totalAmount = freshBets.reduce((sum, b) => sum + (b.amount || 0), 0);
    
    // Build the correct Polymarket URL
    let polymarketUrl = null;
    if (marketInfo?.slug) {
      polymarketUrl = `https://polymarket.com/event/${marketInfo.slug}`;
    } else if (marketInfo?.conditionId) {
      polymarketUrl = `https://polymarket.com/market/${marketInfo.conditionId}`;
    }
    
    const alert = {
      id: Date.now(),
      outcomeId,
      question: marketInfo?.question || 'Unknown Market',
      outcome: marketInfo?.outcome || 'Unknown',
      price: marketInfo?.price,
      slug: marketInfo?.slug,
      image: marketInfo?.image,
      polymarketUrl: polymarketUrl,
      freshWallets: freshBets.length,
      totalAmount: totalAmount,
      firstBet: freshBets[0].timestamp,
      latestBet: freshBets[freshBets.length - 1].timestamp,
      sampleTx: freshBets[0].txHash,
      wallets: freshBets.map(b => ({
        address: b.wallet,
        txHash: b.txHash,
        timestamp: b.timestamp,
        amount: b.amount
      })),
      timestamp: Date.now(),
    };
    
    alerts.unshift(alert);
    if (alerts.length > 50) alerts.pop();
    
    io.emit('newAlert', alert);
    io.emit('stats', stats);
    
    console.log(`🚨 ALERT: ${alert.question} - ${alert.outcome} (${freshBets.length} wallets, $${totalAmount.toFixed(2)})`);
  }
}

async function processTrade(provider, event) {
  const { maker, taker, makerAssetId, takerAssetId, makerAmountFilled, takerAmountFilled } = event.args;
  const txHash = event.transactionHash;
  const timestamp = Date.now();
  
  stats.totalTrades++;
  
  const participants = [
    { wallet: maker, assetId: makerAssetId.toString(), amount: makerAmountFilled },
    { wallet: taker, assetId: takerAssetId.toString(), amount: takerAmountFilled }
  ];
  
  for (const { wallet, assetId, amount } of participants) {
    if (wallet === ethers.ZeroAddress) continue;
    
    const isFresh = await isWalletFresh(provider, wallet);
    
    if (isFresh) {
      stats.freshWalletsDetected++;
      
      if (!betsByOutcome.has(assetId)) {
        betsByOutcome.set(assetId, []);
      }
      
      const existingBets = betsByOutcome.get(assetId);
      const alreadyTracked = existingBets.some(
        bet => bet.wallet.toLowerCase() === wallet.toLowerCase()
      );
      
      // Convert amount from wei (6 decimals for USDC)
      const amountUSDC = Number(amount) / 1e6;
      
      if (!alreadyTracked) {
        existingBets.push({ wallet, timestamp, txHash, isFresh: true, amount: amountUSDC });
        await checkAndAlert(assetId);
      } else {
        // Update amount if wallet already tracked (they bet more)
        const existing = existingBets.find(b => b.wallet.toLowerCase() === wallet.toLowerCase());
        if (existing) {
          existing.amount = (existing.amount || 0) + amountUSDC;
        }
      }
    }
  }
}

// ============================================================================
// EXPRESS ROUTES
// ============================================================================

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>POLYFRESHY | Fresh Wallet Detector</title>
  <script src="/socket.io/socket.io.js"></script>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    :root {
      --black: #000000;
      --dark: #0a0a0a;
      --gray-900: #111;
      --gray-800: #1a1a1a;
      --gray-700: #252525;
      --gray-600: #333;
      --gray-500: #555;
      --gray-400: #888;
      --gray-300: #aaa;
      --white: #fff;
      --green: #00ff66;
      --green-dim: rgba(0, 255, 102, 0.1);
      --red: #ff3366;
      --red-dim: rgba(255, 51, 102, 0.1);
      --yellow: #ffcc00;
      --blue: #0099ff;
    }
    
    body {
      background: var(--black);
      color: var(--white);
      font-family: 'Space Grotesk', sans-serif;
      min-height: 100vh;
      overflow-x: hidden;
    }
    
    /* Noise overlay */
    body::before {
      content: '';
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      opacity: 0.03;
      pointer-events: none;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
      z-index: 1000;
    }
    
    .wrapper {
      max-width: 1400px;
      margin: 0 auto;
      padding: 30px;
    }
    
    /* Header */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 30px;
      margin-bottom: 30px;
      border-bottom: 1px solid var(--gray-800);
    }
    
    .brand {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    
    .brand-logo {
      width: 48px;
      height: 48px;
      background: var(--green);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      font-weight: 700;
      color: var(--black);
      clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
    }
    
    .brand-text h1 {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: 4px;
      text-transform: uppercase;
    }
    
    .brand-text span {
      font-size: 11px;
      color: var(--gray-400);
      letter-spacing: 2px;
      text-transform: uppercase;
    }
    
    .connection {
      display: flex;
      align-items: center;
      gap: 12px;
      font-family: 'IBM Plex Mono', monospace;
      font-size: 12px;
      color: var(--gray-400);
    }
    
    .pulse {
      width: 8px;
      height: 8px;
      background: var(--red);
      border-radius: 50%;
      animation: pulse 1.5s ease-in-out infinite;
    }
    
    .pulse.live {
      background: var(--green);
      box-shadow: 0 0 20px var(--green);
    }
    
    @keyframes pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.2); opacity: 0.7; }
    }
    
    /* Stats Bar */
    .stats-bar {
      display: flex;
      gap: 2px;
      margin-bottom: 30px;
      background: var(--gray-900);
      padding: 3px;
      border: 1px solid var(--gray-800);
    }
    
    .stat {
      flex: 1;
      padding: 20px 24px;
      background: var(--dark);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    
    .stat-label {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: var(--gray-500);
    }
    
    .stat-value {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 28px;
      font-weight: 600;
      color: var(--white);
    }
    
    .stat-value.green { color: var(--green); }
    .stat-value.red { color: var(--red); }
    .stat-value.yellow { color: var(--yellow); }
    
    /* Panel */
    .panel {
      background: var(--dark);
      border: 1px solid var(--gray-800);
    }
    
    .panel-header {
      padding: 20px 24px;
      border-bottom: 1px solid var(--gray-800);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .panel-title {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 3px;
      text-transform: uppercase;
      color: var(--gray-300);
    }
    
    .panel-badge {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 10px;
      padding: 4px 10px;
      background: var(--gray-800);
      color: var(--gray-400);
    }
    
    .panel-body {
      max-height: calc(100vh - 340px);
      overflow-y: auto;
    }
    
    /* Alert Cards */
    .alert {
      padding: 24px;
      border-bottom: 1px solid var(--gray-800);
      transition: background 0.2s;
      position: relative;
      animation: slideIn 0.4s cubic-bezier(0.16, 1, 0.3, 1);
    }
    
    .alert::before {
      content: '';
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 3px;
      background: var(--red);
    }
    
    .alert:hover {
      background: var(--gray-900);
    }
    
    @keyframes slideIn {
      from { opacity: 0; transform: translateY(-10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    
    .alert-top {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 16px;
    }
    
    .alert-count {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 11px;
      font-weight: 600;
      padding: 6px 12px;
      background: var(--red);
      color: var(--black);
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    
    .alert-count::before {
      content: '';
      width: 6px;
      height: 6px;
      background: var(--black);
      border-radius: 50%;
      animation: blink 1s infinite;
    }
    
    @keyframes blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }
    
    .alert-time {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 11px;
      color: var(--gray-500);
    }
    
    .alert-question {
      font-size: 16px;
      font-weight: 600;
      line-height: 1.5;
      margin-bottom: 12px;
      color: var(--white);
    }
    
    .alert-outcome {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 10px 16px;
      background: var(--green-dim);
      border: 1px solid var(--green);
      margin-bottom: 16px;
    }
    
    .alert-outcome-label {
      font-size: 13px;
      font-weight: 600;
      color: var(--green);
    }
    
    .alert-outcome-price {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 13px;
      color: var(--gray-400);
    }
    
    .alert-meta {
      display: flex;
      gap: 24px;
      font-size: 12px;
      color: var(--gray-500);
      margin-bottom: 16px;
    }
    
    .alert-meta span {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    
    .alert-actions {
      display: flex;
      gap: 12px;
    }
    
    .btn {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 1px;
      text-transform: uppercase;
      padding: 10px 16px;
      background: var(--gray-800);
      color: var(--white);
      text-decoration: none;
      border: 1px solid var(--gray-700);
      transition: all 0.2s;
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    
    .btn:hover {
      background: var(--gray-700);
      border-color: var(--gray-600);
    }
    
    .btn.primary {
      background: var(--green);
      color: var(--black);
      border-color: var(--green);
    }
    
    .btn.primary:hover {
      background: var(--white);
      border-color: var(--white);
    }
    
    /* Empty State */
    .empty {
      padding: 100px 40px;
      text-align: center;
    }
    
    .empty-icon {
      font-size: 64px;
      margin-bottom: 24px;
      opacity: 0.3;
    }
    
    .empty-title {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 12px;
      color: var(--gray-300);
    }
    
    .empty-text {
      font-size: 13px;
      color: var(--gray-500);
      line-height: 1.8;
    }
    
    /* Scrollbar */
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: var(--dark); }
    ::-webkit-scrollbar-thumb { background: var(--gray-700); }
    ::-webkit-scrollbar-thumb:hover { background: var(--gray-600); }
    
    /* Modal */
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.9);
      display: none;
      justify-content: center;
      align-items: center;
      z-index: 9999;
      padding: 20px;
    }
    
    .modal-overlay.active {
      display: flex;
    }
    
    .modal {
      background: var(--dark);
      border: 1px solid var(--gray-700);
      width: 100%;
      max-width: 800px;
      max-height: 80vh;
      display: flex;
      flex-direction: column;
    }
    
    .modal-header {
      padding: 20px 24px;
      border-bottom: 1px solid var(--gray-800);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .modal-title {
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 2px;
      text-transform: uppercase;
    }
    
    .modal-close {
      background: none;
      border: none;
      color: var(--gray-400);
      font-size: 24px;
      cursor: pointer;
      padding: 0;
      line-height: 1;
    }
    
    .modal-close:hover {
      color: var(--white);
    }
    
    .modal-body {
      padding: 0;
      overflow-y: auto;
      flex: 1;
    }
    
    .wallet-row {
      display: grid;
      grid-template-columns: 1fr 100px 140px;
      gap: 16px;
      padding: 14px 24px;
      border-bottom: 1px solid var(--gray-800);
      font-family: 'IBM Plex Mono', monospace;
      font-size: 12px;
      align-items: center;
    }
    
    .wallet-row:hover {
      background: var(--gray-900);
    }
    
    .wallet-row-header {
      color: var(--gray-500);
      font-size: 10px;
      letter-spacing: 1px;
      text-transform: uppercase;
      background: var(--gray-900);
    }
    
    .wallet-row-header:hover {
      background: var(--gray-900);
    }
    
    .wallet-address {
      color: var(--green);
      word-break: break-all;
    }
    
    .wallet-address a {
      color: var(--green);
      text-decoration: none;
    }
    
    .wallet-address a:hover {
      text-decoration: underline;
    }
    
    .wallet-amount {
      color: var(--white);
      text-align: right;
    }
    
    .wallet-tx a {
      color: var(--gray-400);
      text-decoration: none;
    }
    
    .wallet-tx a:hover {
      color: var(--white);
      text-decoration: underline;
    }
    
    /* Responsive */
    @media (max-width: 768px) {
      .wrapper { padding: 16px; }
      .header { flex-direction: column; gap: 20px; text-align: center; }
      .stats-bar { flex-wrap: wrap; }
      .stat { min-width: calc(50% - 2px); }
      .alert-actions { flex-direction: column; }
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <header class="header">
      <div class="brand">
        <div class="brand-logo">P</div>
        <div class="brand-text">
          <h1>Polyfreshy</h1>
          <span>Fresh Wallet Cluster Detection</span>
        </div>
      </div>
      <div class="connection">
        <div class="pulse" id="pulse"></div>
        <span id="status">CONNECTING</span>
      </div>
    </header>
    
    <div class="stats-bar">
      <div class="stat">
        <div class="stat-label">Clusters Found</div>
        <div class="stat-value red" id="alerts">0</div>
      </div>
      <div class="stat">
        <div class="stat-label">Latest Block</div>
        <div class="stat-value yellow" id="block">—</div>
      </div>
    </div>
    
    <div class="panel">
      <div class="panel-header">
        <div class="panel-title">Cluster Alerts</div>
        <div class="panel-badge">${CONFIG.freshWalletThreshold}+ fresh wallets</div>
      </div>
      <div class="panel-body" id="alertsPanel">
        <div class="empty">
          <div class="empty-icon">◎</div>
          <div class="empty-title">Scanning for clusters...</div>
          <div class="empty-text">
            Alerts appear when ${CONFIG.freshWalletThreshold}+ fresh wallets<br>
            bet on the same outcome within 24 hours
          </div>
        </div>
      </div>
    </div>
  </div>
  
  <!-- Wallets Modal -->
  <div class="modal-overlay" id="modalOverlay">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title" id="modalTitle">Cluster Wallets</div>
        <button class="modal-close" id="modalClose">×</button>
      </div>
      <div class="modal-body" id="modalBody"></div>
    </div>
  </div>
  
  <script>
    const socket = io();
    
    const $ = id => document.getElementById(id);
    let hasAlerts = false;
    let alertsData = {};
    
    // Modal handling
    const modalOverlay = $('modalOverlay');
    const modalClose = $('modalClose');
    const modalBody = $('modalBody');
    const modalTitle = $('modalTitle');
    
    modalClose.onclick = () => modalOverlay.classList.remove('active');
    modalOverlay.onclick = (e) => {
      if (e.target === modalOverlay) modalOverlay.classList.remove('active');
    };
    
    function showWallets(alertId) {
      const alert = alertsData[alertId];
      if (!alert) return;
      
      modalTitle.textContent = \`\${alert.freshWallets} Wallets in Cluster\`;
      
      let html = \`
        <div class="wallet-row wallet-row-header">
          <div>Wallet Address</div>
          <div style="text-align:right">Amount</div>
          <div>Transaction</div>
        </div>
      \`;
      
      alert.wallets.forEach(w => {
        const amount = w.amount ? '$' + w.amount.toFixed(2) : '—';
        html += \`
          <div class="wallet-row">
            <div class="wallet-address">
              <a href="https://polygonscan.com/address/\${w.address}" target="_blank">\${w.address.slice(0,8)}...\${w.address.slice(-6)}</a>
            </div>
            <div class="wallet-amount">\${amount}</div>
            <div class="wallet-tx">
              <a href="https://polygonscan.com/tx/\${w.txHash}" target="_blank">\${w.txHash.slice(0,16)}...</a>
            </div>
          </div>
        \`;
      });
      
      modalBody.innerHTML = html;
      modalOverlay.classList.add('active');
    }
    
    socket.on('connect', () => {
      $('pulse').classList.add('live');
      $('status').textContent = 'LIVE';
    });
    
    socket.on('disconnect', () => {
      $('pulse').classList.remove('live');
      $('status').textContent = 'OFFLINE';
    });
    
    socket.on('stats', s => {
      $('alerts').textContent = s.alertsTriggered.toLocaleString();
      if (s.lastBlock) $('block').textContent = s.lastBlock.toLocaleString();
    });
    
    socket.on('newAlert', alert => {
      alertsData[alert.id] = alert;
      if (!hasAlerts) {
        $('alertsPanel').innerHTML = '';
        hasAlerts = true;
      }
      $('alertsPanel').insertBefore(createAlert(alert), $('alertsPanel').firstChild);
      
      if (Notification.permission === 'granted') {
        new Notification('Cluster Detected', { body: alert.question });
      }
    });
    
    socket.on('alertUpdate', alert => {
      alertsData[alert.id] = {...alertsData[alert.id], ...alert};
      const el = document.querySelector(\`[data-id="\${alert.id}"]\`);
      if (el) {
        const countEl = el.querySelector('.alert-count span');
        if (countEl) countEl.textContent = alert.freshWallets + ' WALLETS';
        
        const metaEl = el.querySelector('.alert-meta');
        if (metaEl && alert.totalAmount) {
          const totalAmount = '$' + alert.totalAmount.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
          metaEl.innerHTML = \`
            <span>💰 \${totalAmount} total</span>
            <span>⏱ \${new Date(alert.firstBet).toLocaleTimeString()} → \${new Date(alert.latestBet).toLocaleTimeString()}</span>
          \`;
        }
      }
    });
    
    socket.on('existingAlerts', list => {
      if (list.length) {
        $('alertsPanel').innerHTML = '';
        hasAlerts = true;
        list.forEach(a => {
          alertsData[a.id] = a;
          $('alertsPanel').appendChild(createAlert(a));
        });
      }
    });
    
    function createAlert(a) {
      const el = document.createElement('div');
      el.className = 'alert';
      el.setAttribute('data-id', a.id);
      
      const price = a.price ? (a.price * 100).toFixed(0) + '¢' : '—';
      const time = new Date(a.timestamp).toLocaleTimeString();
      const polymarketLink = a.polymarketUrl || (a.slug ? 'https://polymarket.com/event/' + a.slug : null);
      const totalAmount = a.totalAmount ? '$' + a.totalAmount.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '—';
      
      el.innerHTML = \`
        <div class="alert-top">
          <div class="alert-count"><span>\${a.freshWallets} WALLETS</span></div>
          <div class="alert-time">\${time}</div>
        </div>
        <div class="alert-question">\${a.question}</div>
        <div class="alert-outcome">
          <span class="alert-outcome-label">\${a.outcome}</span>
          <span class="alert-outcome-price">\${price}</span>
        </div>
        <div class="alert-meta">
          <span>💰 \${totalAmount} total</span>
          <span>⏱ \${new Date(a.firstBet).toLocaleTimeString()} → \${new Date(a.latestBet).toLocaleTimeString()}</span>
        </div>
        <div class="alert-actions">
          <button class="btn" onclick="showWallets(\${a.id})">View Wallets</button>
          \${polymarketLink ? \`<a href="\${polymarketLink}" target="_blank" class="btn primary">View on Polymarket →</a>\` : ''}
          <a href="https://polygonscan.com/tx/\${a.sampleTx}" target="_blank" class="btn">View TX</a>
        </div>
      \`;
      
      return el;
    }
    
    if (Notification.permission === 'default') Notification.requestPermission();
  </script>
</body>
</html>
  `);
});

// ============================================================================
// SOCKET.IO
// ============================================================================

io.on('connection', (socket) => {
  console.log('Dashboard client connected');
  socket.emit('stats', stats);
  socket.emit('existingAlerts', alerts);
});

// ============================================================================
// MAIN BOT
// ============================================================================

async function startBot() {
  console.log('🤖 Polymarket Fresh Wallet Detection Bot');
  console.log('=========================================');
  console.log(`Dashboard: http://localhost:${CONFIG.port}`);
  console.log(`RPC: ${CONFIG.rpcUrl}`);
  console.log(`Threshold: ${CONFIG.freshWalletThreshold} fresh wallets`);
  console.log('');
  
  const provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
  
  try {
    const network = await provider.getNetwork();
    console.log(`Connected to: ${network.name} (chainId: ${network.chainId})`);
    stats.isConnected = true;
    io.emit('stats', stats);
  } catch (error) {
    console.error('Failed to connect to RPC:', error.message);
    return;
  }
  
  const exchange = new ethers.Contract(
    CONFIG.ctfExchangeAddress,
    CTF_EXCHANGE_ABI,
    provider
  );
  
  const currentBlock = await provider.getBlockNumber();
  let lastProcessedBlock = currentBlock - CONFIG.startBlocksBack;
  stats.lastBlock = currentBlock;
  
  console.log(`Starting from block: ${lastProcessedBlock}`);
  console.log('Listening for trades...\n');
  
  while (true) {
    try {
      const latestBlock = await provider.getBlockNumber();
      stats.lastBlock = latestBlock;
      
      if (latestBlock > lastProcessedBlock) {
        const CHUNK_SIZE = 10;
        let fromBlock = lastProcessedBlock + 1;
        
        while (fromBlock <= latestBlock) {
          const toBlock = Math.min(fromBlock + CHUNK_SIZE - 1, latestBlock);
          
          const events = await exchange.queryFilter('OrderFilled', fromBlock, toBlock);
          
          for (const event of events) {
            await processTrade(provider, event);
          }
          
          fromBlock = toBlock + 1;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        lastProcessedBlock = latestBlock;
      }
      
      cleanupOldBets();
      io.emit('stats', stats);
      
    } catch (error) {
      console.error(`Error: ${error.message}`);
    }
    
    await new Promise(resolve => setTimeout(resolve, CONFIG.pollIntervalMs));
  }
}

// ============================================================================
// START
// ============================================================================

server.listen(CONFIG.port, () => {
  console.log(`\n🌐 Dashboard running at http://localhost:${CONFIG.port}\n`);
  startBot();
});
