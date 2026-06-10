require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const express = require('express');

const client = new Client({ 
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildBans
  ] 
});

const app = express();
app.use(express.json());

const GUILD_ID = process.env.DISCORD_GUILD_ID;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const ROLE_KICKEUR = '1463996840012677221';
const ROLE_PASS = '1462478078747086969';

client.once('ready', () => {
  console.log(`Bot connecte : ${client.user.tag}`);
});

// Récupérer tous les membres du serveur
app.get('/members', async (req, res) => {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.members.fetch();
    const members = guild.members.cache
      .filter(m => !m.user.bot)
      .map(m => ({
        id: m.user.id,
        username: m.user.username,
        displayName: m.displayName,
        avatar: m.user.avatar,
        hasPass: m.roles.cache.has(ROLE_PASS),
        roles: m.roles.cache.map(r => r.id)
      }));
    res.json(members);
  } catch (err) {
    console.error('members error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// BAN temporaire
app.post('/ban', async (req, res) => {
  const { targetId, duration, buyerUsername, reason } = req.body;
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(targetId).catch(() => null);
    
    if (!member) return res.status(404).json({ error: 'Membre introuvable' });
    if (member.roles.cache.has(ROLE_PASS)) return res.status(403).json({ error: 'Cette personne a le Pass Anti-Sanction !' });
    if (member.roles.cache.has('1463996840012677221') || member.permissions.has('Administrator')) {
      return res.status(403).json({ error: 'Impossible de bannir un admin ou un kickeur' });
    }

    // Ban
    await guild.members.ban(targetId, { reason: `Casino ban par ${buyerUsername} — ${duration} min`, deleteMessageSeconds: 0 });

    // Annonce
    try {
      const channel = await client.channels.fetch(CHANNEL_ID);
      const embed = new EmbedBuilder()
        .setColor(0xE53935)
        .setTitle('🔨 Ban Casino')
        .setDescription(`**${member.user.username}** a été banni par **${buyerUsername}**`)
        .addFields(
          { name: 'Durée', value: `${duration} minute(s)`, inline: true },
          { name: 'Raison', value: reason || 'Achat boutique casino', inline: true }
        )
        .setTimestamp();
      await channel.send({ embeds: [embed] });
    } catch(e) {}

    // Unban automatique
    setTimeout(async () => {
      try {
        await guild.bans.remove(targetId, 'Fin du ban casino');
        try {
          const channel = await client.channels.fetch(CHANNEL_ID);
          const embed = new EmbedBuilder()
            .setColor(0x1DB954)
            .setTitle('✅ Unban Casino')
            .setDescription(`**${member.user.username}** a été débanni automatiquement`)
            .setTimestamp();
          await channel.send({ embeds: [embed] });
        } catch(e) {}
      } catch (e) { console.error('unban error:', e.message); }
    }, duration * 60 * 1000);

    res.json({ success: true, username: member.user.username });
  } catch (err) {
    console.error('ban error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Donner un rôle
app.post('/give-role', async (req, res) => {
  const { targetId, roleId, duration, buyerUsername } = req.body;
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(targetId).catch(() => null);
    if (!member) return res.status(404).json({ error: 'Membre introuvable' });

    await member.roles.add(roleId);

    const roleName = roleId === ROLE_KICKEUR ? 'Kickeur' : 'Pass Anti-Sanction';
    try {
      const channel = await client.channels.fetch(CHANNEL_ID);
      const embed = new EmbedBuilder()
        .setColor(0xC99720)
        .setTitle('👑 Rôle Casino')
        .setDescription(`**${member.user.username}** a reçu le rôle **@${roleName}**`)
        .addFields({ name: 'Offert par', value: buyerUsername, inline: true }, duration ? { name: 'Durée', value: `${duration} jours`, inline: true } : { name: 'Durée', value: 'Permanent', inline: true })
        .setTimestamp();
      await channel.send({ embeds: [embed] });
    } catch(e) {}

    // Retrait automatique si durée définie
    if (duration) {
      setTimeout(async () => {
        try {
          const m = await guild.members.fetch(targetId).catch(() => null);
          if (m) {
            await m.roles.remove(roleId);
            try {
              const channel = await client.channels.fetch(CHANNEL_ID);
              const embed = new EmbedBuilder()
                .setColor(0x7070A0)
                .setTitle('⏰ Rôle expiré')
                .setDescription(`Le rôle **@${roleName}** de **${m.user.username}** a expiré`)
                .setTimestamp();
              await channel.send({ embeds: [embed] });
            } catch(e) {}
          }
        } catch(e) { console.error('role remove error:', e.message); }
      }, duration * 24 * 60 * 60 * 1000);
    }

    res.json({ success: true, username: member.user.username });
  } catch (err) {
    console.error('give-role error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Retirer le pass anti-sanction
app.post('/remove-pass', async (req, res) => {
  const { targetId, buyerUsername } = req.body;
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(targetId).catch(() => null);
    if (!member) return res.status(404).json({ error: 'Membre introuvable' });
    if (!member.roles.cache.has(ROLE_PASS)) return res.status(400).json({ error: 'Ce membre n\'a pas le pass anti-sanction' });

    await member.roles.remove(ROLE_PASS);

    try {
      const channel = await client.channels.fetch(CHANNEL_ID);
      const embed = new EmbedBuilder()
        .setColor(0xFF6B6B)
        .setTitle('❌ Pass Anti-Sanction retiré')
        .setDescription(`Le pass de **${member.user.username}** a été retiré par **${buyerUsername}**`)
        .setTimestamp();
      await channel.send({ embeds: [embed] });
    } catch(e) {}

    res.json({ success: true, username: member.user.username });
  } catch (err) {
    console.error('remove-pass error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Notification générale
app.post('/notify', async (req, res) => {
  const { username, reward_name, price } = req.body;
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    const embed = new EmbedBuilder()
      .setColor(0xC99720)
      .setTitle('🏪 Achat Boutique')
      .setDescription(`**${username}** vient d'acheter **${reward_name}**`)
      .addFields({ name: 'Prix', value: `${price} pièces`, inline: true })
      .setTimestamp();
    await channel.send({ embeds: [embed] });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(3001, () => console.log('Bot listener sur port 3001'));
client.login(process.env.DISCORD_BOT_TOKEN);
