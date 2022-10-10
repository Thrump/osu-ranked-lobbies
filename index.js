import Sentry from '@sentry/node';

import bancho from './bancho.js';
import commands from './commands.js';
import db from './database.js';
import {init as init_discord_interactions} from './discord_interactions.js';
import {init as init_discord_updates} from './discord_updates.js';
import {listen as website_listen} from './website.js';
import {init_lobby as init_ranked_lobby} from './ranked.js';
import {init_lobby as init_collection_lobby} from './collection.js';
import Config from './util/config.js';
import {capture_sentry_exception} from './util/helpers.js';


async function rejoin_lobbies() {
  const rejoin_lobby = async (match) => {
    console.info(`Rejoining lobby #${match.match_id}`);

    try {
      const bancho_lobby = await bancho.join('#mp_' + match.match_id);
      if (bancho_lobby.data.type == 'ranked') {
        await init_ranked_lobby(bancho_lobby);
      } else if (bancho_lobby.data.type == 'collection') {
        await init_collection_lobby(bancho_lobby);
      }
    } catch (err) {
      console.error(`Failed to rejoin lobby #${match.match_id}: ${err}`);
      db.prepare(`UPDATE match SET end_time = ? WHERE match_id = ?`).run(Date.now(), match.match_id);
    }
  };

  const lobbies = db.prepare(`SELECT * FROM match WHERE end_time IS NULL`).all();
  const promises = [];
  for (const lobby of lobbies) {
    promises.push(rejoin_lobby(lobby));
  }
  await Promise.all(promises);
}


async function main() {
  console.log('Starting...');

  if (Config.ENABLE_SENTRY) {
    Sentry.init({
      dsn: Config.sentry_dsn,
    });
  }

  if (Config.CREATE_LOBBIES) {
    // Check for lobby creation every minute
    setInterval(() => create_lobby_if_needed(), 60 * 1000);
  }

  bancho.on('pm', (msg) => {
    for (const cmd of commands) {
      const match = cmd.regex.exec(msg.message);
      if (match) {
        if (!cmd.modes.includes('pm')) {
          bancho.privmsg(msg.from, 'You should send that command in #multiplayer.');
          return;
        }

        cmd.handler(msg, match, null).catch(capture_sentry_exception);
        return;
      }
    }
  });

  let discord_client = null;
  if (Config.CONNECT_TO_DISCORD) {
    try {
      discord_client = await init_discord_interactions();
      await init_discord_updates(discord_client);
    } catch (err) {
      console.error('Failed to login to Discord:', err.message);
      process.exit();
    }
  }

  if (Config.HOST_WEBSITE) {
    website_listen();
  }

  if (Config.CONNECT_TO_BANCHO) {
    bancho.on('disconnect', () => process.exit());
    await bancho.connect();
    await rejoin_lobbies();
  }

  if (Config.CREATE_LOBBIES) {
    create_lobby_if_needed();
  }

  console.log('All ready and fired up!');
}


// Automatically create lobbies when they're not.
//
// Since newly created lobbies are added to the bottom of the lobby list, it's
// fine to create them optimistically, since players won't see them without
// searching.
async function create_lobby_if_needed() {
  let i = 0;
  const lobbies_to_create = [
    {ruleset: 0, slug: 'std', title: 'o!RL standard (!info)'},
    {ruleset: 1, slug: 'taiko', title: 'o!RL taiko (!info)'},
    {ruleset: 2, slug: 'catch', title: 'o!RL catch (!info)'},
    {ruleset: 3, slug: 'mania', title: 'o!RL mania 4k (!info)'},
  ];
  for (const to_create of lobbies_to_create) {
    const already_created = bancho._lobbies.some((lobby) => lobby.data.slug == to_create.slug);
    if (already_created) continue;

    try {
      console.log('Creating new lobby...');
      const lobby = await bancho.make(`New o!RL lobby ${i++}`);
      lobby.created_just_now = true;
      lobby.data.creator = Config.osu_username;
      lobby.data.creator_id = Config.osu_id;
      lobby.data.ruleset = to_create.ruleset;
      lobby.data.slug = to_create.slug;
      await init_ranked_lobby(lobby);
    } catch (err) {
      // Don't care about errors here.
      console.error(err);
    }
  }
}

main();
