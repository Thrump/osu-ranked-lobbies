import bancho from './bancho.js';
import db from './database.js';
import {save_game_and_update_rating} from './glicko.js';
import {init_user, get_user_by_id} from './user.js';
import Config from './util/config.js';


async function set_new_title(lobby) {
  let new_title = '';

  const gamemodes = ['std', 'catch', 'mania', 'taiko'];
  const ruleset = gamemodes[lobby.data.ruleset];

  if (lobby.players.length > 0) {
    new_title = `${Math.round(lobby.map.stars, 0.1)}* | o!RL ${ruleset} | Auto map select (!info)`;
  } else {
    new_title = `o!RL ${ruleset} | Auto map select (!info)`;
  }

  if (!Config.IS_PRODUCTION) {
    new_title = 'test lobby';
  }

  if (lobby.name != new_title) {
    await lobby.send(`!mp name ${new_title}`);
    lobby.name = new_title;
  }
}

function update_median_elo(lobby) {
  const elos = [];
  for (const player of lobby.players) {
    elos.push(player.elo);
  }

  if (elos.length == 0) {
    lobby.median_elo = 1500;
    return;
  }

  const middle = Math.floor(elos.length / 2);
  if (elos.length % 2 == 0) {
    lobby.median_elo = (elos[middle - 1] + elos[middle]) / 2;
  } else {
    lobby.median_elo = elos[middle];
  }
}


// When a map gets picked twice in the last 25 games, we automatically add
// another map to the pool.
function add_map_to_season(lobby) {
  const full_map = db.prepare(`
    SELECT * FROM full_map
    WHERE season2 = 0 AND dmca = 0 AND ranked IN (4, 5, 7) AND mode = ?
    INNER JOIN rating ON rating.rowid = full_map.rating_id
    ORDER BY ABS(elo - ?) ASC LIMIT 1`,
  ).get(lobby.data.ruleset, lobby.median_elo);
  if (!full_map) {
    // o_O
    capture_sentry_exception(new Error('RAN OUT OF MAPS!!!!! LOL'));
    return null;
  }

  db.prepare(
      `UPDATE full_map SET season2 = ? WHERE map_id = ?`,
  ).run(Date.now(), full_map.map_id);

  return full_map;
}

async function select_next_map() {
  this.voteskips = [];
  clearTimeout(this.countdown);
  this.countdown = -1;

  if (this.recent_maps.length >= 25) {
    this.recent_maps.shift();
  }

  const select_map = () => {
    // NOTE: in the future, we should increase the LIMIT to 1000
    // However, the map pool starts pretty small and we need to pick relevant maps.
    return db.prepare(`
      SELECT * FROM (
        SELECT * FROM full_map
        WHERE season2 = 1 AND dmca = 0 AND mode = ?
        INNER JOIN rating ON rating.rowid = full_map.rating_id
        ORDER BY ABS(elo - ?) ASC LIMIT 100
      ) ORDER BY RANDOM() LIMIT 1`,
    ).get(lobby.data.ruleset, lobby.median_elo);
  };

  let new_map = select_map();
  if (!new_map || this.recent_maps.includes(new_map.map_id)) {
    new_map = add_map_to_season(this);
    if (!new_map) {
      // Just pick any map...
      new_map = select_map();
    }
  }

  this.recent_maps.push(new_map.map_id);
  const map_elo = db.prepare(`SELECT elo FROM rating WHERE rowid = ?`).get(new_map.rating_id);

  try {
    const sr = new_map.stars;
    const flavor = `${sr.toFixed(2)}*, ${Math.round(map_elo.elo)} elo, ${Math.round(new_map.pp)}pp`;
    const map_name = `[https://osu.ppy.sh/beatmaps/${new_map.id} ${new_map.name}]`;
    const beatconnect_link = `[https://beatconnect.io/b/${new_map.set_id} [1]]`;
    const chimu_link = `[https://chimu.moe/d/${new_map.set_id} [2]]`;
    const nerina_link = `[https://api.nerinyan.moe/d/${new_map.set_id} [3]]`;
    const sayobot_link = `[https://osu.sayobot.cn/osu.php?s=${new_map.set_id} [4]]`;
    await this.send(`!mp map ${new_map.id} ${this.data.ruleset} | ${map_name} (${flavor}) Alternate downloads: ${beatconnect_link} ${chimu_link} ${nerina_link} ${sayobot_link}`);
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
  lobby.median_elo = 1500;

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

    update_median_elo(lobby);

    // Cannot select a map until we fetched the player IDs via !mp settings.
    if (lobby.created_just_now) {
      await lobby.select_next_map();
      lobby.created_just_now = false;
    }
  });

  lobby.on('playerJoined', async (player) => {
    update_median_elo(lobby);
    if (lobby.players.length == 1) {
      await lobby.select_next_map();
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

    update_median_elo(lobby);
    if (lobby.players.length == 0) {
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
    await save_game_and_update_rating(lobby, game);
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
