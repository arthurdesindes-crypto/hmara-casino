require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const ADMIN_IDS = ['856946688064225331'];

// Custom Supabase session store
const Store = require('express-session').Store;
class SupabaseStore extends Store {
  async get(sid, cb) {
    try {
      const { data } = await supabase.from('sessions').select('sess,expire').eq('sid', sid).single();
      if (!data) return cb(null, null);
      if (new Date(data.expire) < new Date()) {
        await supabase.from('sessions').delete().eq('sid', sid);
        return cb(null, null);
      }
      cb(null, data.sess);
    } catch (e) { cb(null, null); }
  }
  async set(sid, sess, cb) {
    try {
      const expire = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
      await supabase.from('sessions').upsert({ sid, sess, expire });
      cb(null);
    } catch (e) { cb(e); }
  }
  async destroy(sid, cb) {
    try {
      await supabase.from('sessions').delete().eq('sid', sid);
      cb(null);
    } catch (e) { cb(e); }
  }
}

app.use(cors({ origin: process.env.BASE_URL, credentials: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  store: new SupabaseStore(),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    maxAge: 365 * 24 * 60 * 60 * 1000,
    httpOnly: true
  }
}));

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Non connecté' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || !ADMIN_IDS.includes(req.session.user.discord_id))
    return res.status(403).json({ error: 'Accès refusé' });
  next();
}

// AUTH
app.get('/auth/login', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: `${process.env.BASE_URL}/auth/callback`,
    response_type: 'code',
    scope: 'identify',
    prompt: 'none'  // Skip auth screen if already authorized
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=no_code');
  try {
    const tokenRes = await axios.post('https://discord.com/api/oauth2/token',
      new URLSearchParams({ client_id: process.env.DISCORD_CLIENT_ID, client_secret: process.env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: `${process.env.BASE_URL}/auth/callback` }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const userRes = await axios.get('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${tokenRes.data.access_token}` } });
    const u = userRes.data;
    const { data: existing } = await supabase.from('users').select('*').eq('discord_id', u.id).single();
    if (!existing) await supabase.from('users').insert({ discord_id: u.id, username: u.username, avatar: u.avatar });
    else await supabase.from('users').update({ username: u.username, avatar: u.avatar }).eq('discord_id', u.id);
    req.session.user = { discord_id: u.id, username: u.username, avatar: u.avatar };
    req.session.save(() => res.redirect('/casino'));
  } catch (err) { console.error('Auth error:', err.message); res.redirect('/?error=auth_failed'); }
});

app.get('/auth/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

// USER API
app.get('/api/me', requireAuth, async (req, res) => {
  const { data } = await supabase.from('users').select('*').eq('discord_id', req.session.user.discord_id).single();
  res.json({ ...data, is_admin: ADMIN_IDS.includes(req.session.user.discord_id) });
});

app.post('/api/coins', requireAuth, async (req, res) => {
  const { amount } = req.body;
  const { data: user } = await supabase.from('users').select('coins,xp,level').eq('discord_id', req.session.user.discord_id).single();
  // Apply boost multiplier
  let finalAmount = amount;
  const boost = activeBoosts[req.session.user.discord_id];
  const malus = activeMalus[req.session.user.discord_id];
  
  if (amount > 0) {
    // Boosts on wins
    if (boost && boost.type === 'x2' && new Date(boost.expiresAt) > new Date()) {
      finalAmount = amount * 2;
    } else if (boost && boost.type === 'precision' && new Date(boost.expiresAt) > new Date()) {
      finalAmount = Math.round(amount * 1.25);
    } else if (boost && boost.type === 'luck' && new Date(boost.expiresAt) > new Date()) {
      finalAmount = Math.round(amount * 1.25);
    } else if (boost && boost.type === 'doublechance' && new Date(boost.expiresAt) > new Date()) {
      finalAmount = Math.round(amount * 1.5);
    }
    // Freeze malus reduces gains
    if (malus && malus.type === 'freeze' && new Date(malus.expiresAt) > new Date()) {
      finalAmount = Math.round(finalAmount * 0.5);
    }
  } else if (amount < 0) {
    // Protection absorbs loss
    if (boost && boost.type === 'protect' && new Date(boost.expiresAt) > new Date()) {
      finalAmount = 0;
      delete activeBoosts[req.session.user.discord_id];
      io.emit('malus:effect', { targetId: req.session.user.discord_id, type: 'protect_used' });
    }
    // Malediction doubles next loss
    if (malus && malus.type === 'malediction' && new Date(malus.expiresAt) > new Date()) {
      finalAmount = amount * 2;
      delete activeMalus[req.session.user.discord_id];
      io.emit('malus:effect', { targetId: req.session.user.discord_id, type: 'malediction_triggered', amount: finalAmount });
    }
  }
  const newCoins = Math.max(0, (user.coins || 0) + finalAmount);
  
  // XP system - gain XP for any game activity
  // XP system - hard progression
  let xpGain = 0;
  if (amount !== 0) xpGain = Math.max(2, Math.abs(Math.floor(amount * 0.08))) + 8; // slightly easier
  const newXP = (user.xp || 0) + xpGain;
  // Much higher thresholds
  const XP_THRESHOLDS = [0,1000,3000,6000,10000,15000,22000,30000,40000,52000,66000,82000,100000,120000,150000];
  const newLevel = XP_THRESHOLDS.filter(t => newXP >= t).length;
  const levelUp = newLevel > (user.level || 1);
  
  // Jackpot contribution when losing
  if (amount < 0) addToJackpot(Math.abs(amount));
  
  // Random jackpot win (0.5% chance per loss)
  let jackpotWon = false;
  if (amount < 0 && Math.random() < 0.005 && jackpotPool > 1000) {
    jackpotWon = true;
    const prize = jackpotPool;
    jackpotPool = 5000;
    await supabase.from('users').update({ coins: newCoins + prize, xp: newXP, level: newLevel }).eq('discord_id', req.session.user.discord_id);
    io.emit('jackpot:won', { username: req.session.user.username, prize, pool: jackpotPool });
    io.emit('jackpot:update', { pool: jackpotPool });
    return res.json({ coins: newCoins + prize, xp: newXP, level: newLevel, levelUp, jackpotWon: true, jackpotPrize: prize });
  }
  
  await supabase.from('users').update({ coins: newCoins, xp: newXP, level: newLevel }).eq('discord_id', req.session.user.discord_id);
  res.json({ coins: newCoins, xp: newXP, level: newLevel, levelUp, xpGain });
});

app.post('/api/buy', requireAuth, async (req, res) => {
  const { reward_name, price } = req.body;
  const { data: user } = await supabase.from('users').select('coins').eq('discord_id', req.session.user.discord_id).single();
  if (user.coins < price) return res.status(400).json({ error: 'Pas assez de pièces' });
  const newCoins = user.coins - price;
  await supabase.from('users').update({ coins: newCoins }).eq('discord_id', req.session.user.discord_id);
  await supabase.from('purchases').insert({ discord_id: req.session.user.discord_id, reward_name, price });
  try { await axios.post(`${process.env.BOT_URL || "http://localhost:3001"}/notify`, { username: req.session.user.username, reward_name, price }); } catch (e) {}
  res.json({ coins: newCoins, success: true });
});

app.get('/api/leaderboard', async (req, res) => {
  const { data } = await supabase.from('users').select('discord_id,username,coins,avatar,xp,level').order('coins', { ascending: false }).limit(10);
  res.json(data);
});

app.get('/api/online', requireAuth, (req, res) => {
  res.json({ online: Array.from(onlineUsers) });
});

// XP Leaderboard
app.get('/api/xp-leaderboard', requireAuth, async (req, res) => {
  const { data } = await supabase.from('users').select('discord_id,username,avatar,xp,level').order('xp', { ascending: false }).limit(20);
  res.json(data || []);
});

// Jackpot
app.get('/api/jackpot', (req, res) => {
  res.json({ pool: jackpotPool });
});

// Coffre mystere
app.post('/api/chest/open', requireAuth, async (req, res) => {
  if (!activeChest) return res.status(400).json({ error: 'Aucun coffre disponible' });
  const prize = activeChest.prize;
  activeChest = null;
  const { data: user } = await supabase.from('users').select('coins').eq('discord_id', req.session.user.discord_id).single();
  await supabase.from('users').update({ coins: (user.coins || 0) + prize }).eq('discord_id', req.session.user.discord_id);
  io.emit('chest:opened', { username: req.session.user.username, prize });
  io.emit('chest:expire', {});
  setTimeout(spawnChest, chestInterval);
  res.json({ prize, success: true });
});

// Stats personnelles
app.get('/api/stats', requireAuth, async (req, res) => {
  const { data: user } = await supabase.from('users').select('coins,xp,level').eq('discord_id', req.session.user.discord_id).single();
  const { data: purchases } = await supabase.from('purchases').select('price').eq('discord_id', req.session.user.discord_id);
  const totalSpent = (purchases || []).reduce((s, p) => s + p.price, 0);
  res.json({ ...user, totalSpent, xpToNext: 1000 - ((user.xp || 0) % 1000) });
});

// Defis quotidiens
app.get('/api/challenges', requireAuth, async (req, res) => {
  const today = new Date().toDateString();
  const challenges = [
    { id: 'play5', label: 'Jouer 5 parties', reward: 500, key: `ch_play5_${today}` },
    { id: 'win3', label: 'Gagner 3 parties', reward: 1000, key: `ch_win3_${today}` },
    { id: 'spend2000', label: 'Miser 2000 pieces', reward: 750, key: `ch_spend2000_${today}` },
  ];
  // Check localStorage progress on client side
  res.json({ challenges });
});

app.post('/api/challenges/claim', requireAuth, async (req, res) => {
  const { challengeId, reward } = req.body;
  const { data: user } = await supabase.from('users').select('coins').eq('discord_id', req.session.user.discord_id).single();
  await supabase.from('users').update({ coins: (user.coins || 0) + reward }).eq('discord_id', req.session.user.discord_id);
  res.json({ success: true, coins: (user.coins || 0) + reward });
});

// ADMIN API
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const { data } = await supabase.from('users').select('*').order('coins', { ascending: false });
  res.json(data);
});

app.post('/api/admin/coins', requireAdmin, async (req, res) => {
  const { discord_id, amount } = req.body;
  const { data: user } = await supabase.from('users').select('coins').eq('discord_id', discord_id).single();
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  const newCoins = Math.max(0, user.coins + amount);
  await supabase.from('users').update({ coins: newCoins }).eq('discord_id', discord_id);
  res.json({ success: true, coins: newCoins });
});

app.post('/api/admin/xp', requireAdmin, async (req, res) => {
  const { discord_id, amount } = req.body;
  const { data: user } = await supabase.from('users').select('xp,level').eq('discord_id', discord_id).single();
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  const newXP = Math.max(0, (user.xp || 0) + amount);
  const XP_THRESHOLDS = [0,1000,3000,6000,10000,15000,22000,30000,40000,52000,66000,82000,100000,120000,150000];
  const newLevel = XP_THRESHOLDS.filter(t => newXP >= t).length;
  await supabase.from('users').update({ xp: newXP, level: newLevel }).eq('discord_id', discord_id);
  res.json({ success: true, xp: newXP, level: newLevel });
});

app.post('/api/admin/ban', requireAdmin, async (req, res) => {
  const { discord_id } = req.body;
  await supabase.from('users').update({ banned: true }).eq('discord_id', discord_id);
  res.json({ success: true });
});

app.post('/api/admin/unban', requireAdmin, async (req, res) => {
  const { discord_id } = req.body;
  await supabase.from('users').update({ banned: false }).eq('discord_id', discord_id);
  res.json({ success: true });
});

app.get('/api/admin/purchases', requireAdmin, async (req, res) => {
  const { data } = await supabase.from('purchases').select('*, users(username)').order('purchased_at', { ascending: false }).limit(50);
  res.json(data);
});

// Get Discord members for shop
app.get('/api/members', requireAuth, async (req, res) => {
  try {
    const r = await axios.get(`${process.env.BOT_URL || "http://localhost:3001"}/members`);
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: 'Bot non disponible' });
  }
});

// Bot actions
app.post('/api/bot/ban', requireAuth, async (req, res) => {
  const { targetId, duration, reason } = req.body;
  try {
    const r = await axios.post(`${process.env.BOT_URL || "http://localhost:3001"}/ban`, {
      targetId, duration, reason,
      buyerUsername: req.session.user.username
    });
    res.json(r.data);
  } catch (err) {
    const msg = err.response?.data?.error || err.message;
    res.status(400).json({ error: msg });
  }
});

app.post('/api/bot/give-role', requireAuth, async (req, res) => {
  const { targetId, roleId, duration } = req.body;
  try {
    const r = await axios.post(`${process.env.BOT_URL || "http://localhost:3001"}/give-role`, {
      targetId, roleId, duration,
      buyerUsername: req.session.user.username
    });
    res.json(r.data);
  } catch (err) {
    const msg = err.response?.data?.error || err.message;
    res.status(400).json({ error: msg });
  }
});

app.post('/api/bot/remove-pass', requireAuth, async (req, res) => {
  const { targetId } = req.body;
  try {
    const r = await axios.post(`${process.env.BOT_URL || "http://localhost:3001"}/remove-pass`, {
      targetId,
      buyerUsername: req.session.user.username
    });
    res.json(r.data);
  } catch (err) {
    const msg = err.response?.data?.error || err.message;
    res.status(400).json({ error: msg });
  }
});

// Transfer coins between players
app.post('/api/transfer', requireAuth, async (req, res) => {
  const { targetId, amount } = req.body;
  if (!targetId || !amount || amount < 1) return res.status(400).json({ error: 'Donnees invalides' });
  if (targetId === req.session.user.discord_id) return res.status(400).json({ error: 'Vous ne pouvez pas vous envoyer des pieces' });
  const amt = Math.min(parseInt(amount), 10000);
  const { data: sender } = await supabase.from('users').select('coins').eq('discord_id', req.session.user.discord_id).single();
  if (!sender || sender.coins < amt) return res.status(400).json({ error: 'Pas assez de pieces' });
  const { data: target } = await supabase.from('users').select('coins').eq('discord_id', targetId).single();
  if (!target) return res.status(404).json({ error: 'Joueur introuvable' });
  await supabase.from('users').update({ coins: sender.coins - amt }).eq('discord_id', req.session.user.discord_id);
  await supabase.from('users').update({ coins: target.coins + amt }).eq('discord_id', targetId);
  res.json({ success: true, coins: sender.coins - amt });
});


// CHAT
app.get('/api/chat', requireAuth, (req, res) => {
  res.json(chatHistory.slice(-30));
});

// BOOSTS
app.get('/api/boosts', requireAuth, (req, res) => {
  const boost = activeBoosts[req.session.user.discord_id];
  if (boost && new Date(boost.expiresAt) > new Date()) {
    res.json({ active: boost });
  } else {
    delete activeBoosts[req.session.user.discord_id];
    res.json({ active: null });
  }
});

const activeMalus = {}; // discord_id -> { type, expiresAt }

const BOOST_DURATIONS = {
  x2: 10*60*1000, protect: 5*60*1000, luck: 15*60*1000,
  cagnotte: 0, eclair: 20*60*1000, precision: 15*60*1000,
  vip: 10*60*1000, doublechance: 5*60*1000
};

app.post('/api/boosts/activate', requireAuth, async (req, res) => {
  const { type, cost } = req.body;
  const { data: user } = await supabase.from('users').select('coins').eq('discord_id', req.session.user.discord_id).single();
  if (!user || user.coins < cost) return res.status(400).json({ error: 'Pas assez de pieces' });
  
  let newCoins = user.coins - cost;
  
  // Special: cagnotte gives instant coins
  if (type === 'cagnotte') {
    newCoins += 500;
    await supabase.from('users').update({ coins: newCoins }).eq('discord_id', req.session.user.discord_id);
    return res.json({ success: true, boost: null, coins: newCoins, instant: 500 });
  }
  
  await supabase.from('users').update({ coins: newCoins }).eq('discord_id', req.session.user.discord_id);
  const duration = BOOST_DURATIONS[type] || 10*60*1000;
  activeBoosts[req.session.user.discord_id] = { type, expiresAt: new Date(Date.now() + duration) };
  res.json({ success: true, boost: activeBoosts[req.session.user.discord_id], coins: newCoins });
});

// MALUS - send to another player
app.post('/api/malus/send', requireAuth, async (req, res) => {
  const { targetId, type, cost } = req.body;
  if (targetId === req.session.user.discord_id) return res.status(400).json({ error: 'Vous ne pouvez pas vous envoyer un malus !' });
  
  const { data: user } = await supabase.from('users').select('coins,username').eq('discord_id', req.session.user.discord_id).single();
  if (!user || user.coins < cost) return res.status(400).json({ error: 'Pas assez de pieces' });
  
  const { data: target } = await supabase.from('users').select('coins,username').eq('discord_id', targetId).single();
  if (!target) return res.status(404).json({ error: 'Joueur introuvable' });
  
  await supabase.from('users').update({ coins: user.coins - cost }).eq('discord_id', req.session.user.discord_id);
  
  // Apply ALL malus effects immediately or set duration
  if (type === 'taxe') {
    const tax = Math.floor(target.coins * 0.08);
    await supabase.from('users').update({ coins: Math.max(0, target.coins - tax) }).eq('discord_id', targetId);
    console.log(`Taxe: -${tax} coins from ${target.username}`);
  } else if (type === 'bomb') {
    const loss = Math.min(500, target.coins);
    await supabase.from('users').update({ coins: Math.max(0, target.coins - 500) }).eq('discord_id', targetId);
    console.log(`Bomb: -500 coins from ${target.username}`);
  } else if (type === 'tempete') {
    const loss = Math.floor(target.coins * 0.10);
    await supabase.from('users').update({ coins: Math.max(0, target.coins - loss) }).eq('discord_id', targetId);
    console.log(`Tempete: -${loss} coins from ${target.username}`);
  } else if (type === 'stealboost') {
    delete activeBoosts[targetId];
    console.log(`StealBoost: removed boost from ${target.username}`);
  } else if (type === 'haunt') {
    // Drain 2% every minute for 10 minutes
    let minutes = 0;
    const hauntInterval = setInterval(async () => {
      minutes++;
      const { data: victim } = await supabase.from('users').select('coins').eq('discord_id', targetId).single();
      if (victim) {
        const drain = Math.floor(victim.coins * 0.02);
        if (drain > 0) {
          await supabase.from('users').update({ coins: Math.max(0, victim.coins - drain) }).eq('discord_id', targetId);
          io.emit('malus:effect', { targetId, type: 'haunt', amount: drain });
        }
      }
      if (minutes >= 10) clearInterval(hauntInterval);
    }, 60 * 1000);
  } else if (type === 'malediction') {
    // Store malediction - will double next loss via coins API
    activeMalus[targetId] = { type: 'malediction', expiresAt: new Date(Date.now() + 30 * 60 * 1000), from: user.username };
  }
  
  const MALUS_DURATIONS = { 
    slow: 15*60*1000, confusion: 5*60*1000, silence: 15*60*1000, 
    malediction: 0, taxe: 0, tempete: 0, bomb: 0,
    stealboost: 0, freeze: 10*60*1000, haunt: 10*60*1000
  };
  const duration = MALUS_DURATIONS[type] !== undefined ? MALUS_DURATIONS[type] : 10*60*1000;
  if (duration > 0 && type !== 'malediction') {
    activeMalus[targetId] = { type, expiresAt: new Date(Date.now() + duration), from: user.username };
  }
  
  // Notify target via socket
  io.emit('malus:received', { targetId, type, from: user.username });
  
  res.json({ success: true, coins: user.coins - cost, targetName: target.username });
});

// Check malus for a player
app.get('/api/malus', requireAuth, (req, res) => {
  const malus = activeMalus[req.session.user.discord_id];
  if (malus && new Date(malus.expiresAt) > new Date()) {
    res.json({ active: malus });
  } else {
    delete activeMalus[req.session.user.discord_id];
    res.json({ active: null });
  }
});


});

// STREAK
app.post('/api/streak', requireAuth, async (req, res) => {
  const { data: user } = await supabase.from('users').select('streak,last_login,coins').eq('discord_id', req.session.user.discord_id).single();
  const today = new Date().toDateString();
  const lastLogin = user.last_login ? new Date(user.last_login).toDateString() : null;
  const yesterday = new Date(Date.now() - 86400000).toDateString();
  
  if (lastLogin === today) return res.json({ streak: user.streak || 0, bonus: 0, already: true });
  
  const newStreak = lastLogin === yesterday ? (user.streak || 0) + 1 : 1;
  const bonus = Math.min(newStreak * 50, 1000); // Max 1000 bonus
  const newCoins = (user.coins || 0) + bonus;
  
  await supabase.from('users').update({ streak: newStreak, last_login: new Date().toISOString(), coins: newCoins }).eq('discord_id', req.session.user.discord_id);
  res.json({ streak: newStreak, bonus, coins: newCoins });
});

// PAGES

app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/casino');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/casino', requireAuth, async (req, res) => {
  const { data } = await supabase.from('users').select('banned').eq('discord_id', req.session.user.discord_id).single();
  if (data && data.banned) return res.redirect('/?error=banned');
  res.sendFile(path.join(__dirname, 'public', 'casino.html'));
});
app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// SOCKET MULTIJOUEUR
const rooms = {};

// ═══ CHAT EN DIRECT ══════════════════════════════════════════════
const chatHistory = [];
const MAX_CHAT = 50;

// ═══ BOOSTS ══════════════════════════════════════════════════════
const activeBoosts = {}; // discord_id -> { type, expiresAt }

// ═══ TOURNOI HEBDOMADAIRE ════════════════════════════════════════

function getWeekKey() {
  const d = new Date();
  const week = Math.floor(d.getTime() / (7 * 24 * 60 * 60 * 1000));
  return `week_${week}`;
}

let jackpotPool = 5000; // Jackpot progressif
let activeChest = null; // Coffre mystere
const chestInterval = 60 * 60 * 1000; // 1 heure

// Jackpot progressif - grossit avec chaque mise perdue
function addToJackpot(amount) {
  jackpotPool += Math.floor(amount * 0.02); // 2% des mises vont au jackpot
  io.emit('jackpot:update', { pool: jackpotPool });
}

// Coffre mystere - apparait toutes les heures
function spawnChest() {
  const prize = 500 + Math.floor(Math.random() * 2000);
  activeChest = { prize, spawnedAt: Date.now() };
  io.emit('chest:spawn', { prize });
  setTimeout(() => {
    if (activeChest) {
      activeChest = null;
      io.emit('chest:expire', {});
    }
    setTimeout(spawnChest, chestInterval);
  }, 5 * 60 * 1000); // Disparait apres 5 minutes
}
setTimeout(spawnChest, 10 * 60 * 1000); // Premier coffre apres 10 min
const onlineUsers = new Set(); // Track online discord_ids

io.on('connection', (socket) => {
  // Track online user
  socket.on('user:online', ({ discord_id }) => {
    socket.discordId = discord_id;
    onlineUsers.add(discord_id);
    io.emit('online:update', { online: Array.from(onlineUsers) });
  });

  socket.on('dice:join', ({ username, avatar, discord_id, bet }) => {
    let room = Object.values(rooms).find(r => r.type === 'dice' && r.players.length < 2 && !r.started);
    if (!room) { const id = 'dice_' + Date.now(); room = { id, type: 'dice', players: [], bet, started: false }; rooms[id] = room; }
    if (room.players.find(p => p.discord_id === discord_id)) return;
    room.players.push({ id: socket.id, username, avatar, discord_id, bet });
    socket.join(room.id); socket.roomId = room.id;
    io.to(room.id).emit('dice:update', { players: room.players.map(p => ({ username: p.username, avatar: p.avatar, discord_id: p.discord_id })), count: room.players.length });
  });

  socket.on('horse:join', ({ username, avatar, discord_id, horse, bet }) => {
    let room = Object.values(rooms).find(r => r.type === 'horse' && !r.started && r.players.length < 4);
    if (!room) { const id = 'horse_' + Date.now(); room = { id, type: 'horse', players: [], started: false, bet }; rooms[id] = room; }
    if (room.players.find(p => p.discord_id === discord_id)) return;
    room.players.push({ id: socket.id, username, avatar, discord_id, horse, bet });
    socket.join(room.id); socket.roomId = room.id;
    io.to(room.id).emit('horse:update', { players: room.players.map(p => ({ username: p.username, horse: p.horse, avatar: p.avatar, discord_id: p.discord_id })), count: room.players.length });
  });

  socket.on('poker:join', ({ username, avatar, discord_id, bet }) => {
    let room = Object.values(rooms).find(r => r.type === 'poker' && !r.started && r.players.length < 4);
    if (!room) { const id = 'poker_' + Date.now(); room = { id, type: 'poker', players: [], started: false, bet }; rooms[id] = room; }
    if (room.players.find(p => p.discord_id === discord_id)) return;
    const suits = ['s','h','d','c'], vals = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    const hand = [{ v: vals[Math.floor(Math.random()*13)], s: suits[Math.floor(Math.random()*4)] }, { v: vals[Math.floor(Math.random()*13)], s: suits[Math.floor(Math.random()*4)] }];
    room.players.push({ id: socket.id, username, avatar, discord_id, bet, hand });
    socket.join(room.id); socket.roomId = room.id;
    io.to(room.id).emit('poker:update', { players: room.players.map(p => ({ username: p.username, avatar: p.avatar, discord_id: p.discord_id })), count: room.players.length });
  });

  socket.on('bataille:join', ({ username, avatar, discord_id, bet }) => {
    let room = Object.values(rooms).find(r => r.type === 'bataille' && r.players.length < 2 && !r.started);
    if (!room) { const id = 'bat_' + Date.now(); room = { id, type: 'bataille', players: [], started: false, bet }; rooms[id] = room; }
    if (room.players.find(p => p.discord_id === discord_id)) return;
    const suits = ['s','h','d','c'], vals = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    const card = { v: vals[Math.floor(Math.random()*13)], s: suits[Math.floor(Math.random()*4)] };
    room.players.push({ id: socket.id, username, avatar, discord_id, bet, card });
    socket.join(room.id); socket.roomId = room.id;
    io.to(room.id).emit('bataille:update', { players: room.players.map(p => ({ username: p.username, avatar: p.avatar, discord_id: p.discord_id })) });
  });

  socket.on('loto:join', ({ username, avatar, discord_id, bet, numbers }) => {
    let room = Object.values(rooms).find(r => r.type === 'loto' && !r.started && r.players.length < 4);
    if (!room) { const id = 'loto_' + Date.now(); room = { id, type: 'loto', players: [], started: false, bet }; rooms[id] = room; }
    if (room.players.find(p => p.discord_id === discord_id)) return;
    room.players.push({ id: socket.id, username, avatar, discord_id, bet, numbers });
    socket.join(room.id); socket.roomId = room.id;
    io.to(room.id).emit('loto:update', { players: room.players.map(p => ({ username: p.username, avatar: p.avatar, discord_id: p.discord_id, numbers: p.numbers })), count: room.players.length });
  });

  socket.on('v21:join', ({ username, avatar, discord_id, bet }) => {
    let room = Object.values(rooms).find(r => r.type === 'v21' && !r.started && r.players.length < 4);
    if (!room) { const id = 'v21_' + Date.now(); room = { id, type: 'v21', players: [], started: false, bet, total: 0, turn: 0 }; rooms[id] = room; }
    if (room.players.find(p => p.discord_id === discord_id)) return;
    room.players.push({ id: socket.id, username, avatar, discord_id });
    socket.join(room.id); socket.roomId = room.id;
    io.to(room.id).emit('v21:update', { players: room.players.map(p => ({ username: p.username, discord_id: p.discord_id })), count: room.players.length });
  });

  socket.on('v21:play', ({ n, discord_id }) => {
    const room = Object.values(rooms).find(r => r.type === 'v21' && r.started && r.players[r.turn]?.discord_id === discord_id);
    if (!room) return;
    room.total += n;
    if (room.total > 21) {
      const loser = room.players[room.turn].discord_id;
      const winners = room.players.filter(p => p.discord_id !== loser);
      winners.forEach(p => { supabase.from('users').select('coins').eq('discord_id', p.discord_id).single().then(({data}) => { if(data) supabase.from('users').update({ coins: data.coins + Math.floor(room.bet * room.players.length / winners.length) }).eq('discord_id', p.discord_id); }); });
      io.to(room.id).emit('v21:end', { loser, players: room.players.map(p => ({ username: p.username, discord_id: p.discord_id })) });
      delete rooms[room.id];
    } else {
      room.turn = (room.turn + 1) % room.players.length;
      io.to(room.id).emit('v21:update-game', { total: room.total, turn: room.turn, players: room.players.map(p => ({ username: p.username, discord_id: p.discord_id })) });
    }
  });

  socket.on('mrace:join', ({ username, avatar, discord_id, bet }) => {
    let room = Object.values(rooms).find(r => r.type === 'mrace' && !r.started && r.players.length < 4);
    if (!room) { const id = 'mrace_' + Date.now(); room = { id, type: 'mrace', players: [], started: false, bet }; rooms[id] = room; }
    if (room.players.find(p => p.discord_id === discord_id)) return;
    room.players.push({ id: socket.id, username, avatar, discord_id, progress: 0 });
    socket.join(room.id); socket.roomId = room.id;
    io.to(room.id).emit('mrace:update', { players: room.players.map(p => ({ username: p.username, discord_id: p.discord_id })), count: room.players.length });
  });

  socket.on('mrace:click', ({ discord_id, progress }) => {
    const room = Object.values(rooms).find(r => r.type === 'mrace' && r.started && r.players.find(p => p.discord_id === discord_id));
    if (!room) return;
    const player = room.players.find(p => p.discord_id === discord_id);
    if (!player) return;
    player.progress = progress;
    io.to(room.id).emit('mrace:progress', { discord_id, progress });
    if (progress >= 100) {
      const winner = discord_id;
      room.players.forEach(p => {
        const won = p.discord_id === winner;
        supabase.from('users').select('coins').eq('discord_id', p.discord_id).single().then(({data}) => { if(data) supabase.from('users').update({ coins: data.coins + (won ? room.bet * (room.players.length - 1) : 0) }).eq('discord_id', p.discord_id); });
      });
      io.to(room.id).emit('mrace:end', { winner, players: room.players.map(p => ({ username: p.username, discord_id: p.discord_id })) });
      delete rooms[room.id];
    }
  });

  socket.on('guess:join', ({ username, avatar, discord_id, bet }) => {
    let room = Object.values(rooms).find(r => r.type === 'guess' && !r.started && r.players.length < 2);
    if (!room) { const id = 'guess_' + Date.now(); room = { id, type: 'guess', players: [], started: false, bet, secrets: {} }; rooms[id] = room; }
    if (room.players.find(p => p.discord_id === discord_id)) return;
    room.players.push({ id: socket.id, username, avatar, discord_id });
    socket.join(room.id); socket.roomId = room.id;
    io.to(room.id).emit('guess:update', { players: room.players.map(p => ({ username: p.username, discord_id: p.discord_id })) });
  });

  socket.on('guess:play', ({ discord_id, secret, guess }) => {
    const room = Object.values(rooms).find(r => r.type === 'guess' && r.started && r.players.find(p => p.discord_id === discord_id));
    if (!room) return;
    room.secrets[discord_id] = secret;
    const opponent = room.players.find(p => p.discord_id !== discord_id);
    if (!opponent) return;
    const oppSecret = room.secrets[opponent.discord_id];
    if (oppSecret) {
      const hint = guess === oppSecret ? 'correct' : guess < oppSecret ? 'trop bas' : 'trop haut';
      io.to(room.id).emit('guess:hint', { hint, guesser: discord_id, target: opponent.username });
      if (guess === oppSecret) {
        supabase.from('users').select('coins').eq('discord_id', discord_id).single().then(({data}) => { if(data) supabase.from('users').update({ coins: data.coins + room.bet * 2 }).eq('discord_id', discord_id); });
        io.to(room.id).emit('guess:end', { winner: discord_id, players: room.players.map(p => ({ username: p.username, discord_id: p.discord_id })), secret: oppSecret });
        delete rooms[room.id];
      }
    }
  });

  socket.on('bjm:join', ({ username, avatar, discord_id, bet }) => {
    let room = Object.values(rooms).find(r => r.type === 'bjm' && !r.started && r.players.length < 4);
    if (!room) { const id = 'bjm_' + Date.now(); room = { id, type: 'bjm', players: [], started: false, bet, dealer: [] }; rooms[id] = room; }
    if (room.players.find(p => p.discord_id === discord_id)) return;
    const suits=['s','h','d','c'],vals=['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    const hand=[{v:vals[Math.floor(Math.random()*13)],s:suits[Math.floor(Math.random()*4)]},{v:vals[Math.floor(Math.random()*13)],s:suits[Math.floor(Math.random()*4)]}];
    room.players.push({ id: socket.id, username, avatar, discord_id, hand, stood: false });
    socket.join(room.id); socket.roomId = room.id;
    io.to(room.id).emit('bjm:update', { players: room.players.map(p => ({ username: p.username, discord_id: p.discord_id })), count: room.players.length });
  });

  socket.on('bjm:stand', ({ discord_id, score, hand }) => {
    const room = Object.values(rooms).find(r => r.type === 'bjm' && r.started && r.players.find(p => p.discord_id === discord_id));
    if (!room) return;
    const player = room.players.find(p => p.discord_id === discord_id);
    if (player) { player.stood = true; player.score = score; }
    if (room.players.every(p => p.stood)) {
      const vals2=['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
      const best = room.players.reduce((best, p) => { const valid = p.score <= 21 ? p.score : 0; return valid > best.score ? { discord_id: p.discord_id, score: valid } : best; }, { discord_id: null, score: 0 });
      const winner = best.discord_id;
      room.players.forEach(p => {
        const won = p.discord_id === winner;
        supabase.from('users').select('coins').eq('discord_id', p.discord_id).single().then(({data}) => { if(data) supabase.from('users').update({ coins: data.coins + (won ? room.bet * room.players.length : 0) }).eq('discord_id', p.discord_id); });
      });
      io.to(room.id).emit('bjm:result', { winner, dealer: room.dealer, players: room.players.map(p => ({ username: p.username, discord_id: p.discord_id })) });
      delete rooms[room.id];
    }
  });

  socket.on('dtournoi:join', ({ username, avatar, discord_id, bet }) => {
    let room = Object.values(rooms).find(r => r.type === 'dtournoi' && !r.started && r.players.length < 4);
    if (!room) { const id = 'dt_' + Date.now(); room = { id, type: 'dtournoi', players: [], started: false, bet }; rooms[id] = room; }
    if (room.players.find(p => p.discord_id === discord_id)) return;
    room.players.push({ id: socket.id, username, avatar, discord_id });
    socket.join(room.id); socket.roomId = room.id;
    io.to(room.id).emit('dtournoi:update', { players: room.players.map(p => ({ username: p.username, discord_id: p.discord_id })), count: room.players.length });
  });

  socket.on('game:start', ({ roomType }) => {
    const room = Object.values(rooms).find(r => r.type === roomType && r.players.find(p => p.id === socket.id) && !r.started);
    if (!room || room.players.length < 2) return;
    room.started = true;
    room.players.forEach(p => {
      supabase.from('users').select('coins').eq('discord_id', p.discord_id).single().then(({data}) => {
        if(data) supabase.from('users').update({ coins: Math.max(0, data.coins - room.bet) }).eq('discord_id', p.discord_id);
      });
    });
    if (roomType === 'dice') {
      setTimeout(() => {
        const r1=Math.floor(Math.random()*6)+1+Math.floor(Math.random()*6)+1;
        const r2=Math.floor(Math.random()*6)+1+Math.floor(Math.random()*6)+1;
        const winner=r1>r2?0:r2>r1?1:-1;
        io.to(room.id).emit('dice:result',{rolls:[r1,r2],winner,players:room.players.map(p=>({username:p.username,discord_id:p.discord_id}))});
        if(winner!==-1){
          const w=room.players[winner];
          supabase.from('users').select('coins').eq('discord_id',w.discord_id).single().then(({data})=>{if(data)supabase.from('users').update({coins:data.coins+room.bet*2}).eq('discord_id',w.discord_id);});
        }
        delete rooms[room.id];
      }, 1500);
    } else if (roomType === 'horse') {
      io.to(room.id).emit('horse:starting', { players: room.players.map(p => ({ username: p.username, horse: p.horse })) });
      setTimeout(() => {
        const winner = Math.floor(Math.random()*4);
        io.to(room.id).emit('horse:result', { winner, players: room.players.map(p => ({ username: p.username, horse: p.horse, discord_id: p.discord_id })) });
        room.players.forEach(p => {
          const won = p.horse === winner;
          supabase.from('users').select('coins').eq('discord_id', p.discord_id).single().then(({data}) => {
            if (!data) return;
            const nc = won ? data.coins + room.bet * room.players.length : Math.max(0, data.coins);
            supabase.from('users').update({ coins: nc }).eq('discord_id', p.discord_id);
          });
        });
        delete rooms[room.id];
      }, 5000);
    } else if (roomType === 'poker') {
      const suits=['s','h','d','c'],vals=['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
      room.players.forEach(p => {
        if (!p.hand) p.hand = [{v:vals[Math.floor(Math.random()*13)],s:suits[Math.floor(Math.random()*4)]},{v:vals[Math.floor(Math.random()*13)],s:suits[Math.floor(Math.random()*4)]}];
        io.to(p.id).emit('poker:deal', { hand: p.hand, pot: room.bet * room.players.length });
      });
      setTimeout(() => {
        const rankHand = h => Math.max(...h.map(c => ['2','3','4','5','6','7','8','9','10','J','Q','K','A'].indexOf(c.v)));
        const scores = room.players.map(p => rankHand(p.hand));
        const winnerIdx = scores.indexOf(Math.max(...scores));
        const winner = room.players[winnerIdx];
        const pot = room.bet * room.players.length;
        supabase.from('users').select('coins').eq('discord_id', winner.discord_id).single().then(({data}) => { if(data) supabase.from('users').update({ coins: data.coins + pot }).eq('discord_id', winner.discord_id); });
        io.to(room.id).emit('poker:result', { winner: winner.discord_id, pot, players: room.players.map(p => ({ username: p.username, discord_id: p.discord_id })) });
        delete rooms[room.id];
      }, 3000);
    } else if (roomType === 'bataille') {
      const suits=['s','h','d','c'],vals=['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
      room.players.forEach(p => { if(!p.card) p.card={v:vals[Math.floor(Math.random()*13)],s:suits[Math.floor(Math.random()*4)]}; });
      const scores = room.players.map(p => vals.indexOf(p.card.v));
      const winnerIdx = scores[0]>scores[1]?0:scores[1]>scores[0]?1:Math.floor(Math.random()*2);
      const winner = room.players[winnerIdx];
      supabase.from('users').select('coins').eq('discord_id', winner.discord_id).single().then(({data}) => { if(data) supabase.from('users').update({ coins: data.coins + room.bet * 2 }).eq('discord_id', winner.discord_id); });
      setTimeout(() => {
        io.to(room.id).emit('bataille:result', { cards: room.players.map(p => p.card), winner: winnerIdx, players: room.players.map(p => ({ username: p.username, discord_id: p.discord_id })) });
        delete rooms[room.id];
      }, 1500);
    } else if (roomType === 'loto') {
      const drawn=[];while(drawn.length<5){const n=Math.floor(Math.random()*30)+1;if(!drawn.includes(n))drawn.push(n);}
      const scores=room.players.map(p=>({discord_id:p.discord_id,score:p.numbers?p.numbers.filter(n=>drawn.includes(n)).length:0}));
      const maxScore=Math.max(...scores.map(s=>s.score));
      const winnerScore=scores.find(s=>s.score===maxScore);
      const winnerPlayer=room.players.find(p=>p.discord_id===winnerScore.discord_id);
      const pot=room.bet*room.players.length;
      room.players.forEach(p=>{
        const won=p.discord_id===winnerPlayer.discord_id;
        supabase.from('users').select('coins').eq('discord_id',p.discord_id).single().then(({data})=>{if(!data)return;const nc=won?data.coins+pot:Math.max(0,data.coins);supabase.from('users').update({coins:nc}).eq('discord_id',p.discord_id);});
      });
      setTimeout(()=>{io.to(room.id).emit('loto:result',{drawn,scores,winner:room.players.indexOf(winnerPlayer),players:room.players.map(p=>({username:p.username,discord_id:p.discord_id})),pot});delete rooms[room.id];},2000);
    } else if (roomType === 'v21') {
      io.to(room.id).emit('v21:start', { total: 0, turn: 0, players: room.players.map(p => ({ username: p.username, discord_id: p.discord_id })) });
    } else if (roomType === 'mrace') {
      io.to(room.id).emit('mrace:start', { players: room.players.map(p => ({ username: p.username, discord_id: p.discord_id })) });
    } else if (roomType === 'guess') {
      io.to(room.id).emit('guess:start', {});
    } else if (roomType === 'bjm') {
      const suits=['s','h','d','c'],vals=['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
      room.dealer=[{v:vals[Math.floor(Math.random()*13)],s:suits[Math.floor(Math.random()*4)]},{v:vals[Math.floor(Math.random()*13)],s:suits[Math.floor(Math.random()*4)]}];
      room.players.forEach(p=>{
        if(!p.hand)p.hand=[{v:vals[Math.floor(Math.random()*13)],s:suits[Math.floor(Math.random()*4)]},{v:vals[Math.floor(Math.random()*13)],s:suits[Math.floor(Math.random()*4)]}];
        io.to(p.id).emit('bjm:deal',{hand:p.hand,dealer:room.dealer});
      });
    } else if (roomType === 'dtournoi') {
      const results=room.players.map(p=>{const d1=Math.ceil(Math.random()*6),d2=Math.ceil(Math.random()*6),d3=Math.ceil(Math.random()*6);return{discord_id:p.discord_id,username:p.username,dice:[d1,d2,d3],total:d1+d2+d3};});
      const maxScore=Math.max(...results.map(r=>r.total));
      const winner=results.find(r=>r.total===maxScore).discord_id;
      room.players.forEach(p=>{const won=p.discord_id===winner;supabase.from('users').select('coins').eq('discord_id',p.discord_id).single().then(({data})=>{if(!data)return;const nc=won?data.coins+room.bet*(room.players.length-1):Math.max(0,data.coins);supabase.from('users').update({coins:nc}).eq('discord_id',p.discord_id);});});
      setTimeout(()=>{io.to(room.id).emit('dtournoi:result',{results,winner,players:room.players.map(p=>({username:p.username,discord_id:p.discord_id}))});delete rooms[room.id];},1500);
    }
  });

  socket.on('leave:room', () => {
    if (socket.roomId && rooms[socket.roomId]) {
      io.to(socket.roomId).emit('player:left', {});
      delete rooms[socket.roomId];
      socket.leave(socket.roomId);
      socket.roomId = null;
    }
  });

  // CHAT
  socket.on('chat:send', ({ message, username, avatar, discord_id, level }) => {
    if (!message || message.length > 200) return;
    const msg = {
      id: Date.now(),
      username,
      avatar,
      discord_id,
      level: level || 1,
      message: message.slice(0, 200),
      time: new Date().toLocaleTimeString('fr', { hour: '2-digit', minute: '2-digit' })
    };
    chatHistory.push(msg);
    if (chatHistory.length > MAX_CHAT) chatHistory.shift();
    io.emit('chat:message', msg);
  });

  socket.on('disconnect', () => {
    if (socket.roomId && rooms[socket.roomId]) {
      io.to(socket.roomId).emit('player:left', {});
      delete rooms[socket.roomId];
    }
    if (socket.discordId) {
      onlineUsers.delete(socket.discordId);
      io.emit('online:update', { online: Array.from(onlineUsers) });
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log(`Casino démarré sur port ${PORT}`));
