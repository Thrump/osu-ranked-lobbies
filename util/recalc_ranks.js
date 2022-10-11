import db from '../database.js';
import {update_rating} from '../glicko.js';
import {get_user_by_id} from '../user.js';


async function recalc_osu_user(user_id) {
  const user = await get_user_by_id(user_id);
  const user_rating = user.ratings[0];

  // Fix games played count
  const res = db.prepare(`SELECT COUNT(*) AS nb FROM score WHERE mode = 0 AND user_id = ?`).get(user_id);
  user_rating.nb_scores = res.nb;

  // Recalc rank
  const maps = db.prepare(`
    SELECT *, score.won AS won, score.rowid AS score_id, score.enabled_mods AS mods FROM rating
    INNER JOIN user  ON user.osu_rating = rating.rowid
    INNER JOIN score ON user.user_id = score.user_id
    WHERE score.user_id = ? AND score.rowid > ?`,
  ).all(user_id, user_rating.base_score_id);
  await update_rating(user_rating, maps, true);
}

async function recalc_osu() {
  const res = db.prepare(`SELECT user_id FROM score WHERE mode = 0 GROUP BY user_id`).all();
  for (const user of res) {
    await recalc_osu_user(user.user_id);
  }
}


recalc_osu();
