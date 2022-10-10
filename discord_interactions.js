import crypto from 'crypto';
import fs from 'fs';
import {Client, Intents, MessageActionRow, MessageButton} from 'discord.js';

import db from './database.js';
import {capture_sentry_exception} from './util/helpers.js';
import Config from './util/config.js';

const client = new Client({intents: [Intents.FLAGS.GUILDS]});


function init() {
  return new Promise(async (resolve, reject) => {
    try {
      client.once('ready', async () => {
        client.on('interactionCreate', (interaction) => on_interaction(interaction).catch(capture_sentry_exception));
        console.log('Discord bot is ready.');
        resolve(client);
      });

      const {discord_token} = JSON.parse(fs.readFileSync('./config.json'));
      await client.login(discord_token);
    } catch (e) {
      reject(e);
    }
  });
}

async function on_interaction(interaction) {
  if (interaction.isCommand()) {
    if (interaction.commandName == 'profile') {
      let target = interaction.options.getUser('user');
      if (!target) {
        target = interaction.member;
      }

      const res = db.prepare(`SELECT * FROM user WHERE discord_user_id = ?`).get(target.id);
      if (res) {
        await interaction.reply(`${Config.website_base_url}/u/${res.user_id}`);
      } else {
        await interaction.reply({
          content: 'That user hasn\'t linked their osu! account yet.',
          ephemeral: true,
        });
      }

      return;
    }

    if (interaction.commandName == 'eval') {
      if (interaction.member.id != Config.discord_admin) {
        await interaction.reply({
          content: 'Only the bot owner can use this command.',
          ephemeral: true,
        });
        return;
      }

      try {
        const eval_res = eval(interaction.options.getString('code'));
        await interaction.reply({
          content: `\`\`\`js\n${eval_res}\n\`\`\``,
        });
      } catch (err) {
        await interaction.reply({
          content: `\`ERROR\` \`\`\`xl\n${err}\n\`\`\``,
        });
      }

      return;
    }
  }

  try {
    if (interaction.customId == 'orl_link_osu_account') {
      await on_link_osu_account_press(interaction);
      return;
    }
  } catch (err) {
    // Discord API likes to fail.
    if (err.message != 'Unknown interaction') {
      capture_sentry_exception(err);
    }
  }
}

async function on_link_osu_account_press(interaction) {
  // Check if user already linked their account
  const user = db.prepare(`SELECT * FROM user WHERE discord_user_id = ?`).get(interaction.user.id);
  if (user) {
    await interaction.member.roles.add(Config.discord_linked_account_role_id);
    await interaction.reply({
      content: 'You already linked your account 👉 https://osu.ppy.sh/users/' + user.osu_id,
      ephemeral: true,
    });
    return;
  }

  // Create ephemeral token
  const ephemeral_token = crypto.randomBytes(16).toString('hex');
  db.prepare(
      `INSERT INTO token (token, created_at, discord_id) VALUES (?, ?, ?)`,
  ).run(ephemeral_token, Date.now(), interaction.user.id);

  // Send authorization link
  await interaction.reply({
    content: `Hello ${interaction.user}, let's get your account linked!`,
    ephemeral: true,
    components: [
      new MessageActionRow().addComponents([
        new MessageButton({
          url: `https://osu.ppy.sh/oauth/authorize?client_id=${Config.osu_v2api_client_id}&response_type=code&scope=identify&state=${ephemeral_token}&redirect_uri=${Config.website_base_url}/auth`,
          label: 'Verify using osu!web',
          style: 'LINK',
        }),
      ]),
    ],
  });
}

export {
  init,
};
