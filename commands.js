import {osu_fetch} from './api.js';
import bancho from './bancho.js';
import db from './database.js';
import {get_user_ranks} from './glicko.js';
import {load_collection, init_lobby as init_collection_lobby} from './collection.js';
import {init_lobby as init_ranked_lobby} from './ranked.js';
import Config from './util/config.js';


// TODO: !good / !bad map rating commands

async function reply(user, lobby, message) {
  if (lobby) {
    await lobby.send(`${user}: ${message}`);
  } else {
    await bancho.privmsg(user, message);
  }
}

async function join_command(msg, match) {
  try {
    const lobby = await bancho.join('#mp_' + match[1]);
    lobby.data.creator = msg.from;
    lobby.data.creator_id = await bancho.whois(msg.from);
    await lobby.send(`Hi! Type '!ranked <ruleset>' to start a ranked lobby, or '!collection <id>' to load a collection from osu!collector.`);
  } catch (err) {
    await bancho.privmsg(
        msg.from,
        `Failed to join the lobby. Make sure you have sent '!mp addref ${Config.osu_username}' in #multiplayer and that the lobby ID is correct.`,
    );
  }
}


async function collection_command(msg, match, lobby) {
  lobby.data.collection_id = match[1];
  if (lobby.data.type == 'new') {
    await init_collection_lobby(lobby);
  } else {
    try {
      await load_collection(lobby, match[1]);
    } catch (err) {
      await lobby.send(`Failed to load collection: ${err.message}`);
      throw err;
    }
  }
}

async function ranked_command(msg, match, lobby) {
  const ruleset_name = match[1];

  let ruleset_id;
  if (ruleset == 'osu') {
    ruleset_id = 0;
  } else if (ruleset == 'taiko') {
    ruleset_id = 1;
  } else if (ruleset == 'catch' || ruleset == 'fruits') {
    ruleset_id = 2;
  } else if (ruleset == 'mania' || ruleset == '4k') {
    ruleset_id = 3;
  } else {
    await reply(msg.from, lobby, `Invalid ruleset "${ruleset_name}". Please choose one of "osu", "taiko", "catch" or "mania".`);
    return;
  }

  lobby.created_just_now = true;
  lobby.data.ruleset = ruleset_id;
  await init_ranked_lobby(lobby);
}


async function rank_command(msg, match, lobby) {
  const requested_username = match[1].trim() || msg.from;
  const res = db.prepare(`SELECT user_id FROM user WHERE username = ?`).get(requested_username);
  let user_id = null;
  if (res) {
    user_id = res.user_id;
  } else {
    try {
      user_id = await bancho.whois(requested_username);
    } catch (err) {
      user_id = null;
    }
  }

  const ranks = get_user_ranks(user_id);
  if (!ranks) {
    await reply(msg.from, lobby, `${requested_username} hasn't played in a ranked lobby yet.`);
    return;
  }

  const ruleset = lobby ? lobby.data.ruleset : 0; // TODO fix later lol
  const rank_info = ranks[ruleset];
  const fancy_elo = rank_info.elo == '???' ? '???' : Math.round(rank_info.elo);
  await reply(msg.from, lobby, `[${Config.website_base_url}/u/${user_id}/ ${requested_username}] | Rank: ${rank_info.text} (#${rank_info.rank_nb}) | Elo: ${fancy_elo} | Games played: ${rank_info.nb_scores}`);
}

async function start_command(msg, match, lobby) {
  if (lobby.countdown != -1 || lobby.playing) return;

  if (lobby.nb_players < 2) {
    await lobby.send(`!mp start .${Math.random().toString(36).substring(2, 6)}`);
    return;
  }

  lobby.countdown = setTimeout(async () => {
    if (lobby.playing) {
      lobby.countdown = -1;
      return;
    }

    lobby.countdown = setTimeout(async () => {
      lobby.countdown = -1;
      if (!lobby.playing) {
        await lobby.send(`!mp start .${Math.random().toString(36).substring(2, 6)}`);
      }
    }, 10000);
    await lobby.send('Starting the match in 10 seconds... Ready up to start sooner.');
  }, 20000);
  await lobby.send('Starting the match in 30 seconds... Ready up to start sooner.');
}

async function wait_command(msg, match, lobby) {
  if (lobby.countdown == -1) return;

  clearTimeout(lobby.countdown);
  lobby.countdown = -1;
  await lobby.send('Match auto-start is cancelled. Type !start to restart it.');
}

async function about_command(msg, match, lobby) {
  if (lobby) {
    if (lobby.data.type == 'collection') {
      await lobby.send(`This lobby will auto-select maps of a specific collection from osu!collector. All commands and answers to your questions are [${Config.discord_invite_link} in the Discord.]`);
    } else if (lobby.data.type == 'ranked') {
      await lobby.send(`In this lobby, you get a rank based on how often you pass maps with 95% accuracy. All commands and answers to your questions are [${Config.discord_invite_link} in the Discord.]`);
    } else {
      await lobby.send(`Bruh just send !collection <id> or !ranked <ruleset>`);
    }
  } else {
    await bancho.privmsg(msg.from, `This bot can join lobbies and do many things. Commands and answers to your questions are available [${Config.discord_invite_link} in the Discord.]`);
  }
}

async function discord_command(msg, match, lobby) {
  await reply(msg.from, lobby, `[${Config.discord_invite_link} Come hang out in voice chat!] (or just text, no pressure)`);
}

async function abort_command(msg, match, lobby) {
  if (!lobby.playing) {
    await lobby.send(`${msg.from}: The match has not started, cannot abort.`);
    return;
  }

  if (!lobby.voteaborts.includes(msg.from)) {
    lobby.voteaborts.push(msg.from);
    const nb_voted_to_abort = lobby.voteaborts.length;
    const nb_required_to_abort = Math.ceil(lobby.nb_players / 4);
    if (lobby.voteaborts.length >= nb_required_to_abort) {
      await lobby.send(`!mp abort ${Math.random().toString(36).substring(2, 6)}`);
      lobby.voteaborts = [];
      await lobby.select_next_map();
    } else {
      await lobby.send(`${msg.from} voted to abort the match. ${nb_voted_to_abort}/${nb_required_to_abort} votes needed.`);
    }
  }
}

async function ban_command(msg, match, lobby) {
  const bad_player = match[1].trim();
  if (bad_player == '') {
    await lobby.send(msg.from + ': You need to specify which player to ban.');
    return;
  }

  if (!lobby.votekicks[bad_player]) {
    lobby.votekicks[bad_player] = [];
  }
  if (!lobby.votekicks[bad_player].includes(msg.from)) {
    lobby.votekicks[bad_player].push(msg.from);

    const nb_voted_to_kick = lobby.votekicks[bad_player].length;
    let nb_required_to_kick = Math.ceil(lobby.nb_players / 2);
    if (nb_required_to_kick == 1) nb_required_to_kick = 2; // don't allow a player to hog the lobby

    if (nb_voted_to_kick >= nb_required_to_kick) {
      await lobby.send('!mp ban ' + bad_player);
    } else {
      await lobby.send(`${msg.from} voted to ban ${bad_player}. ${nb_voted_to_kick}/${nb_required_to_kick} votes needed.`);
    }
  }
}

async function skip_command(msg, match, lobby) {
  // Skip map if DMCA'd
  // When bot just joined the lobby, beatmap_id is null.
  if (lobby.beatmap_id && !lobby.map_data) {
    try {
      console.info(`[API] Fetching map data for map ID ${lobby.beatmap_id}`);
      lobby.map_data = await osu_fetch(`https://osu.ppy.sh/api/v2/beatmaps/lookup?id=${lobby.beatmap_id}`);

      if (lobby.map_data.beatmapset.availability.download_disabled) {
        clearTimeout(lobby.countdown);
        lobby.countdown = -1;

        db.prepare(`UPDATE map SET dmca = 1 WHERE map_id = ?`).run(lobby.beatmap_id);
        await lobby.select_next_map();
        await lobby.send(`Skipped previous map because download was unavailable [${lobby.map_data.beatmapset.availability.more_information} (more info)].`);
        return;
      }
    } catch (err) {
      console.error(`Failed to fetch map data for beatmap #${lobby.beatmap_id}: ${err}`);
    }
  }

  // Skip map if player has been in the lobby long enough
  for (const player of lobby.players) {
    if (player.irc_username == msg.from) {
      // Make sure the field is initialized
      if (!player.matches_finished) {
        player.matches_finished = 0;
      }

      if (player.matches_finished >= 5) {
        player.matches_finished = 0;
        await lobby.select_next_map();
      } else {
        await reply(msg.from, lobby, `You need to play ${5 - player.matches_finished} more matches in this lobby before you can skip.`);
      }

      return;
    }
  }

  await reply(msg.from, lobby, `You need to play 5 more matches in this lobby before you can skip.`);
}

const commands = [
  {
    regex: /!join (\d+)/gi,
    handler: join_command,
    creator_only: false,
    modes: ['pm'],
  },
  {
    regex: /!collection (\d+)/gi,
    handler: collection_command,
    creator_only: true,
    modes: ['new', 'collection'],
  },
  {
    regex: /!ranked (.+)/gi,
    handler: ranked_command,
    creator_only: true,
    modes: ['new'],
  },
  {
    regex: /^!about$/gi,
    handler: about_command,
    creator_only: false,
    modes: ['pm', 'new', 'collection', 'ranked'],
  },
  {
    regex: /^!info/gi,
    handler: about_command,
    creator_only: false,
    modes: ['pm', 'new', 'collection', 'ranked'],
  },
  {
    regex: /^!help$/gi,
    handler: about_command,
    creator_only: false,
    modes: ['pm', 'new', 'collection', 'ranked'],
  },
  {
    regex: /^!discord$/gi,
    handler: discord_command,
    creator_only: false,
    modes: ['pm', 'new', 'collection', 'ranked'],
  },
  {
    regex: /^!rank(.*)/gi,
    handler: rank_command,
    creator_only: false,
    modes: ['pm', 'new', 'collection', 'ranked'],
  },
  {
    regex: /^!abort$/gi,
    handler: abort_command,
    creator_only: false,
    modes: ['collection', 'ranked'],
  },
  {
    regex: /^!start$/gi,
    handler: start_command,
    creator_only: false,
    modes: ['collection', 'ranked'],
  },
  {
    regex: /^!wait$/gi,
    handler: wait_command,
    creator_only: false,
    modes: ['collection', 'ranked'],
  },
  {
    regex: /^!stop$/gi,
    handler: wait_command,
    creator_only: false,
    modes: ['collection', 'ranked'],
  },
  {
    regex: /^!ban(.*)/gi,
    handler: ban_command,
    creator_only: false,
    modes: ['ranked'],
  },
  {
    regex: /^!kick(.*)/gi,
    handler: ban_command,
    creator_only: false,
    modes: ['ranked'],
  },
  {
    regex: /^!skip$/gi,
    handler: skip_command,
    creator_only: false,
    modes: ['collection', 'ranked'],
  },
];

export default commands;
