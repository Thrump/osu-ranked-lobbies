import fetch from 'node-fetch';
import {promisify} from 'util';

import Config from './util/config.js';


let oauth_token = null;

async function osu_fetch(url, options) {
  options = options || {};

  let res;
  if (!oauth_token) {
    try {
      res = await fetch('https://osu.ppy.sh/oauth/token', {
        method: 'post',
        body: JSON.stringify({
          client_id: Config.osu_v2api_client_id,
          client_secret: Config.osu_v2api_client_secret,
          grant_type: 'client_credentials',
          scope: 'public',
        }),
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
      });
    } catch (err) {
      throw new Error(`Got system error ${err.code} while fetching OAuth token.`);
    }

    const foo = await res.json();
    oauth_token = foo.access_token;
  }

  if (!options.headers) {
    options.headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };
  }

  options.headers['Authorization'] = 'Bearer ' + oauth_token;

  try {
    res = await fetch(url, options);
  } catch (err) {
    throw new Error(`Got system error ${err.code} while fetching '${url}'.`);
  }
  if (res.status == 401) {
    console.log('OAuth token expired, fetching a new one...');
    oauth_token = null;
    await promisify(setTimeout)(1000);
    return await osu_fetch(url, options);
  } else {
    const json = await res.json();
    return json;
  }
}

export {osu_fetch};
