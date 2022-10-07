// Intended to run manually. Not for automation.
//
// Remember to first:
// 1) Download all .osu maps from the server, and the latest ranks.db
// 2) Run `node util/migrate_maps.js`
// 3) THEN run `node util/add_pool.js [url1] [url2] [etc]`

import ProgressBar from 'progress';
import fetch from 'node-fetch';

import db from '../database.js';
import {get_map_info} from '../map_scanner.js';


async function add_pool(pool_url) {
  const collection_id = parseInt(pool_url.split('collections/')[1], 10);
  const res = await fetch(`https://osucollector.com/api/collections/${collection_id}`);
  if (res.status == 404) {
    throw new Error('Collection not found.');
  }
  if (!res.ok) {
    throw new Error(await res.text());
  }

  const json = await res.json();
  const map_ids = [];
  for (const set of json.beatmapsets) {
    for (const map of set.beatmaps) {
      map_ids.push(map.id);
    }
  }

  const bar = new ProgressBar(pool_url + ' [:bar] :rate/s | :etas remaining', {
    complete: '=',
    incomplete: ' ',
    width: 20,
    total: map_ids.length,
  });
  db.prepare(`DELETE FROM map_pool WHERE collection_id = ?`).run(collection_id);
  db.prepare(
      `INSERT INTO map_pool (season, collection_id, user_id, added_tms, data) VALUES (2, ?, ?, ?, ?)`,
  ).run(collection_id, json.uploader.id, Date.now(), JSON.stringify(json));

  for (const id of map_ids) {
    try {
      await get_map_info(id);
      db.prepare(`UPDATE map SET season2 = ? WHERE map_id = ?`).run(Date.now(), id);
    } catch (err) {
      console.error(`Failed to add map id ${id} from collection ${collection_id}`);
      console.error(err);
    }
    bar.tick(1);
  }
}

async function run() {
  const argv = process.argv.slice(2);
  for (const arg of argv) {
    await add_pool(arg);
  }
}

run();
