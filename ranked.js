import bancho from './bancho.js';
import databases from './database.js';
import {update_mmr} from './glicko.js';

import {scan_user_profile} from './profile_scanner.js';
import Config from './util/config.js';


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
  // When API is down or instable, match scores can't get processed in real
  // time. Workaround: process those later, when the API is working again.
  // As long as less than 32 matches happen before the API goes back up,
  // scores shouldn't get memory holed.
  // TODO: verify API indeed stops at 32 matches, and the 32 last, not 32 first
  //       (will need to check some other bot lobby in multi menu)
  lobby.data.api_backlog = 0;

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
      // Have not scanned the player's profile in the last 24 hours
      if (player.last_update_tms + (3600 * 24 * 1000) <= Date.now()) {
        await scan_user_profile(player);
      }

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


    try {
      res = await fetch(`https://osu.ppy.sh/api/get_match?k=${Config.osu_v1api_key}&m=${lobby.id}`);
    } catch (err) {
      throw new Error(`Failed to fetch match info for lobby ${lobby.id}.`);
      lobby.data.api_backlog = lobby.data.api_backlog + 1;
    }


    const rank_updates = update_mmr(lobby);
    await lobby.select_next_map();

    if (rank_updates.length > 0) {
      // Max 8 rank updates per message - or else it starts getting truncated
      const MAX_UPDATES_PER_MSG = 6;
      for (let i = 0, j = rank_updates.length; i < j; i += MAX_UPDATES_PER_MSG) {
        const updates = rank_updates.slice(i, i + MAX_UPDATES_PER_MSG);

        if (i == 0) {
          await lobby.send('Rank updates: ' + updates.join(' | '));
        } else {
          await lobby.send(updates.join(' | '));
        }
      }
    }
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
