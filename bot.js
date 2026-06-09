require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const express = require('express');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const app = express();
app.use(express.json());

client.once('ready', () => {
  console.log(`✅ Bot connecté en tant que ${client.user.tag}`);
});

// Mini serveur interne pour recevoir les notifications du backend
app.post('/notify', async (req, res) => {
  const { username, reward_name, price } = req.body;
  try {
    const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID);
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('🎰 Récompense achetée !')
      .setDescription(`**${username}** vient d'acheter **${reward_name}**`)
      .addFields({ name: '💰 Prix payé', value: `${price} pièces`, inline: true })
      .setTimestamp();
    await channel.send({ embeds: [embed] });
    res.json({ ok: true });
  } catch (err) {
    console.error('Erreur bot:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(3001, () => console.log('✅ Bot listener sur port 3001'));
client.login(process.env.DISCORD_BOT_TOKEN);
