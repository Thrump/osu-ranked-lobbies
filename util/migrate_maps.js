// Script to migrate from Season 1 database format to Season 2.
// Intended to be run once then thrown away.
//
// Instructions for myself:
// 1. Locally, run `node util/migrate_maps.js`
// 2. Locally, run `node util/add_pool.js` for each map pool
// 3. Upload orl.db to the server
// 3.1. On the server, extract the latest .osu map dump
// 4. On the server, shut down the bot
// 5. On the server, run `node util/migrate_users_and_lobbies.js`
// 6. On the server, boot the bot back up

import * as fs from 'fs/promises';
import {constants} from 'fs';
import Database from 'better-sqlite3';
import ProgressBar from 'progress';

import {get_map_info} from '../map_scanner.js';


async function migrate_maps() {
  const old_db = new Database('ranks.db');

  // Ignore DMCA'd maps since those will only cause trouble
  const maps = old_db.prepare(`SELECT id, name, set_id, mode, length, ranked, dmca FROM map WHERE dmca = 0`).all();

  let maps_to_dl = 0;
  for (const map of maps) {
    const file = `maps/${parseInt(map.id, 10)}.osu`;
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
      await get_map_info(map.id, {
        mode_int: map.mode,
        total_length: map.length,
        beatmapset: {
          id: map.set_id,
          ranked: map.ranked,
          title: map.name,
          availability: {
            download_disabled: map.dmca,
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
