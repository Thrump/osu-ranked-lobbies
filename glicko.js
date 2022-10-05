// Required reading:
// - https://en.wikipedia.org/wiki/Glicko_rating_system
// - http://www.glicko.net/glicko/glicko2.pdf

import db from './database.js';
import {update_division} from './discord_updates.js';
import Config from './util/config.js';
import {capture_sentry_exception} from './util/helpers.js';


const RANK_DIVISIONS = [
  'Cardboard',
  'Wood',
  'Wood+',
  'Wood++',
  'Bronze',
  'Bronze+',
  'Bronze++',
  'Silver',
  'Silver+',
  'Silver++',
  'Gold',
  'Gold+',
  'Gold++',
  'Platinum',
  'Platinum+',
  'Platinum++',
  'Diamond',
  'Diamond+',
  'Diamond++',
  'Legendary',
];


// Recompute the rating of a map or a player
// OGS-style: we keep a base rating and a current rating for better accuracy.
// https://forums.online-go.com/t/ogs-has-a-new-glicko-2-based-rating-system/13058
//
// NOTE: entity/opponents have additional temporary "won" and "score_id" fields
async function update_rating(entity, opponent_ratings) {
  if (opponent_ratings.length == 0) return;
  const is_map = typeof entity.won === 'undefined';

  let i = 0;
  let outcomes = 0.0;
  let variance = 0.0;
  for (const opponent of opponent_ratings) {
    let score = 0.5;
    if (is_map) {
      // maps get their score from their opponents
      score = opponent.won ? 0.0 : 1.0;
    } else {
      // players get their score from themselves
      score = entity.won ? 1.0 : 0.0;
    }

    const fval = 1.0 / Math.sqrt(1.0 + 3.0 * opponent.current_sig * opponent.current_sig / (Math.PI * Math.PI));
    const gval = 1.0 / (1.0 + Math.exp(-fval * (entity.current_mu - opponent.current_mu)));
    variance += fval * fval * gval * (1.0 - gval);
    outcomes += fval * (score - gval);
    i++;

    if (i == 15) {
      // Completed a rating period; save and replace previous base rating
      entity.base_sig = 1.0 / Math.sqrt((1.0 / (entity.base_sig * entity.base_sig)) + (1.0 / Math.pow(variance, -1.0)));
      entity.base_mu = entity.base_mu + entity.base_sig * entity.base_sig * outcomes;
      entity.base_sig = Max.max(30 / 173.7178, Math.min(350 / 173.7178, entity.base_sig));

      if (is_map) {
        entity.base_score_id = opponent.score_id;
      } else {
        entity.base_score_id = entity.score_id; // TODO make sure this is set!
      }

      entity.current_sig = entity.base_sig;
      entity.current_mu = entity.base_mu;

      db.prepare(`UPDATE rating
        SET base_sig = ?, base_mu = ?, base_score_id = ?, current_sig = ?, current_mu = ?
        WHERE rating_id = ?`).run(
          entity.base_sig, entity.base_mu, entity.base_score_id, entity.current_sig, entity.current_mu,
          entity.rating_id,
      );

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
  entity.current_sig = Max.max(30 / 173.7178, Math.min(350 / 173.7178, entity.current_sig));
  db.prepare(`UPDATE rating SET current_sig = ?, current_mu = ? WHERE rating_id = ?`).run(
      entity.rating_id, entity.current_sig, entity.current_mu,
  );
}


async function save_game_and_update_rating(lobby, game, players) {
  if (!game || game.scores.length < 2) return [];

  // TODO: handle dodgers - check if API includes them (doubt it does)

  const tms = Date.parse(game.end_time);
  let rating_column;
  let division_column;
  if (game.mode == 'osu') {
    rating_column = 'osu_rating';
    division_column = 'osu_division';
  } else if (game.mode == 'fruits') {
    rating_column = 'catch_rating';
    division_column = 'catch_division';
  } else if (game.mode == 'mania') {
    rating_column = 'mania_rating';
    division_column = 'mania_division';
  } else if (game.mode == 'taiko') {
    rating_column = 'taiko_rating';
    division_column = 'taiko_division';
  } else {
    throw new Error(`Unknown game mode '${game.mode}'`);
  }

  db.prepare(`INSERT INTO game (
    game_id, match_id, start_time, end_time, beatmap_id,
    play_mode, scoring_type, team_type, mods
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      game.id, lobby.id, Date.parse(game.start_time), tms, game.beatmap.id,
      game.mode_int, game.scoring_type, game.team_type, game.mods.toString(),
  );

  for (const score of game.scores) {
    db.prepare(`INSERT INTO full_score (
      game_id, user_id, slot, team, score, max_combo,
      count_50, count_100, count_300, count_miss, count_geki, count_katu,
      perfect, pass, enabled_mods, created_at, beatmap_id, dodged
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        game.id, score.user_id, score.match.slot, score.match.team, score.score, score.max_combo,
        score.statistics.count_50, score.statistics.count_100, score.statistics.count_300,
        score.statistics.count_miss, score.statistics.count_geki, score.statistics.count_katu,
        score.perfect, score.pass, score.mods.toString(), Date.parse(score.created_at),
        game.beatmap.id, 0,
    );
  }

  // I am aware that the following is very database intensive.
  // But I don't give a shit. I'll worry about it later :)

  // Update map rating
  const map_rating = db.prepare(`
    SELECT * FROM rating
    INNER JOIN full_map ON full_map.rating_id = rating.rowid
    WHERE full_map.map_id = ?`,
  ).get(game.beatmap.id);
  const scores = db.prepare(`
    SELECT
      full_score.rowid AS score_id,
      ((NOT full_score.dodged) AND full_score.pass AND (full_score.accuracy > 0.95)) AS won,
      *
    FROM rating
    INNER JOIN full_user  ON full_user.${rating_column} = rating.rowid
    INNER JOIN full_score ON full_user.user_id = full_score.user_id
    WHERE full_score.beatmap_id = ? AND full_score.rowid > ?
    ORDER BY full_score.rowid ASC`,
  ).get(game.beatmap.id, map_rating.base_score_id);
  await update_rating(map_rating, scores);

  // Update player ratings
  for (const score of game.scores) {
    const user_rating = db.prepare(`
      SELECT * FROM rating
      INNER JOIN full_user ON full_user.${rating_column} = rating.rowid
      WHERE full_user.user_id = ?`,
    ).get(score.user_id);
    const maps = db.prepare(`
      SELECT
        full_score.rowid AS score_id,
        ((NOT full_score.dodged) AND full_score.pass AND (full_score.accuracy > 0.95)) AS won,
        *
      FROM rating
      INNER JOIN full_user  ON full_user.${rating_column} = rating.rowid
      INNER JOIN full_score ON full_user.user_id = full_score.user_id
      WHERE full_score.user_id = ? AND full_score.rowid > ?`,
    ).get(score.user_id, user_rating.base_score_id);
    await update_rating(user_rating, maps);
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

  for (const player of players) {
    if (player.games_played < 5) continue;

    const new_rank = get_rank(player.elo);
    if (new_rank.text != player.rank_text) {
      const old_index = division_to_index(player.rank_text);
      const new_index = division_to_index(new_rank.text);

      if (new_index > old_index) {
        rank_changes.push(`${player.username} [${Config.website_base_url}/u/${player.user_id}/ ▲ ${new_rank.text} ]`);
      } else {
        rank_changes.push(`${player.username} [${Config.website_base_url}/u/${player.user_id}/ ▼ ${new_rank.text} ]`);
      }

      player.rank_float = new_rank.ratio;
      player.rank_text = new_rank.text;
      db.prepare(`
        UPDATE full_user
        SET ${division_column} = ?
        WHERE user_id = ?`,
      ).run(
          new_rank.text,
          player.user_id,
      );
      update_division(player.user_id, new_rank.text); // async but don't care about result
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


function get_rank_text(rank_float) {
  if (rank_float == null || typeof rank_float === 'undefined') {
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

function get_rank(elo) {
  const month_ago_tms = Date.now() - (30 * 24 * 3600 * 1000);
  const all_users = stmts.ranked_user_count.get(month_ago_tms);
  const better_users = stmts.better_users_count.get(elo, month_ago_tms);
  const ratio = 1.0 - (better_users.nb / all_users.nb);

  return {
    elo: elo,
    ratio: ratio,
    total_nb: all_users.nb,
    rank_nb: better_users.nb + 1,
    text: get_rank_text(ratio),
  };
}

function get_user_ranks(user_id) {
  const elos = db.prepare(`SELECT (
      (a.current_mu - 3 * a.current_sig) AS osu_elo,
      (b.current_mu - 3 * b.current_sig) AS catch_elo,
      (c.current_mu - 3 * c.current_sig) AS mania_elo,
      (d.current_mu - 3 * d.current_sig) AS taiko_elo,
    ) FROM full_user
    INNER JOIN rating a ON a.rowid = full_user.osu_rating
    INNER JOIN rating b ON b.rowid = full_user.catch_rating
    INNER JOIN rating c ON c.rowid = full_user.mania_rating
    INNER JOIN rating d ON d.rowid = full_user.taiko_rating
    WHERE full_user.user_id = ?`
  ).get(user_id);
  const better_users = db.prepare(`SELECT (
    SELECT COUNT(*) AS nb_osu   FROM rating WHERE mode = 0 AND (current_mu - 3 * current_sig) > ?,
    SELECT COUNT(*) AS nb_catch FROM rating WHERE mode = 1 AND (current_mu - 3 * current_sig) > ?,
    SELECT COUNT(*) AS nb_mania FROM rating WHERE mode = 2 AND (current_mu - 3 * current_sig) > ?,
    SELECT COUNT(*) AS nb_taiko FROM rating WHERE mode = 3 AND (current_mu - 3 * current_sig) > ?,
  )`).get(elos.osu_elo, elos.catch_elo, elos.mania_elo, elos.taiko_elo);


  db.prepare(`
    SELECT COUNT(*) AS nb FROM rating
    WHERE (current_mu - 3 * current_sig)
    `);


  const stmts = {
    elo_from_id: databases.ranks.prepare(`
    SELECT elo, games_played FROM user
    WHERE user_id = ?`,
    ),
    ranked_user_count: databases.ranks.prepare(`
    SELECT COUNT(*) AS nb FROM user
    WHERE games_played > 4 AND last_contest_tms > ?`,
    ),
    better_users_count: databases.ranks.prepare(`
    SELECT COUNT(*) AS nb FROM user
    WHERE elo > ? AND games_played > 4 AND last_contest_tms > ?`,
    ),
  };


  const all_users = stmts.ranked_user_count.get();
  const better_users = stmts.better_users_count.get(user_id);
  const ratio = 1.0 - (better_users.nb / all_users.nb);
}

function get_rank_text_from_id(osu_user_id) {
  const res = stmts.elo_from_id.get(osu_user_id);
  if (!res || !res.elo || res.games_played < 5) {
    return 'Unranked';
  }

  return get_rank(res.elo).text;
}

export {save_game_and_update_rating, get_rank, get_rank_text_from_id};
