// Required reading:
// - https://en.wikipedia.org/wiki/Glicko_rating_system
// - http://www.glicko.net/glicko/glicko2.pdf

// NOTE: This is VERY unoptimized and super database intensive. (i just wanted to get it done first)
//       Anyone is welcome to fix this xD

import bancho from './bancho.js';
import db from './database.js';
import {update_division} from './discord_updates.js';
import Config from './util/config.js';
import {get_user_by_id} from './user.js';
import {capture_sentry_exception} from './util/helpers.js';


const RANK_DIVISIONS = [
  'Cardboard',
  'Wood',
  'Wood+',
  'Bronze',
  'Bronze+',
  'Silver',
  'Silver+',
  'Gold',
  'Gold+',
  'Platinum',
  'Platinum+',
  'Diamond',
  'Diamond+',
  'Rhythm Incarnate',
];


// TODO: move to postgresql before deploy?


function save_rating_to_db(rating) {
  rating.elo = (rating.current_mu * 173.7178 + 1500 - 3 * rating.current_sig * 173.7178);

  db.prepare(`
    UPDATE rating SET
      base_sig = ?,
      base_mu = ?,
      base_score_id = ?,
      current_sig = ?,
      current_mu = ?,
      nb_scores = ?,
      elo = ?
    WHERE rowid = ?`,
  ).run(
      rating.base_sig,
      rating.base_mu,
      rating.base_score_id,
      rating.current_sig,
      rating.current_mu,
      rating.nb_scores,
      rating.elo,
      rating.rowid,
  );

  if (rating.mode == 0) {
    db.prepare(`UPDATE user SET osu_elo = ? WHERE osu_rating = ?`).run(rating.elo, rating.rowid);
  } else if (rating.mode == 1) {
    db.prepare(`UPDATE user SET taiko_elo = ? WHERE taiko_rating = ?`).run(rating.elo, rating.rowid);
  } else if (rating.mode == 2) {
    db.prepare(`UPDATE user SET catch_elo = ? WHERE catch_rating = ?`).run(rating.elo, rating.rowid);
  } else if (rating.mode == 3) {
    db.prepare(`UPDATE user SET mania_elo = ? WHERE mania_rating = ?`).run(rating.elo, rating.rowid);
  }
}


// Recompute the rating of a map or a player
// OGS-style: we keep a base rating and a current rating for better accuracy.
// https://forums.online-go.com/t/ogs-has-a-new-glicko-2-based-rating-system/13058
//
// NOTE: ratings have additional temporary "won" and "score_id" fields
async function update_rating(entity, ratings, is_player) {
  if (ratings.length == 0) return;

  let i = 0;
  let outcomes = 0.0;
  let variance = 0.0;
  for (const score of ratings) {
    if (!Array.isArray(score.mods)) {
      score.mods = JSON.parse(score.mods);
    }
    const allowed_mods = ['HD', 'HR', 'SD', 'PF', 'DT', 'NC', 'FI', 'FL', 'MR'];
    let ignore_score = false;
    for (const mod of score.mods) {
      if (allowed_mods.indexOf(mod) == -1) {
        ignore_score = true;
        break;
      }
    }
    if (ignore_score) {
      continue;
    }

    let result = 0.5;
    if (is_player) {
      // players get their score from themselves
      result = score.won ? 1.0 : 0.0;
    } else {
      // maps get their score from their opponents
      result = score.won ? 0.0 : 1.0;
    }

    const fval = 1.0 / Math.sqrt(1.0 + 3.0 * score.current_sig * score.current_sig / (Math.PI * Math.PI));
    const gval = 1.0 / (1.0 + Math.exp(-fval * (entity.current_mu - score.current_mu)));
    variance += fval * fval * gval * (1.0 - gval);
    outcomes += fval * (result - gval);
    i++;

    if (i == 15) {
      // Completed a rating period; save and replace previous base rating
      entity.base_sig = 1.0 / Math.sqrt((1.0 / (entity.base_sig * entity.base_sig)) + (1.0 / Math.pow(variance, -1.0)));
      entity.base_mu = entity.base_mu + entity.base_sig * entity.base_sig * outcomes;
      entity.base_sig = Math.max(30 / 173.7178, Math.min(350 / 173.7178, entity.base_sig));
      entity.base_score_id = score.score_id;
      entity.current_sig = entity.base_sig;
      entity.current_mu = entity.base_mu;
      save_rating_to_db(entity);

      // Reset so we keep processing the rest with a new base & current rating
      outcomes = 0.0;
      variance = 0.0;
      i = 0;
    }
  }

  if (outcomes == 0.0 && variance == 0.0) {
    // Numbers wouldn't change anyway, but this avoids an UPDATE call
    return;
  }

  // Didn't complete a rating period; still update current rating
  entity.current_sig = 1.0 / Math.sqrt((1.0 / (entity.base_sig * entity.base_sig)) + (1.0 / Math.pow(variance, -1.0)));
  entity.current_mu = entity.base_mu + entity.current_sig * entity.current_sig * outcomes;
  entity.current_sig = Math.max(30 / 173.7178, Math.min(350 / 173.7178, entity.current_sig));
  save_rating_to_db(entity);
}


async function save_game_and_update_rating(lobby, game) {
  if (!game || !game.scores) return;

  // Remove afk-kicked from the scores
  const score_valid = (score) => {
    for (const player of lobby.match_participants) {
      if (player.user_id == score.user_id) {
        return true;
      }
    }
    return false;
  };
  game.scores = game.scores.filter(score_valid);

  const tms = Date.parse(game.end_time).valueOf();
  const rating_columns = ['osu_rating', 'taiko_rating', 'catch_rating', 'mania_rating'];

  try {
    db.prepare(`INSERT INTO game (
      game_id, match_id, start_time, end_time, beatmap_id,
      play_mode, scoring_type, team_type, mods
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        game.id, lobby.id, Date.parse(game.start_time).valueOf(), tms, game.beatmap.id,
        game.mode_int, game.scoring_type, game.team_type, JSON.stringify(game.mods),
    );
  } catch (err) {
    if (err.message != 'UNIQUE constraint failed: game.game_id') {
      capture_sentry_exception(err);
    }

    return;
  }

  const players = [];
  for (const score of game.scores) {
    let player = players.find((p) => p.user_id == score.user_id);
    if (!player) {
      player = await get_user_by_id(score.user_id);
    }
    score.player = player;
    players.push(player);

    const won = score.passed && (score.accuracy > 0.95);
    db.prepare(`INSERT INTO score (
      game_id, user_id, mode, accuracy, score, max_combo,
      count_50, count_100, count_300, count_miss, count_geki, count_katu,
      perfect, pass, enabled_mods, created_at, beatmap_id, won
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        game.id, score.user_id, game.mode_int, score.accuracy, score.score, score.max_combo,
        score.statistics.count_50, score.statistics.count_100, score.statistics.count_300,
        score.statistics.count_miss, score.statistics.count_geki, score.statistics.count_katu,
        score.perfect ? 1 : 0, score.passed ? 1 : 0, JSON.stringify(score.mods),
        Date.parse(score.created_at).valueOf(), game.beatmap.id, won ? 1 : 0,
    );
  }

  // Update map rating
  const map_rating = db.prepare(`
    SELECT * FROM rating
    INNER JOIN map ON map.rating_id = rating.rowid
    WHERE map.map_id = ?`,
  ).get(game.beatmap.id);
  map_rating.nb_scores++;

  // All scores+ratings of players who played the map after base_score_id
  const scores = db.prepare(`
    SELECT *, score.won AS won, score.rowid AS score_id, score.enabled_mods AS mods FROM rating
    INNER JOIN user  ON user.${rating_columns[game.mode_int]} = rating.rowid
    INNER JOIN score ON user.user_id = score.user_id
    WHERE score.beatmap_id = ? AND score.rowid > ?
    ORDER BY score.rowid ASC`,
  ).all(game.beatmap.id, map_rating.base_score_id);
  await update_rating(map_rating, scores, false);

  // Update player ratings
  for (const score of game.scores) {
    const user_rating = score.player.ratings[game.mode_int];
    user_rating.nb_scores++;

    // All scores+ratings of maps played by the user after base_score_id
    const maps = db.prepare(`
      SELECT *, score.won AS won, score.rowid AS score_id, score.enabled_mods AS mods FROM rating
      INNER JOIN user  ON user.${rating_columns[game.mode_int]} = rating.rowid
      INNER JOIN score ON user.user_id = score.user_id
      WHERE score.user_id = ? AND score.rowid > ?`,
    ).all(score.user_id, user_rating.base_score_id);
    await update_rating(user_rating, maps, true);
  }

  // Usually, we're in a live lobby, but sometimes we're just recomputing
  // scores (like after updating the ranking algorithm), so we return early.
  if (!bancho.connected) {
    return;
  }

  const rank_changes = [];
  const division_to_index = (text) => {
    if (text == 'Unranked') {
      return -1;
    } else if (text == 'The One') {
      return RANK_DIVISIONS.length;
    } else {
      return RANK_DIVISIONS.indexOf(text);
    }
  };

  const division_columns = ['osu_division', 'taiko_division', 'catch_division', 'mania_division'];
  const all_users = db.prepare(`SELECT COUNT(*) AS nb FROM rating WHERE mode = ?`).get(game.mode_int);
  for (const player of players) {
    if (player[rating_columns[game.mode_int]].nb_scores < 5) continue;

    const better_users = db.prepare(
        `SELECT COUNT(*) AS nb FROM rating WHERE mode = ? AND elo > ?`,
    ).get(game.mode_int, player.ratings[game.mode_int].elo);
    const ratio = 1.0 - (better_users.nb / all_users.nb);
    const old_rank_text = player[division_columns[game.mode_int]];
    const new_rank_text = get_rank_text(ratio, all_users.nb);

    if (old_rank_text != new_rank_text) {
      if (division_to_index(new_rank_text) > division_to_index(old_rank_text)) {
        rank_changes.push(`${player.username} [${Config.website_base_url}/u/${player.user_id}/ ▲ ${new_rank_text} ]`);
      } else {
        rank_changes.push(`${player.username} [${Config.website_base_url}/u/${player.user_id}/ ▼ ${new_rank_text} ]`);
      }

      db.prepare(`UPDATE user SET ${division_columns[game.mode_int]} = ? WHERE user_id = ?`).run(new_rank_text, player.user_id);
      update_division(player.user_id); // async but don't care about result
    }
  }

  if (rank_changes.length > 0) {
    // Max 8 rank updates per message - or else it starts getting truncated
    const MAX_UPDATES_PER_MSG = 6;
    for (let i = 0, j = rank_changes.length; i < j; i += MAX_UPDATES_PER_MSG) {
      const updates = rank_changes.slice(i, i + MAX_UPDATES_PER_MSG);

      if (i == 0) {
        await lobby.send('Rank updates: ' + updates.join(' | '));
      } else {
        await lobby.send(updates.join(' | '));
      }
    }
  }
}


function get_rank_text(rank_float, nb_scores) {
  if (!rank_float || nb_scores < 5) {
    return 'Unranked';
  }
  if (rank_float == 1.0) {
    return 'The One';
  }

  // Epic rank distribution algorithm
  for (let i = 0; i < RANK_DIVISIONS.length; i++) {
    // Turn current 'Cardboard' rank into a value between 0 and 1
    const rank_nb = (i + 1) / RANK_DIVISIONS.length;

    // To make climbing ranks more satisfying, we make lower ranks more common.
    // Visual representation: https://graphtoy.com/?f1(x,t)=1-((cos(x%5E0.8*%F0%9D%9C%8B)/2)+0.5)&v1=true&f2(x,t)=&v2=true&f3(x,t)=&v3=false&f4(x,t)=&v4=false&f5(x,t)=&v5=false&f6(x,t)=&v6=false&grid=true&coords=0.3918011117299855,0.3722110561434862,1.0068654346588846
    const cutoff = 1 - ((Math.cos(Math.pow(rank_nb, 0.8) * Math.PI) / 2) + 0.5);
    if (rank_float < cutoff) {
      return RANK_DIVISIONS[i];
    }
  }

  // Ok, floating point errors, who cares
  return RANK_DIVISIONS[RANK_DIVISIONS.length - 1];
}

function get_map_rank(map_id) {
  const res = db.prepare(`
    SELECT nb_scores, elo, map.mode AS mode
    FROM rating
    INNER JOIN map ON map.rating_id = rating.rowid
    WHERE map.map_id = ?`,
  ).get(map_id);
  const all = db.prepare(
      `SELECT COUNT(*) FROM rating WHERE mode = ?`,
  ).get(res.mode + 4);
  const better = db.prepare(
      `SELECT COUNT(*) FROM rating WHERE mode = ? AND elo > ?`,
  ).get(res.mode + 4, res.elo);

  const ratio = 1.0 - (better / all);
  return {
    mode: res.mode,
    elo: res.nb_scores < 5 ? '???' : res.elo,
    ratio: ratio,
    total_nb: all,
    rank_nb: res.nb_scores < 5 ? '???' : better + 1,
    nb_scores: res.nb_scores,
    text: get_rank_text(ratio, res.nb_scores),
  };
}

function get_user_ranks(user_id) {
  if (!user_id) return null;

  const elos = db.prepare(`
    SELECT 
      a.elo AS osu_elo,   a.nb_scores AS nb_osu_scores,
      b.elo AS taiko_elo, b.nb_scores AS nb_taiko_scores,
      c.elo AS catch_elo, c.nb_scores AS nb_catch_scores,
      d.elo AS mania_elo, d.nb_scores AS nb_mania_scores
    FROM user
    INNER JOIN rating a ON a.rowid = user.osu_rating
    INNER JOIN rating b ON b.rowid = user.taiko_rating
    INNER JOIN rating c ON c.rowid = user.catch_rating
    INNER JOIN rating d ON d.rowid = user.mania_rating
    WHERE user.user_id = ?`,
  ).get(user_id);
  if (!elos) {
    return null;
  }

  const all_users = db.prepare(`SELECT
    (SELECT COUNT(*) FROM rating WHERE mode = 0) AS nb_osu,
    (SELECT COUNT(*) FROM rating WHERE mode = 1) AS nb_taiko,
    (SELECT COUNT(*) FROM rating WHERE mode = 2) AS nb_catch,
    (SELECT COUNT(*) FROM rating WHERE mode = 3) AS nb_mania
  `).get();
  const better_users = db.prepare(`SELECT
    (SELECT COUNT(*) FROM rating WHERE mode = 0 AND elo > ?) AS nb_osu,
    (SELECT COUNT(*) FROM rating WHERE mode = 1 AND elo > ?) AS nb_taiko,
    (SELECT COUNT(*) FROM rating WHERE mode = 2 AND elo > ?) AS nb_catch,
    (SELECT COUNT(*) FROM rating WHERE mode = 3 AND elo > ?) AS nb_mania
  `).get(elos.osu_elo, elos.taiko_elo, elos.catch_elo, elos.mania_elo);

  const build_rating = (mode, elo, nb_total, nb_better, nb_scores) => {
    const ratio = 1.0 - (nb_better / nb_total);
    return {
      mode: mode,
      elo: nb_scores < 5 ? '???' : elo,
      ratio: ratio,
      total_nb: nb_total,
      rank_nb: nb_scores < 5 ? '???' : nb_better + 1,
      nb_scores: nb_scores,
      text: get_rank_text(ratio, nb_scores),
    };
  };
  return [
    build_rating(0, elos.osu_elo, all_users.nb_osu, better_users.nb_osu, elos.nb_osu_scores),
    build_rating(1, elos.taiko_elo, all_users.nb_taiko, better_users.nb_taiko, elos.nb_taiko_scores),
    build_rating(2, elos.catch_elo, all_users.nb_catch, better_users.nb_catch, elos.nb_catch_scores),
    build_rating(3, elos.mania_elo, all_users.nb_mania, better_users.nb_mania, elos.nb_mania_scores),
  ];
}

export {save_game_and_update_rating, get_map_rank, get_user_ranks, update_rating};
