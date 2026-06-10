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

app.use(cors({ origin: process.env.BASE_URL, credentials: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 100 * 365 * 24 * 60 * 60 * 1000 }
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
    response_type: 'code', scope: 'identify'
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
  const { data: user } = await supabase.from('users').select('coins').eq('discord_id', req.session.user.discord_id).single();
  const newCoins = Math.max(0, user.coins + amount);
  await supabase.from('users').update({ coins: newCoins }).eq('discord_id', req.session.user.discord_id);
  res.json({ coins: newCoins });
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
  const { data } = await supabase.from('users').select('discord_id,username,coins,avatar').order('coins', { ascending: false }).limit(10);
  res.json(data);
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

io.on('connection', (socket) => {
  // DUEL DES
  socket.on('dice:join', ({ username, avatar, discord_id, bet }) => {
    let room = Object.values(rooms).find(r => r.type === 'dice' && r.players.length < 2 && !r.started);
    if (!room) { const id = 'dice_' + Date.now(); room = { id, type: 'dice', players: [], bet, started: false }; rooms[id] = room; }
    if (room.players.find(p => p.discord_id === discord_id)) return;
    room.players.push({ id: socket.id, username, avatar, discord_id, bet });
    socket.join(room.id); socket.roomId = room.id;
    io.to(room.id).emit('dice:update', { players: room.players.map(p => ({ username: p.username, avatar: p.avatar, discord_id: p.discord_id })), count: room.players.length });
    if (room.players.length >= 2) {
      room.started = true;
      setTimeout(() => {
        const r1 = Math.floor(Math.random()*6)+1 + Math.floor(Math.random()*6)+1;
        const r2 = Math.floor(Math.random()*6)+1 + Math.floor(Math.random()*6)+1;
        const winner = r1 > r2 ? 0 : r2 > r1 ? 1 : -1;
        io.to(room.id).emit('dice:result', { rolls: [r1, r2], winner, players: room.players.map(p => ({ username: p.username, discord_id: p.discord_id })) });
        if (winner !== -1) {
          const w = room.players[winner]; const l = room.players[1-winner];
          supabase.from('users').select('coins').eq('discord_id', w.discord_id).single().then(({data}) => { if(data) supabase.from('users').update({ coins: data.coins + room.bet }).eq('discord_id', w.discord_id); });
          supabase.from('users').select('coins').eq('discord_id', l.discord_id).single().then(({data}) => { if(data) supabase.from('users').update({ coins: Math.max(0, data.coins - room.bet) }).eq('discord_id', l.discord_id); });
        }
        delete rooms[room.id];
      }, 1500);
    }
  });

  // COURSE CHEVAUX
  socket.on('horse:join', ({ username, avatar, discord_id, horse, bet }) => {
    let room = Object.values(rooms).find(r => r.type === 'horse' && !r.started && r.players.length < 4);
    if (!room) { const id = 'horse_' + Date.now(); room = { id, type: 'horse', players: [], started: false, bet }; rooms[id] = room; }
    if (room.players.find(p => p.discord_id === discord_id)) return;
    room.players.push({ id: socket.id, username, avatar, discord_id, horse, bet });
    socket.join(room.id); socket.roomId = room.id;
    io.to(room.id).emit('horse:update', { players: room.players.map(p => ({ username: p.username, horse: p.horse, avatar: p.avatar, discord_id: p.discord_id })), count: room.players.length });
    if (room.players.length >= 2) {
      room.started = true;
      io.to(room.id).emit('horse:starting', { players: room.players.map(p => ({ username: p.username, horse: p.horse })) });
      setTimeout(() => {
        const winner = Math.floor(Math.random()*4);
        io.to(room.id).emit('horse:result', { winner, players: room.players.map(p => ({ username: p.username, horse: p.horse, discord_id: p.discord_id })) });
        room.players.forEach(p => {
          const won = p.horse === winner;
          supabase.from('users').select('coins').eq('discord_id', p.discord_id).single().then(({data}) => {
            if (!data) return;
            const nc = won ? data.coins + room.bet * (room.players.length - 1) : Math.max(0, data.coins - room.bet);
            supabase.from('users').update({ coins: nc }).eq('discord_id', p.discord_id);
          });
        });
        delete rooms[room.id];
      }, 5000);
    }
  });


  // POKER
  socket.on('poker:join', ({ username, avatar, discord_id, bet }) => {
    let room = Object.values(rooms).find(r => r.type === 'poker' && !r.started && r.players.length < 4);
    if (!room) { const id = 'poker_' + Date.now(); room = { id, type: 'poker', players: [], started: false, bet }; rooms[id] = room; }
    if (room.players.find(p => p.discord_id === discord_id)) return;
    const suits = ['s','h','d','c'], vals = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    const hand = [{ v: vals[Math.floor(Math.random()*13)], s: suits[Math.floor(Math.random()*4)] }, { v: vals[Math.floor(Math.random()*13)], s: suits[Math.floor(Math.random()*4)] }];
    room.players.push({ id: socket.id, username, avatar, discord_id, bet, hand });
    socket.join(room.id); socket.roomId = room.id;
    io.to(room.id).emit('poker:update', { players: room.players.map(p => ({ username: p.username, avatar: p.avatar, discord_id: p.discord_id })), count: room.players.length });
    if (room.players.length >= 2) {
      room.started = true;
      const pot = room.bet * room.players.length;
      room.players.forEach(p => {
        io.to(p.id).emit('poker:deal', { hand: p.hand, pot });
        supabase.from('users').select('coins').eq('discord_id', p.discord_id).single().then(({data}) => {
          if (data) supabase.from('users').update({ coins: Math.max(0, data.coins - room.bet) }).eq('discord_id', p.discord_id);
        });
      });
      setTimeout(() => {
        const rankHand = h => { const vals = ['2','3','4','5','6','7','8','9','10','J','Q','K','A']; return Math.max(...h.map(c => vals.indexOf(c.v))); };
        const scores = room.players.map(p => rankHand(p.hand));
        const winnerIdx = scores.indexOf(Math.max(...scores));
        const winner = room.players[winnerIdx];
        supabase.from('users').select('coins').eq('discord_id', winner.discord_id).single().then(({data}) => {
          if (data) supabase.from('users').update({ coins: data.coins + pot }).eq('discord_id', winner.discord_id);
        });
        io.to(room.id).emit('poker:result', { winner: winner.discord_id, hands: room.players.map(p => ({ discord_id: p.discord_id, hand: p.hand })), pot, players: room.players.map(p => ({ username: p.username, discord_id: p.discord_id })) });
        delete rooms[room.id];
      }, 3000);
    }
  });

  // BATAILLE
  socket.on('bataille:join', ({ username, avatar, discord_id, bet }) => {
    let room = Object.values(rooms).find(r => r.type === 'bataille' && r.players.length < 2 && !r.started);
    if (!room) { const id = 'bat_' + Date.now(); room = { id, type: 'bataille', players: [], started: false, bet }; rooms[id] = room; }
    if (room.players.find(p => p.discord_id === discord_id)) return;
    const suits = ['s','h','d','c'], vals = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    const card = { v: vals[Math.floor(Math.random()*13)], s: suits[Math.floor(Math.random()*4)] };
    room.players.push({ id: socket.id, username, avatar, discord_id, bet, card });
    socket.join(room.id); socket.roomId = room.id;
    io.to(room.id).emit('bataille:update', { players: room.players.map(p => ({ username: p.username, avatar: p.avatar, discord_id: p.discord_id })) });
    if (room.players.length >= 2) {
      room.started = true;
      const vals2 = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
      const scores = room.players.map(p => vals2.indexOf(p.card.v));
      const winnerIdx = scores[0] > scores[1] ? 0 : scores[1] > scores[0] ? 1 : Math.floor(Math.random()*2);
      const winner = room.players[winnerIdx];
      const loser = room.players[1 - winnerIdx];
      supabase.from('users').select('coins').eq('discord_id', winner.discord_id).single().then(({data}) => { if(data) supabase.from('users').update({ coins: data.coins + room.bet }).eq('discord_id', winner.discord_id); });
      supabase.from('users').select('coins').eq('discord_id', loser.discord_id).single().then(({data}) => { if(data) supabase.from('users').update({ coins: Math.max(0, data.coins - room.bet) }).eq('discord_id', loser.discord_id); });
      setTimeout(() => {
        io.to(room.id).emit('bataille:result', { cards: room.players.map(p => p.card), winner: winnerIdx, players: room.players.map(p => ({ username: p.username, discord_id: p.discord_id })) });
        delete rooms[room.id];
      }, 1500);
    }
  });

  // LOTO RAPIDE
  socket.on('loto:join', ({ username, avatar, discord_id, bet, numbers }) => {
    let room = Object.values(rooms).find(r => r.type === 'loto' && !r.started && r.players.length < 4);
    if (!room) { const id = 'loto_' + Date.now(); room = { id, type: 'loto', players: [], started: false, bet }; rooms[id] = room; }
    if (room.players.find(p => p.discord_id === discord_id)) return;
    room.players.push({ id: socket.id, username, avatar, discord_id, bet, numbers });
    socket.join(room.id); socket.roomId = room.id;
    io.to(room.id).emit('loto:update', { players: room.players.map(p => ({ username: p.username, avatar: p.avatar, discord_id: p.discord_id, numbers: p.numbers })), count: room.players.length });
    if (room.players.length >= 2) {
      room.started = true;
      // Draw 5 numbers
      const drawn = [];
      while (drawn.length < 5) { const n = Math.floor(Math.random()*30)+1; if (!drawn.includes(n)) drawn.push(n); }
      const scores = room.players.map(p => ({ discord_id: p.discord_id, score: p.numbers.filter(n => drawn.includes(n)).length }));
      const maxScore = Math.max(...scores.map(s => s.score));
      const winnerScore = scores.find(s => s.score === maxScore);
      const winnerPlayer = room.players.find(p => p.discord_id === winnerScore.discord_id);
      const pot = room.bet * room.players.length;
      room.players.forEach(p => {
        const won = p.discord_id === winnerPlayer.discord_id;
        supabase.from('users').select('coins').eq('discord_id', p.discord_id).single().then(({data}) => {
          if (!data) return;
          const nc = won ? data.coins + pot - room.bet : Math.max(0, data.coins - room.bet);
          supabase.from('users').update({ coins: nc }).eq('discord_id', p.discord_id);
        });
      });
      setTimeout(() => {
        io.to(room.id).emit('loto:result', { drawn, scores, winner: room.players.indexOf(winnerPlayer), players: room.players.map(p => ({ username: p.username, discord_id: p.discord_id })), pot });
        delete rooms[room.id];
      }, 2000);
    }
  });

  socket.on('disconnect', () => {
    if (socket.roomId && rooms[socket.roomId]) {
      io.to(socket.roomId).emit('player:left', {});
      delete rooms[socket.roomId];
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log(`Casino démarré sur port ${PORT}`));
