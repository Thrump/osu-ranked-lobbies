import {osu_fetch} from './api.js';
import bancho from './bancho.js';
import db from './database.js';


async function init_user(user_id, user_data) {
  if (!user_data) {
    const res = await osu_fetch(`https://osu.ppy.sh/api/v2/users?ids[0]=${user_id}`);
    user_data = res.users[0];
  }

  // Migrate old profiles
  const discord_user_id = null;
  const discord_role = null;
  const old_profile = db.prepare(`SELECT * FROM old_discord_user WHERE osu_id = ?`).get(user_id);
  if (old_profile) {
    discord_user_id = old_profile.discord_id;
    discord_role = old_profile.discord_rank;
  }

  // Approximate elo from total_pp
  const total_pp_to_mu = (total_pp) => {
    if (!total_pp) total_pp = 0;
    let elo = total_pp * 0.15;
    if (elo < 500) elo = 500;
    if (elo > 2500) elo = 2500;
    return (elo - 1500) / 173.7178;
  };

  const osu_mu = total_pp_to_mu(user_data.statistics_rulesets.osu?.pp);
  const osu_rating = db.prepare(
      `INSERT INTO rating (mode, base_mu, current_mu) VALUES (0, ?, ?) RETURNING rowid`,
  ).get(osu_mu, osu_mu).rowid;

  const catch_mu = total_pp_to_mu(user_data.statistics_rulesets.fruits?.pp);
  const catch_rating = db.prepare(
      `INSERT INTO rating (mode, base_mu, current_mu) VALUES (1, ?, ?) RETURNING rowid`,
  ).get(catch_mu, catch_mu).rowid;

  const mania_mu = total_pp_to_mu(user_data.statistics_rulesets.mania?.pp);
  const mania_rating = db.prepare(
      `INSERT INTO rating (mode, base_mu, current_mu) VALUES (2, ?, ?) RETURNING rowid`,
  ).get(mania_mu, mania_mu).rowid;

  const taiko_mu = total_pp_to_mu(user_data.statistics_rulesets.taiko?.pp);
  const taiko_rating = db.prepare(
      `INSERT INTO rating (mode, base_mu, current_mu) VALUES (3, ?, ?) RETURNING rowid`,
  ).get(taiko_mu, taiko_mu).rowid;

  return db.prepare(`
      INSERT INTO full_user (
        user_id, username, country_code, profile_data,
        osu_rating, catch_rating, mania_rating, taiko_rating,
        discord_user_id, discord_role
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).get(
      user_id, user_data.username, user_data.country_code, JSON.stringify(user_data),
      osu_rating, catch_rating, mania_rating, taiko_rating,
      discord_user_id, discord_role,
  );
}


async function get_user_by_id(user_id, create) {
  let user = db.prepare(`SELECT * FROM full_user WHERE user_id = ?`).get(user_id);
  if (user) {
    return user;
  }

  if (!create) {
    return null;
  }

  user = await init_user(user_id);
  return user;
}

async function get_user_by_name(name) {
  let user = db.prepare(`SELECT * FROM full_user WHERE username = ?`).get(name);
  if (user) {
    return user;
  }

  let user_id;
  try {
    user_id = await bancho.whois(name);
  } catch (err) {
    user_id = await osu_fetch(`https://osu.ppy.sh/api/v2/users/${name}?key=username`).id;
  }

  if (!user_id) {
    return null;
  }

  user = await get_user_by_id(user_id);
  return user;
}

export {init_user, get_user_by_id, get_user_by_name};
