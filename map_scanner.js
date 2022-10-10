import * as fs from 'fs/promises';
import {constants} from 'fs';
import {createRequire} from 'module';
import fetch from 'node-fetch';
const require = createRequire(import.meta.url);
const rosu = require('rosu-pp');

import {osu_fetch} from './api.js';
import db from './database.js';


// Get metadata and pp from map ID (downloads it if not already downloaded)
async function get_map_info(map_id, api_res) {
  const map = db.prepare(`SELECT * FROM map WHERE map_id = ?`).get(map_id);
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
  let approx_mu = (info.stars * 325 - 1500) / 173.7178; // 4.6* ~= 1500 elo (patented algorithm)
  if (approx_mu < 0) approx_mu = 0;
  if (approx_mu > 3000) approx_mu = 3000;

  // 3. Get additionnal map info from osu!api
  // (we can't get the following just from the .osu file: set_id, length, ranked, dmca)
  if (!api_res) {
    console.info(`[API] Fetching map data for map ID ${map_id}`);
    api_res = await osu_fetch(`https://osu.ppy.sh/api/v2/beatmaps/lookup?id=${map_id}`);
  }

  // 4. Cause eyeStrain to the reader
  const rating = db.prepare(
      `INSERT INTO rating (mode, base_mu, current_mu) VALUES (?, ?, ?) RETURNING rowid`,
  ).get(api_res.mode_int + 4, approx_mu, approx_mu);
  db.prepare(`
    INSERT INTO map (
      map_id, name, mode, stars, pp, pp_aim, pp_acc, pp_fl, pp_speed, pp_strain,
      strain_aim, strain_speed, ar, cs, hp, od, bpm, set_id, length, ranked, dmca, rating_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      map_id, api_res.beatmapset.title, api_res.mode_int, info.stars, info.pp, info.ppAim,
      info.ppAcc, info.ppFlashlight, info.ppSpeed, info.ppStrain, info.aimStrain,
      info.speedStrain, info.ar, info.cs, info.hp, info.od, info.bpm,
      api_res.beatmapset.id, api_res.total_length, api_res.beatmapset.ranked,
      api_res.beatmapset.availability.download_disabled ? 1 : 0, rating.rowid,
  );

  return await get_map_info(map_id);
}

export {get_map_info};
