require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

app.use(cors({ origin: process.env.BASE_URL, credentials: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// ─── AUTH DISCORD ───────────────────────────────────────────────────────────

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

    // Créer ou récupérer l'utilisateur dans Supabase
    const { data: existing } = await supabase
      .from('users')
      .select('*')
      .eq('discord_id', discordUser.id)
      .single();

    if (!existing) {
      await supabase.from('users').insert({
        discord_id: discordUser.id,
        username: discordUser.username,
        avatar: discordUser.avatar
      });
    } else {
      await supabase.from('users').update({
        username: discordUser.username,
        avatar: discordUser.avatar
      }).eq('discord_id', discordUser.id);
    }

    req.session.user = {
      discord_id: discordUser.id,
      username: discordUser.username,
      avatar: discordUser.avatar
    };

    res.redirect('/casino');
  } catch (err) {
    console.error('Auth error:', err.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// ─── API ─────────────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Non connecté' });
  next();
}

// Récupérer le profil + coins
app.get('/api/me', requireAuth, async (req, res) => {
  const { data } = await supabase
    .from('users')
    .select('*')
    .eq('discord_id', req.session.user.discord_id)
    .single();
  res.json(data);
});

// Mettre à jour les coins après un jeu
app.post('/api/coins', requireAuth, async (req, res) => {
  const { amount } = req.body; // positif = gagné, négatif = perdu
  const { data: user } = await supabase
    .from('users')
    .select('coins')
    .eq('discord_id', req.session.user.discord_id)
    .single();

  const newCoins = Math.max(0, user.coins + amount);
  await supabase.from('users').update({ coins: newCoins })
    .eq('discord_id', req.session.user.discord_id);

  res.json({ coins: newCoins });
});

// Acheter une récompense
app.post('/api/buy', requireAuth, async (req, res) => {
  const { reward_name, price } = req.body;
  const { data: user } = await supabase
    .from('users')
    .select('coins')
    .eq('discord_id', req.session.user.discord_id)
    .single();

  if (user.coins < price) return res.status(400).json({ error: 'Pas assez de pièces' });

  const newCoins = user.coins - price;
  await supabase.from('users').update({ coins: newCoins })
    .eq('discord_id', req.session.user.discord_id);

  await supabase.from('purchases').insert({
    discord_id: req.session.user.discord_id,
    reward_name,
    price
  });

  // Notifier le bot Discord
  try {
    await axios.post(`http://localhost:3001/notify`, {
      username: req.session.user.username,
      reward_name,
      price
    });
  } catch (e) {
    // Le bot est optionnel, pas bloquant
  }

  res.json({ coins: newCoins, success: true });
});

// Classement
app.get('/api/leaderboard', async (req, res) => {
  const { data } = await supabase
    .from('users')
    .select('username, coins, avatar')
    .order('coins', { ascending: false })
    .limit(10);
  res.json(data);
});

// ─── PAGES ───────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/casino', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'casino.html')));

// ─── START ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Serveur démarré sur http://localhost:${PORT}`));
