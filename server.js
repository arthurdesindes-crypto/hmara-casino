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

app.use(cors({ origin: process.env.BASE_URL, credentials: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 100 * 365 * 24 * 60 * 60 * 1000 } // ~100 ans = permanent
}));

// ─── AUTH DISCORD ─────────────────────────────────────────────────────────────
app.get('/auth/login', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: `${process.env.BASE_URL}/auth/callback`,
    response_type: 'code',
    scope: 'identify'
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=no_code');
  try {
    const tokenRes = await axios.post('https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${process.env.BASE_URL}/auth/callback`
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }
    });
    const discordUser = userRes.data;
    const { data: existing } = await supabase.from('users').select('*').eq('discord_id', discordUser.id).single();
    if (!existing) {
      await supabase.from('users').insert({ discord_id: discordUser.id, username: discordUser.username, avatar: discordUser.avatar });
    } else {
      await supabase.from('users').update({ username: discordUser.username, avatar: discordUser.avatar }).eq('discord_id', discordUser.id);
    }
    req.session.user = { discord_id: discordUser.id, username: discordUser.username, avatar: discordUser.avatar };
    req.session.save(() => res.redirect('/casino'));
  } catch (err) {
    console.error('Auth error:', err.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Non connecté' });
  next();
}

// ─── API ──────────────────────────────────────────────────────────────────────
app.get('/api/me', requireAuth, async (req, res) => {
  const { data } = await supabase.from('users').select('*').eq('discord_id', req.session.user.discord_id).single();
  res.json(data);
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
  try { await axios.post(`http://localhost:3001/notify`, { username: req.session.user.username, reward_name, price }); } catch (e) {}
  res.json({ coins: newCoins, success: true });
});

app.get('/api/leaderboard', async (req, res) => {
  const { data } = await supabase.from('users').select('discord_id, username, coins, avatar').order('coins', { ascending: false }).limit(10);
  res.json(data);
});

// ─── PAGES ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/casino');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/casino', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'casino.html')));

// ─── SOCKET.IO MULTIJOUEUR ────────────────────────────────────────────────────
const rooms = {};

io.on('connection', (socket) => {
  // DUEL DE DÉS
  socket.on('dice:join', ({ username, avatar, discord_id, bet }) => {
    let room = Object.values(rooms).find(r => r.type === 'dice' && r.players.length < 2);
    if (!room) {
      const id = 'dice_' + Date.now();
      room = { id, type: 'dice', players: [], bet };
      rooms[id] = room;
    }
    room.players.push({ id: socket.id, username, avatar, discord_id, bet });
    socket.join(room.id);
    socket.roomId = room.id;
    io.to(room.id).emit('dice:update', { players: room.players.map(p => ({ username: p.username, avatar: p.avatar })), bet: room.bet });
    if (room.players.length === 2) {
      const d1 = Math.floor(Math.random()*6)+1 + Math.floor(Math.random()*6)+1;
      const d2 = Math.floor(Math.random()*6)+1 + Math.floor(Math.random()*6)+1;
      const winner = d1 > d2 ? 0 : d2 > d1 ? 1 : -1;
      io.to(room.id).emit('dice:result', { rolls: [d1, d2], winner, players: room.players.map(p => p.username) });
      // Transférer les coins
      if (winner !== -1) {
        const w = room.players[winner];
        const l = room.players[1 - winner];
        supabase.from('users').select('coins').eq('discord_id', w.discord_id).single().then(({data}) => {
          supabase.from('users').update({ coins: data.coins + room.bet }).eq('discord_id', w.discord_id);
        });
        supabase.from('users').select('coins').eq('discord_id', l.discord_id).single().then(({data}) => {
          supabase.from('users').update({ coins: Math.max(0, data.coins - room.bet) }).eq('discord_id', l.discord_id);
        });
      }
      delete rooms[room.id];
    }
  });

  // COURSE DE CHEVAUX
  socket.on('horse:join', ({ username, avatar, discord_id, horse, bet }) => {
    let room = Object.values(rooms).find(r => r.type === 'horse' && !r.started && r.players.length < 4);
    if (!room) {
      const id = 'horse_' + Date.now();
      room = { id, type: 'horse', players: [], started: false, bet };
      rooms[id] = room;
    }
    if (room.players.find(p => p.id === socket.id)) return;
    room.players.push({ id: socket.id, username, avatar, discord_id, horse, bet });
    socket.join(room.id);
    socket.roomId = room.id;
    io.to(room.id).emit('horse:update', { players: room.players.map(p => ({ username: p.username, horse: p.horse, avatar: p.avatar })), count: room.players.length });
    if (room.players.length >= 2) {
      room.started = true;
      setTimeout(() => {
        const horses = [0,1,2,3];
        const winner = horses[Math.floor(Math.random()*4)];
        io.to(room.id).emit('horse:result', { winner, players: room.players.map(p => ({ username: p.username, horse: p.horse, discord_id: p.discord_id })) });
        room.players.forEach(p => {
          const won = p.horse === winner;
          supabase.from('users').select('coins').eq('discord_id', p.discord_id).single().then(({data}) => {
            if (!data) return;
            const newCoins = won ? data.coins + room.bet * (room.players.length - 1) : Math.max(0, data.coins - room.bet);
            supabase.from('users').update({ coins: newCoins }).eq('discord_id', p.discord_id);
          });
        });
        delete rooms[room.id];
      }, 5000);
    }
  });

  socket.on('disconnect', () => {
    if (socket.roomId && rooms[socket.roomId]) {
      io.to(socket.roomId).emit('player:left');
      delete rooms[socket.roomId];
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log(`✅ Serveur démarré sur port ${PORT}`));
