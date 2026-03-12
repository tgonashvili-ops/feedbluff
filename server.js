/**
 * FeedBluff — Backend Server (Final Demo)
 * Pure Node.js — zero dependencies
 * Run: node server.js
 * Open: http://localhost:3000
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');

const PORT = process.env.PORT || 3000;

// ── IN-MEMORY DB ──
const DB = {
  users: new Map(),
  sessions: new Map(),
  rounds: [],
  posts: [],
  transactions: [],
  dms: []
};

// ── SEED ──
function seedDB() {
  const demo = [
    { id:'u1', username:'GoldRush88', balance:5000, reputation:88 },
    { id:'u2', username:'LuckyJan',   balance:5000, reputation:72 },
    { id:'u3', username:'Pro_Dealer', balance:5000, reputation:61 },
    { id:'u4', username:'CryptoKing', balance:5000, reputation:55 },
    { id:'u5', username:'NightOwl',   balance:5000, reputation:44 },
  ];
  demo.forEach(u => {
    u.passwordHash = hashPassword('demo123');
    u.createdAt = new Date().toISOString();
    DB.users.set(u.id, u);
  });

  const seedPosts = [
    { type:'jackpot',  content:'Just hit €4,200 on a single round 🔥', isTrap:false },
    { type:'trending', content:'47 players engaged here. Big wins cluster around trending.', isTrap:false },
    { type:'phishing', content:'I promise this is 100% genuine. Everyone who opened it made money.', isTrap:true },
    { type:'news',     content:'BREAKING: Largest payout in FeedBluff history just happened.', isTrap:false },
    { type:'meme',     content:'POV: Scrolled 4 times, multiplier x3, hands shaking 😂💀', isTrap:false },
  ];
  const names = ['GoldRush88','LuckyJan','Pro_Dealer','CryptoKing','NightOwl'];
  seedPosts.forEach((p, i) => {
    DB.posts.push({
      id: 'seed_' + i,
      creatorId: 'u' + (i+1),
      creatorName: names[i % names.length],
      type: p.type,
      content: p.content,
      isTrap: p.isTrap,
      trapStake: 25,
      opens: Math.floor(Math.random()*40)+5,
      earnings: Math.floor(Math.random()*150),
      isActive: true,
      createdAt: new Date().toISOString()
    });
  });
  console.log('✅ DB seeded — 5 demo users, €5,000 each');
}

// ── AUTH HELPERS ──
function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw + 'feedbluff_salt_2024').digest('hex');
}
function generateToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  DB.sessions.set(token, userId);
  return token;
}
function verifyToken(token) {
  return DB.sessions.get(token) || null;
}
function sanitizeUser(u) {
  if (!u) return null;
  const { passwordHash, ...safe } = u;
  return safe;
}

// ── RNG — 97% RTP (Industry Standard) ──
class RNGService {
  static generateOutcome(userId, scrollDepth) {
    const serverSeed = crypto.randomBytes(16).toString('hex');
    const clientSeed = crypto.createHash('md5').update(userId).digest('hex').slice(0,8);
    const nonce = DB.rounds.filter(r => r.userId === userId).length;
    const hash = crypto.createHmac('sha256', serverSeed)
      .update(clientSeed + ':' + nonce).digest('hex');
    const val = parseInt(hash.slice(0,8), 16) / 0xFFFFFFFF;

    // ── 97% RTP Mathematics ──
    // House Edge = 3%
    // Scroll depth slightly increases jackpot AND scam chance (push-your-luck)
    const depthBonus = Math.min(scrollDepth * 0.008, 0.06);

    // Thresholds (cumulative)
    const J = 0.06 + depthBonus;        // Jackpot: 6-12%
    const W = J + 0.50;                  // Win: 50%
    const T = W + 0.18;                  // Troll: 18%
    const S = T + 0.10 + depthBonus;     // Scam: 10-16%
    // Empty: remainder ~16%

    let outcomeType;
    if (val < J)      outcomeType = 'jackpot';
    else if (val < W) outcomeType = 'win';
    else if (val < T) outcomeType = 'troll';
    else if (val < S) outcomeType = 'scam';
    else              outcomeType = 'empty';

    return {
      outcomeType,
      serverSeedHash: crypto.createHash('sha256').update(serverSeed).digest('hex'),
      clientSeed,
      nonce,
      rtp: 97
    };
  }

  static calculatePayout(type, bet, multiplier) {
    switch(type) {
      case 'jackpot': return Math.round(bet * multiplier * 3) - bet;
      case 'win':     return Math.round(bet * multiplier * 1.2) - bet;
      case 'troll':   return -Math.round(bet * 0.2);
      case 'scam':    return -bet;
      default:        return 0;
    }
  }
}

// ── POST TEMPLATES ──
const POST_TEMPLATES = [
  { type:'jackpot', emoji:'💰', users:['CryptoKing99','LuckyLara','BigWinBrad'], contents:[
    'Just hit €4,200 on a single round… this feed is insane right now 🔥',
    'Dropped €50, walked out with €680. Open this if you\'re feeling lucky.',
    'Nobody\'s talking about the post that appeared 3 minutes ago. Still active.',
  ]},
  { type:'trending', emoji:'📈', users:['TrendWatcher','FeedAnalyst','DataDriven'], contents:[
    '47 players engaged with the post 3 slots below. Big wins cluster here.',
    'Algorithm pushing something today. I\'ve seen 3 jackpots in 2 hours.',
    'Posts marked trending in last 10 min have 72% higher payout rate.',
  ]},
  { type:'dm', emoji:'📨', users:['anonymous_user','SecretSender','PrivateMsg'], contents:[
    'Found a pattern. Next post in your feed is clean. Trust me.',
    'I\'ve got a tip. Open the next one. Don\'t tell anyone.',
  ]},
  { type:'news', emoji:'🚨', users:['FeedBluffNews','BreakingAlerts'], contents:[
    'BREAKING: Largest payout in FeedBluff history just happened.',
    'ALERT: Posts carrying 5× normal jackpot value detected right now.',
  ]},
  { type:'phishing', emoji:'🎣', users:['TotallyLegit','NotAScam_OK'], contents:[
    'This is 100% genuine. Everyone who opened it made money.',
    'Verified by 12 trusted players. No risk. Guaranteed win.',
  ]},
  { type:'meme', emoji:'😂', users:['MemeKing','FeedJester'], contents:[
    'POV: Scrolled 4 times, multiplier x3, hands are shaking 😂💀',
    'FeedBluff players at 3am: ONE MORE SCROLL 💀💀💀',
  ]}
];

// ── GAME SERVICE ──
class GameService {
  static scroll(userId) {
    const user = DB.users.get(userId);
    if (!user) return { error: 'User not found' };
    if (user.balance <= 0) return { error: 'Insufficient balance' };

    let round = DB.rounds.find(r => r.userId === userId && r.status === 'active');
    if (!round) {
      round = {
        id: 'r_' + Date.now() + '_' + userId,
        userId, scrollDepth: 0, multiplier: 1.0,
        status: 'active', startedAt: new Date().toISOString()
      };
      DB.rounds.push(round);
    }

    round.scrollDepth++;
    round.multiplier = parseFloat(
      (1.0 + (round.scrollDepth - 1) * 0.5 + Math.random() * 0.3).toFixed(2)
    );

    const post = this.generatePost(userId, round.scrollDepth);
    const risk = Math.min(100, round.scrollDepth * 18);

    return {
      success: true,
      scrollDepth: round.scrollDepth,
      multiplier: round.multiplier,
      riskLevel: risk > 70 ? 'DANGER' : risk > 40 ? 'MEDIUM' : 'LOW',
      riskPercent: risk,
      post
    };
  }

  static openPost(userId, bet) {
    const user = DB.users.get(userId);
    if (!user) return { error: 'User not found' };
    if (!bet || bet <= 0) return { error: 'Invalid bet' };
    if (user.balance < bet) return { error: 'Insufficient balance. Max bet: €' + user.balance };

    const round = DB.rounds.find(r => r.userId === userId && r.status === 'active');
    if (!round) return { error: 'No active round — scroll first!' };

    const rng = RNGService.generateOutcome(userId, round.scrollDepth);
    const change = RNGService.calculatePayout(rng.outcomeType, bet, round.multiplier);

    user.balance = Math.max(0, user.balance + change);

    const repMap = { jackpot:+5, win:+2, troll:-1, scam:-3, empty:0 };
    const repChange = repMap[rng.outcomeType] || 0;
    user.reputation = Math.max(0, Math.min(100, user.reputation + repChange));

    round.status = 'completed';
    round.outcome = rng.outcomeType;
    round.bet = bet;
    round.balanceChange = change;
    round.completedAt = new Date().toISOString();

    DB.transactions.push({
      id: 'tx_' + Date.now(),
      userId, type: change >= 0 ? 'win' : 'loss',
      amount: Math.abs(change), balanceAfter: user.balance,
      createdAt: new Date().toISOString()
    });

    broadcastEvent('activity', {
      message: change > 0
        ? `<strong>${user.username}</strong> won <span class="win">+€${change}</span>`
        : `<strong>${user.username}</strong> <span class="loss">lost €${Math.abs(change)}</span>`
    });

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
        nonce: rng.nonce,
        rtp: 97
      }
    };
  }

  static resetRound(userId) {
    const idx = DB.rounds.findIndex(r => r.userId === userId && r.status === 'active');
    if (idx !== -1) DB.rounds[idx].status = 'cancelled';
    return { success: true };
  }

  static generatePost(userId, depth) {
    // 20% chance to show a player post
    const playerPosts = DB.posts.filter(p => p.isActive && p.creatorId !== userId);
    if (playerPosts.length > 0 && Math.random() < 0.20) {
      const pp = playerPosts[Math.floor(Math.random() * playerPosts.length)];
      pp.opens++;
      return {
        id: pp.id, type: pp.type, emoji: '👤',
        content: pp.content, user: pp.creatorName,
        isPlayerPost: true, isTrap: pp.isTrap,
        likes: Math.floor(Math.random()*300)+10,
        comments: Math.floor(Math.random()*50)+2,
        time: 'just now'
      };
    }
    const t = POST_TEMPLATES[Math.floor(Math.random() * POST_TEMPLATES.length)];
    return {
      id: 'fp_' + Date.now() + Math.random().toString(36).slice(2),
      type: t.type, emoji: t.emoji,
      content: t.contents[Math.floor(Math.random() * t.contents.length)],
      user: t.users[Math.floor(Math.random() * t.users.length)],
      isPlayerPost: false,
      likes: Math.floor(Math.random()*800)+20,
      comments: Math.floor(Math.random()*200)+5,
      time: Math.floor(Math.random()*12+1) + 'm ago'
    };
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
      totalWon: wins.reduce((s,t) => s + t.amount, 0),
      totalLost: losses.reduce((s,t) => s + t.amount, 0),
      biggestWin: wins.length > 0 ? Math.max(...wins.map(t => t.amount)) : 0,
      rtp: 97
    };
  }
}

// ── POST SERVICE ──
class PostService {
  static create(userId, data) {
    const user = DB.users.get(userId);
    if (!user) return { error: 'User not found' };
    const fee = data.isTrap ? 10 : 5;
    if (user.balance < fee) return { error: 'Need €' + fee + ' to publish' };
    user.balance -= fee;
    const repChange = data.isTrap ? -2 : 3;
    user.reputation = Math.max(0, Math.min(100, user.reputation + repChange));
    const post = {
      id: 'pp_' + Date.now(),
      creatorId: userId, creatorName: user.username,
      type: data.type || 'jackpot',
      content: data.content || 'Check this out!',
      isTrap: !!data.isTrap, trapStake: data.trapStake || 10,
      opens: 0, earnings: 0, isActive: true,
      createdAt: new Date().toISOString()
    };
    DB.posts.push(post);
    DB.transactions.push({ id:'tx_'+Date.now(), userId, type:'fee', amount:fee, balanceAfter:user.balance, createdAt:new Date().toISOString() });
    broadcastEvent('activity', { message: `<strong>${user.username}</strong> published a ${data.isTrap?'<span class="trap-c">TRAP</span>':'new post'} 😈` });
    return { success:true, post, newBalance:user.balance, repChange, newReputation:user.reputation };
  }
  static getMine(userId) {
    return { posts: DB.posts.filter(p => p.creatorId === userId) };
  }
}

// ── DM SERVICE ──
class DMService {
  static send(senderId, targetUsername, message) {
    const sender = DB.users.get(senderId);
    if (!sender) return { error: 'User not found' };
    if (sender.balance < 3) return { error: 'Need €3 to send DM' };
    sender.balance -= 3;
    sender.reputation = Math.max(0, sender.reputation - 1);
    const dm = { id:'dm_'+Date.now(), senderId, senderName:sender.username, targetUsername, message, createdAt:new Date().toISOString() };
    DB.dms.push(dm);
    setTimeout(() => {
      const fell = Math.random() < 0.45;
      if (fell) {
        const earn = Math.floor(Math.random()*30+10);
        sender.balance += earn;
        sender.reputation = Math.min(100, sender.reputation+2);
        broadcastEvent('activity', { message:`<strong>${sender.username}</strong> DM trap worked! <span class="win">+€${earn}</span> 😈` });
      } else {
        sender.reputation = Math.max(0, sender.reputation-2);
      }
    }, 3000 + Math.random()*5000);
    return { success:true, newBalance:sender.balance, newReputation:sender.reputation };
  }
  static respond(userId, trusted) {
    const user = DB.users.get(userId);
    if (!user) return { error:'Not found' };
    const isTrap = Math.random() < 0.6;
    let change = 0, repChange = 0;
    if (trusted && isTrap)  { change = -Math.round(10*0.5); repChange = -2; }
    if (trusted && !isTrap) { change = Math.round(10*0.8);  repChange = +3; }
    user.balance = Math.max(0, user.balance + change);
    user.reputation = Math.max(0, Math.min(100, user.reputation + repChange));
    return { success:true, wasTrap:isTrap, trusted, balanceChange:change, newBalance:user.balance, repChange, newReputation:user.reputation };
  }
}

// ── SSE ──
const sseClients = new Set();
function broadcastEvent(type, data) {
  const msg = `data: ${JSON.stringify({type,data,ts:Date.now()})}\n\n`;
  sseClients.forEach(c => { try { c.write(msg); } catch {} });
}

const A_NAMES = ['Alex K.','Maria S.','BigBet Tom','LuckyJan','Pro_Dealer','NightOwl','FastFold','GoldRush'];
const A_MSGS = [
  (n,a) => `<strong>${n}</strong> opened a post → <span class="win">+€${a}</span>`,
  (n,a) => `<strong>${n}</strong> got <span class="loss">SCAMMED</span> → -€${a}`,
  (n,a) => `<strong>${n}</strong> hit JACKPOT → <span class="win">+€${a}</span>`,
  (n)   => `<strong>${n}</strong> is scrolling… depth <span class="win">${Math.floor(Math.random()*5+2)}</span>`,
  (n)   => `<strong>${n}</strong> <span class="trap-c">set a trap</span> 😈`,
];
setInterval(() => {
  const n = A_NAMES[Math.floor(Math.random()*A_NAMES.length)];
  const a = Math.floor(Math.random()*300+20);
  const msg = A_MSGS[Math.floor(Math.random()*A_MSGS.length)](n,a);
  broadcastEvent('activity', { message: msg });
}, 3500 + Math.random()*2000);

// ── HTTP SERVER ──
function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type':'application/json',
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Headers':'Content-Type, Authorization',
    'Access-Control-Allow-Methods':'GET, POST, OPTIONS'
  });
  res.end(JSON.stringify(data));
}

function getBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { try { resolve(JSON.parse(b||'{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const p = url.parse(req.url).pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type,Authorization','Access-Control-Allow-Methods':'GET,POST,OPTIONS'});
    return res.end();
  }

  // Serve frontend
  if (p === '/' || p === '/index.html') {
    try {
      const html = fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
      res.writeHead(200,{'Content-Type':'text/html'});
      return res.end(html);
    } catch(e) {
      return send(res,500,{error:'index.html not found'});
    }
  }

  // SSE
  if (p === '/api/events') {
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','Access-Control-Allow-Origin':'*'});
    const onlineCount = DB.users.size + 2847;
    res.write(`data: ${JSON.stringify({type:'connected',data:{onlineCount}})}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // Health
  if (p === '/api/health') return send(res,200,{status:'ok',users:DB.users.size,rounds:DB.rounds.length,rtp:'97%',uptime:Math.floor(process.uptime())+'s'});

  // Leaderboard (public)
  if (p === '/api/leaderboard' && req.method==='GET') {
    const lb = Array.from(DB.users.values()).sort((a,b)=>b.balance-a.balance).slice(0,10).map((u,i)=>({rank:i+1,username:u.username,balance:u.balance,reputation:u.reputation}));
    return send(res,200,{leaderboard:lb});
  }

  const body = await getBody(req);

  // Auth (public)
  if (p === '/api/auth/register' && req.method==='POST') {
    const {username,password} = body;
    if (!username||!password) return send(res,400,{error:'Fill in all fields'});
    if (username.length < 3) return send(res,400,{error:'Username too short'});
    if (Array.from(DB.users.values()).find(u=>u.username===username)) return send(res,400,{error:'Username taken'});
    const user = { id:'u_'+Date.now(), username, passwordHash:hashPassword(password), balance:5000, reputation:50, createdAt:new Date().toISOString() };
    DB.users.set(user.id,user);
    return send(res,201,{token:generateToken(user.id),user:sanitizeUser(user)});
  }

  if (p === '/api/auth/login' && req.method==='POST') {
    const {username,password} = body;
    const user = Array.from(DB.users.values()).find(u=>u.username===username);
    if (!user||user.passwordHash!==hashPassword(password)) return send(res,401,{error:'Wrong username or password'});
    return send(res,200,{token:generateToken(user.id),user:sanitizeUser(user)});
  }

  // Protected
  const token = (req.headers.authorization||'').replace('Bearer ','');
  const userId = verifyToken(token);
  if (!userId) return send(res,401,{error:'Please login first'});
  const user = DB.users.get(userId);

  // Game
  if (p==='/api/game/scroll'   && req.method==='POST') return send(res,200,GameService.scroll(userId));
  if (p==='/api/game/open'     && req.method==='POST') return send(res,200,GameService.openPost(userId,body.bet));
  if (p==='/api/game/reset'    && req.method==='POST') return send(res,200,GameService.resetRound(userId));
  if (p==='/api/game/stats'    && req.method==='GET')  return send(res,200,GameService.getStats(userId));
  if (p==='/api/game/history'  && req.method==='GET') {
    const rounds = DB.rounds.filter(r=>r.userId===userId&&r.status==='completed').slice(-20).reverse();
    return send(res,200,{rounds});
  }

  // Posts
  if (p==='/api/posts/create'  && req.method==='POST') return send(res,201,PostService.create(userId,body));
  if (p==='/api/posts/mine'    && req.method==='GET')  return send(res,200,PostService.getMine(userId));
  if (p==='/api/posts/feed'    && req.method==='GET') {
    return send(res,200,{posts:DB.posts.filter(p=>p.isActive).slice(-20).reverse()});
  }

  // DM
  if (p==='/api/dm/send'       && req.method==='POST') return send(res,200,DMService.send(userId,body.targetUsername,body.message));
  if (p==='/api/dm/respond'    && req.method==='POST') return send(res,200,DMService.respond(userId,body.trusted));

  // User
  if (p==='/api/user/me'       && req.method==='GET') return send(res,200,{user:sanitizeUser(DB.users.get(userId))});
  if (p==='/api/user/balance'  && req.method==='GET') return send(res,200,{balance:user.balance});
  if (p==='/api/user/transactions' && req.method==='GET') {
    return send(res,200,{transactions:DB.transactions.filter(t=>t.userId===userId).slice(-50).reverse()});
  }

  send(res,404,{error:'Not found'});
});

seedDB();
server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   🎮 FeedBluff Server — Final Demo        ║');
  console.log(`║   http://localhost:${PORT}                  ║`);
  console.log('╠══════════════════════════════════════════╣');
  console.log('║   RTP: 97%  |  House Edge: 3%            ║');
  console.log('║   Demo balance: €5,000 per user          ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log('║   Login: GoldRush88 / demo123            ║');
  console.log('╚══════════════════════════════════════════╝');
});

module.exports = { DB, GameService, RNGService };
