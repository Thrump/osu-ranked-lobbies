// Note to potential API users:
// - If you want to do batch requests, it's probably better to just ask for
//   the data instead.
// - API is subject to change. Message us if you're using it so we avoid
//   breaking it in the future.

import dayjs from 'dayjs';
import express from 'express';
import relativeTime from 'dayjs/plugin/relativeTime.js';
dayjs.extend(relativeTime);

import Config from './util/config.js';
import bancho from './bancho.js';
import db from './database.js';
import {get_user_ranks} from './glicko.js';
import {init_lobby as init_ranked_lobby} from './ranked.js';
import {init_lobby as init_collection_lobby} from './collection.js';


const USER_NOT_FOUND = new Error('User not found. Have you played a game in a ranked lobby yet?');
USER_NOT_FOUND.http_code = 404;
const RULESET_NOT_FOUND = new Error('Ruleset not found. Must be one of "osu", "taiko", "catch" or "mania".');
RULESET_NOT_FOUND.http_code = 404;


function ruleset_to_mode(ruleset) {
  if (ruleset == 'osu') {
    return 0;
  } else if (ruleset == 'taiko') {
    return 1;
  } else if (ruleset == 'catch') {
    return 2;
  } else if (ruleset == 'mania') {
    return 3;
  } else {
    throw RULESET_NOT_FOUND;
  }
}

function ruleset_to_rating_column(ruleset) {
  if (ruleset == 'osu') {
    return 'osu_rating';
  } else if (ruleset == 'taiko') {
    return 'taiko_rating';
  } else if (ruleset == 'catch') {
    return 'catch_rating';
  } else if (ruleset == 'mania') {
    return 'mania_rating';
  } else {
    throw RULESET_NOT_FOUND;
  }
}


async function get_leaderboard_page(ruleset, page_num) {
  const PLAYERS_PER_PAGE = 20;

  const mode = ruleset_to_mode(ruleset);
  const total_players = db.prepare(
      `SELECT COUNT(*) AS nb FROM rating WHERE mode = ? AND nb_scores > 4`,
  ).get(mode);

  // Fix user-provided page number
  const nb_pages = Math.ceil(total_players.nb / PLAYERS_PER_PAGE);
  if (page_num <= 0 || isNaN(page_num)) {
    page_num = 1;
  }
  if (page_num > nb_pages) {
    page_num = nb_pages;
  }

  const offset = (page_num - 1) * PLAYERS_PER_PAGE;

  const res = db.prepare(`
    SELECT user_id, username, elo FROM user
    INNER JOIN rating ON user.${ruleset_to_rating_column(ruleset)} = rating.rowid
    WHERE rating.mode = ? AND nb_scores > 4
    ORDER BY elo DESC LIMIT ? OFFSET ?`,
  ).all(mode, PLAYERS_PER_PAGE, offset);

  const data = {
    nb_ranked_players: total_players.nb,
    the_one: false,
    players: [],
    page: page_num,
    max_pages: nb_pages,
  };

  // Players
  let ranking = offset + 1;
  if (ranking == 1) {
    data.the_one = {
      user_id: res[0].user_id,
      username: res[0].username,
      ranking: ranking,
      elo: Math.round(res[0].elo),
    };

    res.shift();
    ranking++;
  }

  for (const user of res) {
    data.players.push({
      user_id: user.user_id,
      username: user.username,
      ranking: ranking,
      elo: Math.round(user.elo),
    });

    ranking++;
  }

  return data;
}

async function get_user_profile(user_id) {
  const user = db.prepare(`SELECT user_id, username FROM user WHERE user_id = ?`).get(user_id);
  if (!user) {
    throw USER_NOT_FOUND;
  }

  const rank_info = get_user_ranks(user_id);
  return {
    username: user.username,
    user_id: user.user_id,
    ranks: rank_info,
  };
}

async function get_user_matches(user_id, ruleset, page_num) {
  const mode = ruleset_to_mode(ruleset);
  const total_scores = db.prepare(
      `SELECT COUNT(*) AS nb FROM score WHERE mode = ? AND user_id = ?`,
  ).get(mode, user_id);
  if (total_scores.nb == 0) {
    return {
      matches: [],
      page: 1,
      max_pages: 1,
    };
  }

  // Fix user-provided page number
  const MATCHES_PER_PAGE = 20;
  const nb_pages = Math.ceil(total_scores.nb / MATCHES_PER_PAGE);
  if (page_num <= 0 || isNaN(page_num)) {
    page_num = 1;
  }
  if (page_num > nb_pages) {
    page_num = nb_pages;
  }

  const data = {
    matches: [],
    page: page_num,
    max_pages: nb_pages,
  };

  const offset = (page_num - 1) * MATCHES_PER_PAGE;
  const scores = db.prepare(`
    SELECT beatmap_id, created_at, won FROM score
    WHERE user_id = ? AND mode = ?
    ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  ).all(user_id, mode, MATCHES_PER_PAGE, offset);
  for (const score of scores) {
    data.matches.push({
      map: db.prepare(`SELECT * FROM map WHERE map_id = ?`).get(score.beatmap_id),
      won: score.won,
      time: dayjs(score.created_at).fromNow(),
      tms: Math.round(score.created_at / 1000),
    });
  }

  return data;
}

async function register_routes(app) {
  app.get('/api/leaderboard/:ruleset/:pageNum/', async (req, http_res) => {
    try {
      const data = await get_leaderboard_page(req.params.ruleset, parseInt(req.params.pageNum, 10));
      http_res.set('Cache-control', 'public, max-age=60');
      http_res.json(data);
    } catch (err) {
      http_res.status(err.http_code || 503).json({error: err.message});
    }
  });

  app.get('/api/user/:userId/', async (req, http_res) => {
    try {
      const data = await get_user_profile(parseInt(req.params.userId, 10));
      http_res.set('Cache-control', 'public, max-age=60');
      http_res.json(data);
    } catch (err) {
      http_res.status(err.http_code || 503).json({error: err.message});
    }
  });

  app.get('/api/user/:userId/:ruleset/matches/:pageNum/', async (req, http_res) => {
    try {
      const data = await get_user_matches(
          parseInt(req.params.userId, 10),
          req.params.ruleset,
          parseInt(req.params.pageNum, 10),
      );
      http_res.set('Cache-control', 'public, max-age=60');
      http_res.json(data);
    } catch (err) {
      http_res.status(err.http_code || 503).json({error: err.message});
    }
  });

  app.get('/api/lobbies/', async (req, http_res) => {
    const lobbies = [];

    for (const lobby of bancho.joined_lobbies) {
      lobbies.push({
        bancho_id: lobby.invite_id,
        nb_players: lobby.players.length,
        name: lobby.name,
        mode: lobby.data.type,
        ruleset: lobby.data.ruleset,
        scorev2: lobby.data.is_scorev2,
        creator_name: lobby.data.creator,
        creator_id: lobby.data.creator_id,
        map: lobby.map,
      });
    }

    http_res.json(lobbies);
  });

  app.post('/api/create-lobby/', express.json(), async (req, http_res) => {
    if (!req.user_id) {
      http_res.status(403).json({error: 'You need to be authenticated to create a lobby.'});
      return;
    }

    for (const lobby of bancho.joined_lobbies) {
      if (lobby.data.creator_id == req.user_id) {
        http_res.status(401).json({error: 'You have already created a lobby.'});
        return;
      }
    }

    const ruleset_id = parseInt(req.body.ruleset, 10);
    if (isNaN(ruleset_id) || ruleset_id < 0 || ruleset_id > 3) {
      http_res.status(401).json({error: 'Invalid ruleset.'});
      return;
    }

    let user = db.prepare(`SELECT username FROM user WHERE user_id = ?`).get(req.user_id);
    if (!user) {
      // User has never played in a ranked lobby.
      // But we still can create a lobby for them :)
      user = {
        username: 'New user',
      };
    }
    let lobby = null;
    if (req.body.match_id) {
      try {
        console.info(`Joining lobby of ${user.username}...`);
        lobby = await bancho.join(`#mp_${req.body.match_id}`);
      } catch (err) {
        http_res.status(400).json({error: `Failed to join the lobby`, details: err.message});
        return;
      }
    } else {
      try {
        console.info(`Creating lobby for ${user.username}...`);
        lobby = await bancho.make(Config.IS_PRODUCTION ? `New o!RL lobby` : `test lobby`);
        await lobby.send(`!mp addref #${req.user_id}`);
      } catch (err) {
        http_res.status(400).json({error: 'Could not create the lobby', details: err.message});
        return;
      }
    }

    try {
      lobby.created_just_now = true;
      lobby.data.creator = user.username;
      lobby.data.creator_id = req.user_id;
      lobby.data.ruleset = parseInt(req.body.ruleset, 10);

      if (req.body.type == 'ranked') {
        await init_ranked_lobby(lobby);
      } else {
        if (req.body.title) {
          await lobby.send(`!mp name ${req.body.title}`);
          lobby.name = req.body.title;
        }

        if (req.body.star_rating == 'fixed') {
          lobby.data.min_stars = req.body.min_stars;
          lobby.data.max_stars = req.body.max_stars;
          lobby.data.fixed_star_range = true;
        } else {
          lobby.data.fixed_star_range = false;
        }

        lobby.data.collection_id = req.body.collection_id;
        await init_collection_lobby(lobby);
      }
    } catch (err) {
      http_res.status(503).json({error: 'An error occurred while creating the lobby', details: err.message});
      return;
    }

    http_res.status(200).json({
      success: true,
      lobby: {
        bancho_id: lobby.invite_id,
        nb_players: lobby.players.length,
        name: lobby.name,
        mode: lobby.data.type,
        scorev2: lobby.data.is_scorev2,
        creator_name: lobby.data.creator,
        creator_id: lobby.data.creator_id,
        map: lobby.map,
      },
    });
  });
}

export {
  register_routes,
};
