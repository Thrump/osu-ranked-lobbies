import fs from 'fs';
import {Client, Intents, MessageActionRow, MessageButton, MessageEmbed} from 'discord.js';
import Config from './config.js';

async function main() {
  const client = new Client({intents: [Intents.FLAGS.GUILDS]});

  client.once('ready', async () => {
    console.log('ready');

    const map_pool_channel = client.channels.cache.get('1025359518340759613');

    const welcome_channel = client.channels.cache.get(Config.discord_welcome_channel_id);
    await welcome_channel.send({
      content: `**__Rules__**
- Be nice to others and stay family friendly
- That's it

To access text channels, link your account with the button below.`,
      components: [
        new MessageActionRow().addComponents([
          new MessageButton({
            custom_id: 'orl_link_osu_account',
            label: 'Link account',
            style: 'PRIMARY',
          }),
        ]),
      ],
    });

    const faq_channel = client.channels.cache.get(Config.discord_faq_channel_id);

    await faq_channel.send({
      embeds: [
        new MessageEmbed({
          title: 'Commands for ranked lobbies',
          fields: [
            {
              name: '!info or !discord',
              value: 'Display some information for new players.',
            },
            {
              name: '!start',
              value: `Count down 30 seconds then start the map. Useful when some players are AFK or forget to ready up. Anybody can use this command.`,
            },
            {
              name: '!wait',
              value: `Cancel !start. Use it when you're not done downloading.`,
            },
            {
              name: '!skip',
              value: 'Skip current map. You must have played 5 games in the lobby to unlock the command.',
            },
            {
              name: '!abort',
              value: 'Vote to abort the match. At least 1/4 of the lobby must vote to abort for a match to get aborted.',
            },
            {
              name: '!ban <player>',
              value: `Vote to ban a player. You should probably use the in-game ignoring and reporting features instead.`,
            },
            {
              name: '!rank <player>',
              value: `Display your rank or the rank of another player.`,
            },
          ],
        }),
      ],
    });

    await faq_channel.send({
      embeds: [
        new MessageEmbed({
          title: 'Commands for unranked lobbies',
          fields: [
            {
              name: '!collection <id>',
              value: 'Switches to another collection. Only the lobby creator can use this command.',
            },
            {
              name: '!start',
              value: `Count down 30 seconds then start the map. Useful when some players are AFK or forget to ready up. Anybody can use this command.`,
            },
            {
              name: '!wait',
              value: `Cancel !start. Use it when you're not done downloading.`,
            },
            {
              name: '!abort',
              value: 'Vote to abort the match. At least half the players in the lobby must vote to abort for a match to get aborted.',
            },
            {
              name: '!skip',
              value: 'Vote to skip the current map. At least half the players in the lobby must vote to skip for a map to get skipped.',
            },
          ],
        }),
      ],
    });

    await faq_channel.send({
      embeds: [
        new MessageEmbed({
          title: 'Frequently Asked Questions',
          fields: [
            {
              name: 'When do I get a rank?',
              value: `You get a rank after playing 5 games in a ranked lobby. To have it visible in this Discord server, you need to link your account in ${welcome_channel}.`,
            },
            {
              name: 'How do the ranks work?',
              value: 'When you pass a map with 95% accuracy, you gain rank. When you don\'t, you lose rank. How much you gain or lose depends on your rank, as well as how hard the map is.',
            },
            {
              name: 'Will mods make me rank up faster?',
              value: 'No. Using difficulty-reducing mods will invalidate your score; only HD, HR, MR, SD/PF, FI/FL are allowed.',
            },
            {
              name: 'How are the maps chosen?',
              value: `Maps are picked to best fit your current skill level.`,
            },
            {
              name: `What's the map pool?`,
              value: `Initially, the map pool consists of collections from ${map_pool_channel}. Over time, it expands to cover the entirety of osu! maps with a leaderboard (about 140k maps).`,
            },
            {
              name: 'Why is the star rating different from the title of the lobby?',
              value: 'Some maps are much easier/harder than their star rating represents. Also, the star rating shown by the client in multi lobbies is different from the current one (as shown on the osu! website).',
            },
            {
              name: 'What are the ranks?',
              value: `Here is the rank distribution:
- Cardboard: Bottom 8.6%
- Wood: Top 91.4%
- Bronze: Top 75.5%
- Silver: Top 56.8%
- Gold: Top 38.4%
- Platinum: Top 22.3%
- Diamond: Top 10.1%
- Rhythm Incarnate: Top 2.5%
- The One: #1`,
            },
            {
              name: `Why isn't the game starting when all players are ready?`,
              value: `That happens the last person that wasn't ready leaves. Anyone can unready and re-ready to start the game immediately. (I can't fix this bug, it comes from BanchoBot itself.)'`,
            },
            {
              name: `Can I see the source code?`,
              value: 'Yes: https://github.com/kiwec/osu-ranked-lobbies',
            },
          ],
        }),
      ],
    });

    console.log('sent');
  });

  const {discord_token} = JSON.parse(fs.readFileSync('./config.json'));
  await client.login(discord_token);
}

main();
