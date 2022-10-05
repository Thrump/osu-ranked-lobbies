import bancho from './bancho.js';
import databases from './database.js';
import {update_mmr} from './glicko.js';
import Config from './util/config.js';


async function get_full_players(match, game) {
  const full_players = [];
  const missing_player_ids = [];

  for (const score of game.scores) {
    const full_player = db.prepare(`SELECT * FROM full_user WHERE user_id = ?`).run(score.user_id);
    if (full_player) {
      // TODO check if username changed and call update_discord_username() if it did
      full_players.push(full_player);
    } else {
      missing_player_ids.push(score.user_id);
    }
  }
  if (missing_player_ids.length == 0) {
    return full_players;
  }

  // New players, pog! Get their info.
  let new_users = null;
  try {
    let args = `ids[0]=${missing_player_ids[0]}`;
    for (let i = 1; i < missing_player_ids.length; i++) {
      args += `&ids[${i}]=${missing_player_ids[i]}`;
    }

    new_users = await osu_fetch(`https://osu.ppy.sh/api/v2/users?${args}`);
  } catch (err) {
    console.error('Failed to fetch profiles for IDs: ' + missing_player_ids.toString());
    capture_sentry_exception(err);
    return full_players;
  }

  // Approximates elo from total_pp to suggest appropriate maps
  const total_pp_to_mu = (total_pp) => {
    let elo = total_pp * 0.15;

    // Make sure we don't under- or over- rank someone based on their profile
    if (elo < 500) elo = 500;
    if (elo > 2500) elo = 2500;

    return (elo - 1500) / 173.7178;
  };
  for (const user of new_users) {
    // TODO: migrate older profile (discord_user_id, discord_role)

    db.prepare(`
      INSERT INTO full_user (user_id, username, country_code, profile_data, osu_mu, catch_mu, mania_mu, taiko_mu)
      VALUES                (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(user.id, user.username, user.country_code, user,
        total_pp_to_mu(user.statistics_rulesets.osu.pp),
        total_pp_to_mu(user.statistics_rulesets.fruits.pp),
        total_pp_to_mu(user.statistics_rulesets.mania.pp),
        total_pp_to_mu(user.statistics_rulesets.taiko.pp),
    );
  }
}


async function set_new_title(lobby) {
  let new_title = '';

  if (lobby.data.avg_sr) {
    // TODO display lobby's avg sr instead of map sr
    new_title = `${Math.round(lobby.map.stars, 0.1)}* x o!RL x Auto map select (!info)`;
  } else {
    new_title = `o!RL x Auto map select (!info)`;
  }

  if (!Config.IS_PRODUCTION) {
    new_title = 'test lobby';
  }

  if (lobby.name != new_title) {
    await lobby.send(`!mp name ${new_title}`);
    lobby.name = new_title;
  }
}

async function update_median_pp(lobby) {
  // TODO
}

function median(numbers) {
  if (numbers.length == 0) return 0;

  const middle = Math.floor(numbers.length / 2);
  if (numbers.length % 2 === 0) {
    return (numbers[middle - 1] + numbers[middle]) / 2;
  }
  return numbers[middle];
}

async function select_next_map() {
  this.voteskips = [];
  clearTimeout(this.countdown);
  this.countdown = -1;

  if (this.recent_maps.length >= 25) {
    this.recent_maps.shift();
  }

  const new_map = null;
  // TODO select new_map
  this.recent_maps.push(new_map.id);
  const pp = new_map.overall_pp;

  try {
    const sr = new_map.stars;
    // TODO display map elo too?
    const flavor = `${sr.toFixed(2)}*, ${Math.round(pp)}pp`;
    const map_name = `[https://osu.ppy.sh/beatmaps/${new_map.id} ${new_map.name}]`;
    const beatconnect_link = `[https://beatconnect.io/b/${new_map.set_id} [1]]`;
    const chimu_link = `[https://chimu.moe/d/${new_map.set_id} [2]]`;
    const nerina_link = `[https://api.nerinyan.moe/d/${new_map.set_id} [3]]`;
    const sayobot_link = `[https://osu.sayobot.cn/osu.php?s=${new_map.set_id} [4]]`;
    await this.send(`!mp map ${new_map.id} * | ${map_name} (${flavor}) Alternate downloads: ${beatconnect_link} ${chimu_link} ${nerina_link} ${sayobot_link}`);
    this.map = new_map;
    await set_new_title(this);
  } catch (e) {
    console.error(`${this.channel} Failed to switch to map ${new_map.id} ${new_map.name}:`, e);
  }
}


async function init_lobby(lobby) {
  lobby.match_participants = [];
  lobby.recent_maps = [];
  lobby.votekicks = [];
  lobby.countdown = -1;
  lobby.select_next_map = select_next_map;
  lobby.data.mode = 'ranked';
  lobby.match_end_timeout = -1;

  lobby.on('password', async () => {
    // Ranked lobbies never should have a password
    if (lobby.passworded) {
      await lobby.send('!mp password');
    }
  });

  lobby.on('settings', async () => {
    for (const player of lobby.players) {
      if (lobby.playing && player.state != 'No Map') {
        lobby.match_participants[player.username] = player;
      }
    }

    update_median_pp(lobby);

    // Cannot select a map until we fetched the player IDs via !mp settings.
    if (lobby.created_just_now) {
      await lobby.select_next_map();
      lobby.created_just_now = false;
    }
  });

  lobby.on('playerJoined', async (player) => {
    if (player.user_id) {
      update_median_pp(lobby);
      if (lobby.nb_players == 1) {
        await lobby.select_next_map();
      }
    }
  });

  lobby.on('playerLeft', async (player) => {
    // Dodgers get 0 score
    if (player.username in lobby.match_participants) {
      // TODO: mark as dodged
      const score = {
        username: player.username,
        score: 0,
        state: 'FAILED',
      };

      lobby.scores.push(score);
      lobby.emit('score', score);
    }

    update_median_pp(lobby);
    if (lobby.nb_players == 0) {
      await set_new_title(lobby);
    }
  });

  const kick_afk_players = async () => {
    const players_to_kick = [];
    for (const username in lobby.match_participants) {
      // If the player hasn't scored after 10 seconds, they should get kicked
      if (!lobby.scores.some((s) => s.username == username)) {
        players_to_kick.push(username);
      }
    }

    // It never is more than 1 player who is causing issues. To make sure we
    // don't kick the whole lobby, let's wait a bit more.
    if (players_to_kick.length > 1) {
      lobby.match_end_timeout = setTimeout(kick_afk_players, 10000);
      return;
    }

    // TODO: mark player as kicked so they don't get "dodger" penalty
    await lobby.send(`!mp kick ${players_to_kick[0]}`);
  };

  lobby.on('score', (score) => {
    // Sometimes players prevent the match from ending. Bancho will only end
    // the match after ~2 minutes of players waiting, which is very
    // frustrating. To avoid having to close the game or wait an eternity, we
    // kick the offending player.
    if (score.score > 0 && lobby.match_end_timeout == -1) {
      lobby.match_end_timeout = setTimeout(kick_afk_players, 10000);
    }
  });

  lobby.on('matchFinished', async (scores) => {
    clearTimeout(lobby.match_end_timeout);
    lobby.match_end_timeout = -1;

    let match = null;
    let game = null;
    try {
      match = await osu_fetch(`https://osu.ppy.sh/api/v2/matches/${lobby.id}`);
      for (const event of match.events) {
        if (event.game) {
          game = event.game;
        }
      }

      if (game == null) {
        console.error(`No game found in match results, latest_event_id = ${match.latest_event_id}`);
        throw new Error(`No game found in match results`);
      }
    } catch (err) {
      capture_sentry_exception(err);
    }

    await lobby.select_next_map();
    if (!match || !game) return;

    const players = await get_full_players(match, game);
    await save_game_and_update_rating(lobby, game, players);
  });

  lobby.on('allPlayersReady', async () => {
    // Players can spam the Ready button and due to lag, this command could
    // be spammed before the match actually got started.
    if (!lobby.playing) {
      lobby.playing = true;
      await lobby.send(`!mp start .${Math.random().toString(36).substring(2, 6)}`);
    }
  });

  lobby.on('matchStarted', async () => {
    clearTimeout(lobby.countdown);
    lobby.countdown = -1;

    lobby.match_participants = [];
    await lobby.send(`!mp settings ${Math.random().toString(36).substring(2, 6)}`);
  });

  if (lobby.created_just_now) {
    await lobby.send(`!mp settings ${Math.random().toString(36).substring(2, 6)}`);
    await lobby.send('!mp clearhost');
    await lobby.send('!mp password');
    await lobby.send('!mp mods freemod');

    // Lobbies are ScoreV1 - but we ignore the results and get the full score info from osu's API.
    // From that, we can calculate how much PP the play was worth instead of relying on score.
    await lobby.send(`!mp set 0 0 16`);
  } else {
    await lobby.send(`!mp settings (restarted) ${Math.random().toString(36).substring(2, 6)}`);
  }

  bancho.joined_lobbies.push(lobby);
}

export {
  init_lobby,
};
