// Script to migrate from Season 1 database format to Season 2.
// Intended to be run once then thrown away.
//
// NOTE: This file has been repurposed to recalculate map elos.
//       See commit aac039e7be74925779b59bb87be3475511f908ba
//       if you just want to import a season 1 database.


import * as fs from 'fs/promises';
import {constants} from 'fs';
import Database from 'better-sqlite3';
import ProgressBar from 'progress';

import {get_map_info} from '../map_scanner.js';


async function migrate_maps() {
  const old_db = new Database('ranks.db');
  const maps = old_db.prepare(`SELECT map_id, name, set_id, mode, length, ranked FROM map`).all();

  let maps_to_dl = 0;
  for (const map of maps) {
    const file = `maps/${parseInt(map.map_id, 10)}.osu`;
    try {
      await fs.access(file, constants.F_OK);
    } catch (err) {
      maps_to_dl++;
    }
  }

  console.info(`INFO: Going to download ${maps_to_dl} maps while importing database.`);
  const bar = new ProgressBar('importing maps [:bar] :rate/s | :etas remaining', {
    complete: '=',
    incomplete: ' ',
    width: 20,
    total: maps.length,
  });
  for (const map of maps) {
    try {
      // Despite what the name says, this actually saves the map in the database (as a side effect)
      await get_map_info(map.map_id, {
        mode_int: map.mode,
        total_length: map.length,
        beatmapset: {
          id: map.set_id,
          ranked: map.ranked,
          title: map.name,
          availability: {
            download_disabled: 0,
          },
        },
      });
      bar.tick(1);
    } catch (err) {
      console.error('\n\nFailed to import map ' + map.id + '\n');
    }
  }

  console.info('Done!');
}


migrate_maps();
