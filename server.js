/**
 * FeedBluff — Complete Backend Server
 * Pure Node.js (no external dependencies needed)
 * Run: node server.js
 * Open: http://localhost:3000
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');

const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// IN-MEMORY DATABASE (demo purposes)
// In production: replace with PostgreSQL
// ─────────────────────────────────────────────
const DB = {
  users: new Map(),
  sessions: new Map(),
  rounds: [],
  posts: [],
  transactions: [],
  dms: [],
  repEvents: []
};

// ─────────────────────────────────────────────
// SEED DATA — demo users
// ─────────────────────────────────────────────
function seedDB() {
  const demoUsers = [
    { id: 'u1', username: 'GoldRush88',  balance: 8420, reputation: 88 },
    { id: 'u2', username: 'LuckyJan',    balance: 5190, reputation: 72 },
    { id: 'u3', username: 'Pro_Dealer',  balance: 4875, reputation: 61 },
    { id: 'u4', username: 'CryptoKing',  balance: 3200, reputation: 55 },
    { id: 'u5', username: 'NightOwl',    balance: 2800, reputation: 44 },
  ];
  demoUsers.forEach(u => {
    u.passwordHash = hashPassword('demo123');
    u.createdAt = new Date().toISOString();
    DB.users.set(u.id, u);
  });

  // Seed some posts
  const postContents = [
    { type: 'jackpot', content: 'Just hit €4,200 on a single round… this feed is insane right now 🔥', isTrap: false },
    { type: 'trending', content: '47 players engaged with the post below. Big wins cluster here.', isTrap: false },
    { type: 'phishing', content: 'I promise this is 100% genuine. Everyone who opened it made money.', isTrap: true },
    { type: 'news', content: 'BREAKING: Largest payout in FeedBluff history just happened.', isTrap: false },
    { type: 'meme', content: 'POV: You scrolled 4 times, multiplier is x3, your hands are shaking 😂💀', isTrap: false },
  ];

  postContents.forEach((p, i) => {
    DB.posts.push({
      id: 'post_seed_' + i,
      creatorId: 'u' + (i + 1),
      creatorName: demoUsers[i % demoUsers.length].username,
      type: p.type,
      content: p.content,
      isTrap: p.isTrap,
      trapStake: 25,
      opens: Math.floor(Math.random() * 50) + 5,
      earnings: Math.floor(Math.random() * 200),
      isActive: true,
      createdAt: new Date().toISOString()
    });
  });

  console.log('✅ DB seeded with demo data');
}

// ─────────────────────────────────────────────
// AUTH HELPERS
// ─────────────────────────────────────────────
function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw + 'feedbluff_salt').digest('hex');
}

function generateToken(userId) {
  const payload = { userId, ts: Date.now() };
  const token = Buffer.from(JSON.stringify(payload)).toString('base64') +
    '.' + crypto.createHmac('sha256', 'feedbluff_secret').update(JSON.stringify(payload)).digest('hex');
  DB.sessions.set(token, userId);
  return token;
}

function verifyToken(token) {
  return DB.sessions.get(token) || null;
}

// ─────────────────────────────────────────────
// RNG ENGINE — Provably Fair
// ─────────────────────────────────────────────
class RNGService {
  static generateOutcome(userId, scrollDepth) {
    const serverSeed = crypto.randomBytes(16).toString('hex');
    const clientSeed = userId.slice(0, 8);
    const nonce = DB.rounds.filter(r => r.userId === userId).length;
    const hash = crypto.createHmac('sha256', serverSeed)
      .update(clientSeed + ':' + nonce).digest('hex');
    const value = parseInt(hash.slice(0, 8), 16) / 0xFFFFFFFF;

    // Probabilities adjust with scroll depth
    const scamBoost = scrollDepth * 0.04;
    const jackpotBoost = scrollDepth * 0.015;

    const thresholds = {
      jackpot: 0.08 + jackpotBoost,
      win:     0.08 + jackpotBoost + 0.30,
      troll:   0.08 + jackpotBoost + 0.30 + 0.25,
      scam:    0.08 + jackpotBoost + 0.30 + 0.25 + 0.20 + scamBoost,
    };

    let outcomeType;
    if (value < thresholds.jackpot)      outcomeType = 'jackpot';
    else if (value < thresholds.win)     outcomeType = 'win';
    else if (value < thresholds.troll)   outcomeType = 'troll';
    else if (value < thresholds.scam)    outcomeType = 'scam';
    else                                  outcomeType = 'empty';

    return {
      outcomeType,
      serverSeedHash: crypto.createHash('sha256').update(serverSeed).digest('hex'),
      clientSeed,
      nonce,
      verifiable: true
    };
  }

  static calculatePayout(outcomeType, bet, multiplier) {
    switch (outcomeType) {
      case 'jackpot': return { payout: Math.round(bet * multiplier * 3), change: Math.round(bet * multiplier * 3) - bet };
      case 'win':     return { payout: Math.round(bet * multiplier),     change: Math.round(bet * multiplier) - bet };
      case 'troll':   return { payout: 0, change: -Math.round(bet * 0.3) };
      case 'scam':    return { payout: 0, change: -bet };
      default:        return { payout: 0, change: 0 };
    }
  }
}

// ─────────────────────────────────────────────
// GAME SERVICE
// ─────────────────────────────────────────────
class GameService {
  static scroll(userId) {
    const user = DB.users.get(userId);
    if (!user) return { error: 'User not found' };
    if (user.balance <= 0) return { error: 'Insufficient balance' };

    // Get or create active round
    let round = DB.rounds.find(r => r.userId === userId && r.status === 'active');
    if (!round) {
      round = {
        id: crypto.randomUUID ? crypto.randomUUID() : 'r_' + Date.now(),
        userId,
        scrollDepth: 0,
        multiplier: 1.0,
        status: 'active',
        startedAt: new Date().toISOString()
      };
      DB.rounds.push(round);
    }

    round.scrollDepth++;
    round.multiplier = parseFloat(
      (1.0 + (round.scrollDepth - 1) * 0.5 + Math.random() * 0.3).toFixed(2)
    );

    // Generate a post for this scroll
    const post = PostService.generateFeedPost(userId, round.scrollDepth);

    return {
      success: true,
      scrollDepth: round.scrollDepth,
      multiplier: round.multiplier,
      riskLevel: this.getRiskLevel(round.scrollDepth),
      post
    };
  }

  static openPost(userId, bet) {
    const user = DB.users.get(userId);
    if (!user) return { error: 'User not found' };
    if (user.balance < bet) return { error: 'Insufficient balance' };

    const round = DB.rounds.find(r => r.userId === userId && r.status === 'active');
    if (!round) return { error: 'No active round. Scroll first!' };

    const rng = RNGService.generateOutcome(userId, round.scrollDepth);
    const { change } = RNGService.calculatePayout(rng.outcomeType, bet, round.multiplier);

    // Update balance
    user.balance = Math.max(0, user.balance + change);

    // Update reputation
    const repChange = this.getRepChange(rng.outcomeType);
    user.reputation = Math.max(0, Math.min(100, user.reputation + repChange));

    // Close round
    round.status = 'completed';
    round.outcome = rng.outcomeType;
    round.bet = bet;
    round.payout = change > 0 ? change + bet : 0;
    round.balanceChange = change;
    round.completedAt = new Date().toISOString();

    // Log transaction
    DB.transactions.push({
      id: 'tx_' + Date.now(),
      userId,
      type: change >= 0 ? 'win' : 'loss',
      amount: Math.abs(change),
      balanceAfter: user.balance,
      roundId: round.id,
      createdAt: new Date().toISOString()
    });

    // Log reputation event
    if (repChange !== 0) {
      DB.repEvents.push({
        userId,
        change: repChange,
        reason: 'game_outcome_' + rng.outcomeType,
        createdAt: new Date().toISOString()
      });
    }

    return {
      success: true,
      outcome: rng.outcomeType,
      balanceChange: change,
      newBalance: user.balance,
      multiplier: round.multiplier,
      scrollDepth: round.scrollDepth,
      repChange,
      newReputation: user.reputation,
      provablyFair: {
        serverSeedHash: rng.serverSeedHash,
        clientSeed: rng.clientSeed,
        nonce: rng.nonce
      }
    };
  }

  static getRiskLevel(depth) {
    const risk = Math.min(100, depth * 18);
    if (risk > 70) return 'DANGER';
    if (risk > 40) return 'MEDIUM';
    return 'LOW';
  }

  static getRepChange(outcome) {
    const map = { jackpot: 5, win: 2, troll: -1, scam: -3, empty: 0 };
    return map[outcome] || 0;
  }
}

// ─────────────────────────────────────────────
// POST SERVICE
// ─────────────────────────────────────────────
const POST_TEMPLATES = [
  { type: 'jackpot', emoji: '💰', contents: [
    'Just hit €4,200 on a single round… this feed is insane right now 🔥',
    'Dropped €50, walked out with €680. Open this if you\'re feeling lucky.',
    'Nobody\'s talking about the post that appeared 3 minutes ago. Still active.',
  ]},
  { type: 'trending', emoji: '📈', contents: [
    '47 players engaged with the post 3 slots below. Big wins cluster here.',
    'Algorithm is pushing something today. I\'ve seen 3 jackpots in 2 hours.',
    'Posts marked trending in last 10 min have 72% higher payout rate.',
  ]},
  { type: 'dm', emoji: '📨', contents: [
    'Found a pattern. Next post in your feed is clean. Trust me.',
    'I\'ve got a tip for you. Open the next one. Don\'t tell anyone.',
  ]},
  { type: 'news', emoji: '🚨', contents: [
    'BREAKING: Largest payout in FeedBluff history just happened.',
    'ALERT: Posts carrying 5× normal jackpot value detected right now.',
  ]},
  { type: 'phishing', emoji: '🎣', contents: [
    'This is 100% genuine. Everyone who opened it made money.',
    'Verified by 12 trusted players. No risk. Guaranteed win.',
  ]},
  { type: 'meme', emoji: '😂', contents: [
    'POV: Scrolled 4 times, multiplier x3, hands are shaking 😂💀',
    'FeedBluff players at 3am: ONE MORE SCROLL 💀💀💀',
  ]}
];

const FAKE_USERNAMES = ['CryptoKing99','LuckyLara','BigWinBrad','TrendWatcher',
  'FeedAnalyst','anonymous_user','FeedBluffNews','TotallyLegit','MemeKing'];

class PostService {
  static generateFeedPost(userId, scrollDepth) {
    // 20% chance to show a player-created post
    const playerPost = DB.posts.filter(p => p.isActive && p.creatorId !== userId);
    if (playerPost.length > 0 && Math.random() < 0.20) {
      const pp = playerPost[Math.floor(Math.random() * playerPost.length)];
      pp.opens++;
      return {
        id: pp.id,
        type: pp.type,
        content: pp.content,
        user: pp.creatorName,
        isPlayerPost: true,
        isTrap: pp.isTrap,
        likes: Math.floor(Math.random() * 300) + 10,
        comments: Math.floor(Math.random() * 50) + 2,
        time: 'just now'
      };
    }

    const tmpl = POST_TEMPLATES[Math.floor(Math.random() * POST_TEMPLATES.length)];
    const content = tmpl.contents[Math.floor(Math.random() * tmpl.contents.length)];
    const user = FAKE_USERNAMES[Math.floor(Math.random() * FAKE_USERNAMES.length)];
    return {
      id: 'fp_' + Date.now() + '_' + Math.random().toString(36).slice(2),
      type: tmpl.type,
      emoji: tmpl.emoji,
      content,
      user,
      isPlayerPost: false,
      isTrap: false,
      likes: Math.floor(Math.random() * 800) + 20,
      comments: Math.floor(Math.random() * 200) + 5,
      time: Math.floor(Math.random() * 12 + 1) + 'm ago'
    };
  }

  static createPlayerPost(userId, data) {
    const user = DB.users.get(userId);
    if (!user) return { error: 'User not found' };
    const fee = data.isTrap ? 10 : 5;
    if (user.balance < fee) return { error: 'Insufficient balance' };

    user.balance -= fee;
    const repChange = data.isTrap ? -2 : 3;
    user.reputation = Math.max(0, Math.min(100, user.reputation + repChange));

    const post = {
      id: 'pp_' + Date.now(),
      creatorId: userId,
      creatorName: user.username,
      type: data.type || 'jackpot',
      content: data.content,
      isTrap: !!data.isTrap,
      trapStake: data.trapStake || 10,
      opens: 0,
      earnings: 0,
      isActive: true,
      createdAt: new Date().toISOString()
    };

    DB.posts.push(post);

    // Log transaction
    DB.transactions.push({
      id: 'tx_' + Date.now(),
      userId,
      type: 'fee',
      amount: fee,
      balanceAfter: user.balance,
      createdAt: new Date().toISOString()
    });

    return {
      success: true,
      post,
      newBalance: user.balance,
      repChange,
      newReputation: user.reputation
    };
  }

  static getMyPosts(userId) {
    return DB.posts.filter(p => p.creatorId === userId);
  }
}

// ─────────────────────────────────────────────
// DM SERVICE
// ─────────────────────────────────────────────
class DMService {
  static sendTroll(senderId, targetUsername, message) {
    const sender = DB.users.get(senderId);
    if (!sender) return { error: 'User not found' };
    if (sender.balance < 3) return { error: 'Insufficient balance (need €3)' };

    sender.balance -= 3;
    sender.reputation = Math.max(0, sender.reputation - 1);

    const dm = {
      id: 'dm_' + Date.now(),
      senderId,
      senderName: sender.username,
      targetUsername,
      message,
      wasTrusted: null,
      outcomeAmount: 0,
      createdAt: new Date().toISOString()
    };
    DB.dms.push(dm);

    // Simulate victim response (in real app this is real-time)
    const fell = Math.random() < 0.45;
    const earn = fell ? Math.floor(Math.random() * 30 + 10) : 0;

    setTimeout(() => {
      dm.wasTrusted = fell;
      dm.outcomeAmount = earn;
      if (earn > 0) {
        sender.balance += earn;
        sender.reputation = Math.min(100, sender.reputation + 2);
      } else {
        sender.reputation = Math.max(0, sender.reputation - 2);
      }
    }, 3000 + Math.random() * 4000);

    return {
      success: true,
      dmId: dm.id,
      newBalance: sender.balance,
      newReputation: sender.reputation,
      message: `DM sent to ${targetUsername}. Waiting for response…`
    };
  }

  static respondToDM(userId, dmId, trusted) {
    const user = DB.users.get(userId);
    const dm = DB.dms.find(d => d.id === dmId);
    if (!user || !dm) return { error: 'Not found' };

    // Find sender's post and determine if it's really a trap
    const isTrap = Math.random() < 0.6;
    let balanceChange = 0;
    let repChange = 0;

    if (trusted && isTrap) {
      balanceChange = -Math.round(10 * 0.5);
      repChange = -2;
    } else if (trusted && !isTrap) {
      balanceChange = Math.round(10 * 0.8);
      repChange = 3;
    }

    user.balance = Math.max(0, user.balance + balanceChange);
    user.reputation = Math.max(0, Math.min(100, user.reputation + repChange));

    return {
      success: true,
      wasTrap: isTrap,
      trusted,
      balanceChange,
      newBalance: user.balance,
      repChange,
      newReputation: user.reputation
    };
  }
}

// ─────────────────────────────────────────────
// WALLET SERVICE
// ─────────────────────────────────────────────
class WalletService {
  static getBalance(userId) {
    const user = DB.users.get(userId);
    if (!user) return { error: 'User not found' };
    return { balance: user.balance, currency: 'EUR' };
  }

  static getHistory(userId) {
    return DB.transactions
      .filter(t => t.userId === userId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 50);
  }

  static getStats(userId) {
    const txs = DB.transactions.filter(t => t.userId === userId);
    const wins = txs.filter(t => t.type === 'win');
    const losses = txs.filter(t => t.type === 'loss');
    const rounds = DB.rounds.filter(r => r.userId === userId && r.status === 'completed');

    return {
      totalRounds: rounds.length,
      totalWins: wins.length,
      totalLosses: losses.length,
      winRate: rounds.length > 0 ? ((wins.length / rounds.length) * 100).toFixed(1) : 0,
      totalWon: wins.reduce((s, t) => s + t.amount, 0),
      totalLost: losses.reduce((s, t) => s + t.amount, 0),
      biggestWin: wins.length > 0 ? Math.max(...wins.map(t => t.amount)) : 0,
    };
  }
}

// ─────────────────────────────────────────────
// LEADERBOARD
// ─────────────────────────────────────────────
function getLeaderboard() {
  return Array.from(DB.users.values())
    .sort((a, b) => b.balance - a.balance)
    .slice(0, 10)
    .map((u, i) => ({
      rank: i + 1,
      username: u.username,
      balance: u.balance,
      reputation: u.reputation
    }));
}

// ─────────────────────────────────────────────
// AUTH ROUTES
// ─────────────────────────────────────────────
function handleAuth(req, res, body) {
  const parsed = url.parse(req.url);
  const pathname = parsed.pathname;

  if (pathname === '/api/auth/register' && req.method === 'POST') {
    const { username, password } = body;
    if (!username || !password) return send(res, 400, { error: 'Username and password required' });
    const exists = Array.from(DB.users.values()).find(u => u.username === username);
    if (exists) return send(res, 400, { error: 'Username already taken' });

    const user = {
      id: 'u_' + Date.now(),
      username,
      passwordHash: hashPassword(password),
      balance: 1000, // Starting balance for demo
      reputation: 50,
      createdAt: new Date().toISOString()
    };
    DB.users.set(user.id, user);
    const token = generateToken(user.id);
    return send(res, 201, { token, user: sanitizeUser(user) });
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const { username, password } = body;
    const user = Array.from(DB.users.values()).find(u => u.username === username);
    if (!user || user.passwordHash !== hashPassword(password)) {
      return send(res, 401, { error: 'Invalid credentials' });
    }
    const token = generateToken(user.id);
    return send(res, 200, { token, user: sanitizeUser(user) });
  }

  return null;
}

// ─────────────────────────────────────────────
// GAME ROUTES
// ─────────────────────────────────────────────
function handleGame(req, res, body, userId) {
  const parsed = url.parse(req.url);
  const pathname = parsed.pathname;

  if (pathname === '/api/game/scroll' && req.method === 'POST') {
    const result = GameService.scroll(userId);
    return send(res, result.error ? 400 : 200, result);
  }

  if (pathname === '/api/game/open' && req.method === 'POST') {
    const { bet } = body;
    if (!bet || bet <= 0) return send(res, 400, { error: 'Invalid bet amount' });
    const result = GameService.openPost(userId, bet);
    return send(res, result.error ? 400 : 200, result);
  }

  if (pathname === '/api/game/history' && req.method === 'GET') {
    const rounds = DB.rounds
      .filter(r => r.userId === userId && r.status === 'completed')
      .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))
      .slice(0, 20);
    return send(res, 200, { rounds });
  }

  if (pathname === '/api/game/stats' && req.method === 'GET') {
    return send(res, 200, WalletService.getStats(userId));
  }

  return null;
}

// ─────────────────────────────────────────────
// POST ROUTES
// ─────────────────────────────────────────────
function handlePosts(req, res, body, userId) {
  const parsed = url.parse(req.url);
  const pathname = parsed.pathname;

  if (pathname === '/api/posts/create' && req.method === 'POST') {
    const result = PostService.createPlayerPost(userId, body);
    return send(res, result.error ? 400 : 201, result);
  }

  if (pathname === '/api/posts/mine' && req.method === 'GET') {
    const posts = PostService.getMyPosts(userId);
    return send(res, 200, { posts });
  }

  if (pathname === '/api/posts/feed' && req.method === 'GET') {
    const feed = DB.posts.filter(p => p.isActive).slice(-20).reverse();
    return send(res, 200, { posts: feed });
  }

  return null;
}

// ─────────────────────────────────────────────
// DM ROUTES
// ─────────────────────────────────────────────
function handleDMs(req, res, body, userId) {
  const parsed = url.parse(req.url);
  const pathname = parsed.pathname;

  if (pathname === '/api/dm/send' && req.method === 'POST') {
    const { targetUsername, message } = body;
    const result = DMService.sendTroll(userId, targetUsername, message);
    return send(res, result.error ? 400 : 200, result);
  }

  if (pathname === '/api/dm/respond' && req.method === 'POST') {
    const { dmId, trusted } = body;
    const result = DMService.respondToDM(userId, dmId, trusted);
    return send(res, result.error ? 400 : 200, result);
  }

  return null;
}

// ─────────────────────────────────────────────
// USER ROUTES
// ─────────────────────────────────────────────
function handleUsers(req, res, body, userId) {
  const parsed = url.parse(req.url);
  const pathname = parsed.pathname;

  if (pathname === '/api/user/me' && req.method === 'GET') {
    const user = DB.users.get(userId);
    return send(res, 200, { user: sanitizeUser(user) });
  }

  if (pathname === '/api/user/balance' && req.method === 'GET') {
    return send(res, 200, WalletService.getBalance(userId));
  }

  if (pathname === '/api/user/transactions' && req.method === 'GET') {
    return send(res, 200, { transactions: WalletService.getHistory(userId) });
  }

  if (pathname === '/api/leaderboard' && req.method === 'GET') {
    return send(res, 200, { leaderboard: getLeaderboard() });
  }

  return null;
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function sanitizeUser(user) {
  if (!user) return null;
  const { passwordHash, ...safe } = user;
  return safe;
}

function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
  });
  res.end(JSON.stringify(data));
}

function getBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { resolve({}); }
    });
  });
}

// ─────────────────────────────────────────────
// LIVE EVENTS (SSE — Server-Sent Events)
// replaces WebSocket for demo simplicity
// ─────────────────────────────────────────────
const sseClients = new Set();

function broadcastEvent(type, data) {
  const msg = `data: ${JSON.stringify({ type, data, ts: Date.now() })}\n\n`;
  sseClients.forEach(client => {
    try { client.write(msg); } catch {}
  });
}

// Simulate live activity every 3-5 seconds
const ACTIVITY_NAMES = ['Alex K.','Maria S.','BigBet Tom','LuckyJan','Pro_Dealer','NightOwl','FastFold'];
const ACTIVITY_TYPES = ['win','scam','jackpot','scroll','trap'];
function simulateLiveActivity() {
  const name = ACTIVITY_NAMES[Math.floor(Math.random() * ACTIVITY_NAMES.length)];
  const type = ACTIVITY_TYPES[Math.floor(Math.random() * ACTIVITY_TYPES.length)];
  const amount = Math.floor(Math.random() * 300 + 20);
  const msgs = {
    win:     `${name} opened a post → +€${amount}`,
    scam:    `${name} got SCAMMED → -€${Math.floor(amount/3)}`,
    jackpot: `${name} hit JACKPOT x${(Math.random()*4+1.5).toFixed(1)} → +€${amount}`,
    scroll:  `${name} is scrolling… depth ${Math.floor(Math.random()*5+2)}`,
    trap:    `${name} set a TRAP in the feed 😈`
  };
  broadcastEvent('activity', { message: msgs[type], type, amount });
}
setInterval(simulateLiveActivity, 3500 + Math.random() * 2000);

// ─────────────────────────────────────────────
// MAIN HTTP SERVER
// ─────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url);
  const pathname = parsed.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
    });
    return res.end();
  }

  // Serve frontend (index.html)
  if (pathname === '/' || pathname === '/index.html') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  // SSE endpoint for live events
  if (pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write(`data: ${JSON.stringify({ type: 'connected', data: { onlineCount: DB.users.size + 2847 } })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // Health check
  if (pathname === '/api/health') {
    return send(res, 200, {
      status: 'ok',
      users: DB.users.size,
      rounds: DB.rounds.length,
      posts: DB.posts.length,
      uptime: process.uptime()
    });
  }

  // Public routes (no auth needed)
  const body = await getBody(req);
  const authResult = handleAuth(req, res, body);
  if (authResult !== null) return;

  // Leaderboard (public)
  if (pathname === '/api/leaderboard' && req.method === 'GET') {
    return send(res, 200, { leaderboard: getLeaderboard() });
  }

  // Protected routes — require token
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  const userId = verifyToken(token);

  if (!userId) return send(res, 401, { error: 'Unauthorized. Please login.' });

  // Route to handlers
  if (pathname.startsWith('/api/game')) {
    const result = handleGame(req, res, body, userId);
    if (result !== null) return;
    // Broadcast activity after game action
    const user = DB.users.get(userId);
    if (user) broadcastEvent('activity', { message: `${user.username} opened a post`, userId });
  }

  if (pathname.startsWith('/api/posts')) {
    const result = handlePosts(req, res, body, userId);
    if (result !== null) return;
  }

  if (pathname.startsWith('/api/dm')) {
    const result = handleDMs(req, res, body, userId);
    if (result !== null) return;
  }

  if (pathname.startsWith('/api/user')) {
    const result = handleUsers(req, res, body, userId);
    if (result !== null) return;
  }

  send(res, 404, { error: 'Route not found' });
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
seedDB();
server.listen(PORT, () => {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║     🎮 FeedBluff Server Running        ║');
  console.log(`║     http://localhost:${PORT}              ║`);
  console.log('╠════════════════════════════════════════╣');
  console.log('║  Demo Login:                           ║');
  console.log('║  username: GoldRush88                  ║');
  console.log('║  password: demo123                     ║');
  console.log('╠════════════════════════════════════════╣');
  console.log('║  API Endpoints:                        ║');
  console.log('║  POST /api/auth/register               ║');
  console.log('║  POST /api/auth/login                  ║');
  console.log('║  POST /api/game/scroll                 ║');
  console.log('║  POST /api/game/open  { bet: 10 }      ║');
  console.log('║  GET  /api/game/stats                  ║');
  console.log('║  POST /api/posts/create                ║');
  console.log('║  POST /api/dm/send                     ║');
  console.log('║  GET  /api/leaderboard                 ║');
  console.log('║  GET  /api/events  (live SSE)          ║');
  console.log('╚════════════════════════════════════════╝');
  console.log('');
});

module.exports = { DB, GameService, RNGService, PostService };
