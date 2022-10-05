import {constants} from 'fs';
import {createRequire} from 'module';
const require = createRequire(import.meta.url);
const rosu = require('rosu-pp');

import {osu_fetch} from './api.js';
import db from './database.js';


// Get metadata and pp from map ID (downloads it if not already downloaded)
async function get_map_info(map_id) {
  const map = db.prepare(`SELECT * FROM full_map WHERE map_id = ?`).run(map_id);
  if (map) {
    return map;
  }

  // 1. Download the map
  // Looking for .osu files? peppy provides monthly dumps here: https://data.ppy.sh/
  const file = `maps/${parseInt(map_id, 10)}.osu`;
  try {
    await fs.access(file, constants.F_OK);
  } catch (err) {
    console.log(`Beatmap id ${map_id} not found, downloading it.`);
    const new_file = await fetch(`https://osu.ppy.sh/osu/${map_id}`);
    const text = await new_file.text();
    if (text == '') {
      // While in most cases an empty page means the map ID doesn't exist, in
      // some rare cases osu! servers actually don't have the .osu file for a
      // valid map ID. But we can't do much about it.
      throw new Error('Invalid map ID');
    }
    await fs.writeFile(file, text);
  }

  // 2. Process it with rosu-pp
  const info = rosu.calculate({path: file})[0];
  const approx_mu = info.difficulty_rating * 325; // 4.6* ~= 1500 elo (patented algorithm)

  // 3. Get additionnal map info from osu!api
  // (we can't get the following just from the .osu file: set_id, length, ranked, dmca)
  console.info(`[API] Fetching map data for map ID ${map_id}`);
  const res = await osu_fetch(`https://osu.ppy.sh/api/v2/beatmaps/lookup?id=${map_id}`);
  const api_res = await res.json();

  // 4. Cause eyeStrain to the reader
  db.prepare(`
    INSERT INTO full_map (
      map_id, name, mode, stars, pp, pp_aim, pp_acc, pp_fl, pp_speed, pp_strain,
      strain_aim, strain_speed, ar, cs, hp, od, bpm, set_id, length, ranked, dmca, mu
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      map_id, api_res.mode_int, api_res.difficulty_rating, info.pp, info.ppAim,
      info.ppAcc, info.ppFlashlight, info.ppSpeed, info.ppStrain, info.aimStrain,
      info.speedStrain, info.ar, info.cs, info.hp, info.od, info.bpm,
      api_res.beatmapset.id, api_res.total_length, api_res.beatmapset.ranked,
      api_res.beatmapset.availability.download_disabled ? 1 : 0, approx_mu,
  );

  return await get_map_info(map_id);
}

export {get_map_info};
