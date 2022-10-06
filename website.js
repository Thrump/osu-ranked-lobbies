import express from 'express';
import fs from 'fs';
import fetch from 'node-fetch';
import morgan from 'morgan';
import Sentry from '@sentry/node';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';

import bancho from './bancho.js';
import db from './database.js';
import {get_user_ranks} from './glicko.js';
import {update_division, update_discord_username} from './discord_updates.js';
import {init_user, get_user_by_id} from './user.js';
import Config from './util/config.js';
import {render_error} from './util/helpers.js';
import {register_routes as register_api_routes} from './website_api.js';


async function listen() {
  const app = express();

  if (Config.ENABLE_SENTRY) {
    app.use(Sentry.Handlers.requestHandler());
  }

  app.use(morgan('combined'));
  app.enable('trust proxy');
  app.set('trust proxy', () => true);
  app.use(express.static('public'));

  app.use(cookieParser());

  // Auth middleware
  app.use(async function(req, res, next) {
    const cookies = req.cookies;

    if (cookies && cookies.token) {
      const info = db.prepare(`SELECT osu_id FROM token WHERE token = ?`).get(cookies.token);
      if (info) {
        req.user_id = info.osu_id;
        res.set('X-Osu-ID', info.osu_id);
        next();
        return;
      }
    }

    res.clearCookie('token');
    next();
  });

  await register_api_routes(app);

  app.get('/', async (req, http_res) => {
    http_res.redirect('/lobbies/');
  });

  // Convenience redirect so we only have to generate the oauth URL here.
  app.get('/osu_login', (req, http_res) => {
    if (!Config.IS_PRODUCTION) {
      http_res.redirect('/auth');
      return;
    }

    http_res.redirect(`https://osu.ppy.sh/oauth/authorize?client_id=${Config.osu_v2api_client_id}&response_type=code&state=login&scope=identify&redirect_uri=${Config.website_base_url}/auth`);
  });

  app.get('/auth', async (req, http_res) => {
    let res;

    // Since OAuth is a pain in localhost, always authenticate outside of production.
    if (!Config.IS_PRODUCTION) {
      const new_auth_token = crypto.randomBytes(20).toString('hex');
      db.prepare(`INSERT INTO token (token, created_at, osu_id) VALUES (?, ?, ?)`).run(new_auth_token, Date.now(), Config.osu_id);
      await get_user_by_id(Config.osu_id, true); // init user if needed
      http_res.cookie('token', new_auth_token, {maxAge: 99999999, sameSite: true});
      http_res.redirect(`/success`);
      return;
    }

    if (!req.query.code) {
      http_res.status(403).send(await render_error(req, 'No auth code provided.', 403));
      return;
    }

    const fetchOauthTokens = async (req) => {
      // Get oauth tokens from osu!api
      try {
        res = await fetch('https://osu.ppy.sh/oauth/token', {
          method: 'post',
          body: JSON.stringify({
            client_id: Config.osu_v2api_client_id,
            client_secret: Config.osu_v2api_client_secret,
            code: req.query.code,
            grant_type: 'authorization_code',
            redirect_uri: Config.website_base_url + '/auth',
          }),
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
        });
      } catch (err) {
        http_res.status(503).send(await render_error(req, 'Internal server error, try again later.', 503));
        console.error(res.status, await res.text());
        return null;
      }
      if (!res.ok) {
        http_res.status(403).send(await render_error(req, 'Invalid auth code.', 403));
        console.error(res.status, await res.text());
        return null;
      }

      // Get osu user id from the received oauth tokens
      return await res.json();
    };

    const fetchUserProfile = async (req, access_token) => {
      try {
        res = await fetch('https://osu.ppy.sh/api/v2/me/osu', {
          method: 'get',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${access_token}`,
          },
        });
      } catch (err) {
        http_res.status(503).send(await render_error(req, 'Internal server error, try again later.', 503));
        console.error(res.status, await res.text());
        return null;
      }
      if (!res.ok) {
        http_res.status(503).send(await render_error(req, 'osu!web sent us bogus tokens. Sorry, idk what to do now', 503));
        return null;
      }

      return await res.json();
    };

    if (req.query.state === 'login') {
      const tokens = await fetchOauthTokens(req);
      if (tokens === null) return;

      const user_profile = await fetchUserProfile(req, tokens.access_token);
      if (user_profile === null) return;

      const user_token = db.prepare(`SELECT token FROM token WHERE osu_id = ?`).get(user_profile.id);
      if (user_token) {
        http_res.cookie('token', user_token.token, {maxAge: 99999999, sameSite: true});
        http_res.redirect(`/success`);
        return;
      }

      const new_auth_token = crypto.randomBytes(20).toString('hex');
      db.prepare(`INSERT INTO token (token, created_at, osu_id) VALUES (?, ?, ?)`).run(new_auth_token, Date.now(), user_profile.id);

      // Initialize the user in the database if needed
      await get_user_by_id(user_profile.id, true);

      http_res.cookie('token', new_auth_token, {maxAge: 99999999, sameSite: true});
      http_res.redirect(`/success`);
      return;
    }

    // Get discord user id from ephemeral token
    const ephemeral_token = req.query.state;
    const discord_user_id = db.prepare(`SELECT discord_id FROM token WHERE token = ?`).get(ephemeral_token);
    if (!discord_user_id) {
      http_res.status(403).send(await render_error(req, 'Invalid Discord token. Please click the "Link account" button once again.', 403));
      return;
    }

    // Check if user didn't already link their account
    res = db.prepare(`SELECT * FROM full_user WHERE discord_user_id = ?`).get(discord_user_id);
    if (res) {
      http_res.redirect('/success');
      return;
    }

    const tokens = await fetchOauthTokens(req);
    if (tokens === null) return;

    const user_profile = await fetchUserProfile(req, tokens.access_token);
    if (user_profile === null) return;

    // Link accounts! Finally.
    db.prepare(`UPDATE full_user SET discord_user_id = ? WHERE user_id = ?`).run(discord_user_id, user_profile.id);
    db.prepare(`DELETE FROM token WHERE token = ?`).run(ephemeral_token);
    http_res.redirect('/success');

    // Now for the fun part: add Discord roles, etc.
    await update_discord_username(user_profile.id, user_profile.username, 'Linked their account');
    await update_division(user_profile.id);
  });

  app.get('/success', async (req, http_res) => {
    const data = {title: 'Account Linked - o!RL'};

    // If the user has just logged in. Redirect them to the page they were on before.
    if (req.cookies.redirect != null) {
      const redirect = req.cookies.redirect;
      http_res.clearCookie('redirect');
      http_res.redirect('/' + redirect + '/');
      http_res.end();
    } else {
      http_res.send(await render_error(req, 'Account linked!', 200, data));
      http_res.end();
    }
  });

  app.get('/search', async (req, http_res) => {
    // TODO: sort by elo like before (but how?)
    const players = db.prepare(`SELECT * FROM full_user WHERE username LIKE ? LIMIT 5`).all(`%${req.query.query}%`);
    http_res.set('Cache-control', 'public, max-age=60');
    http_res.json(players);
  });

  app.get('/get-invite/:banchoId', async (req, http_res) => {
    if (!req.user_id) {
      http_res.send(await render_error(req, 'You need to log in to get an invite!', 403));
      return;
    }

    let inviting_lobby = null;
    for (const lobby of bancho.joined_lobbies) {
      if (lobby.invite_id == req.params.banchoId) {
        inviting_lobby = lobby;
        break;
      }
    }
    if (!inviting_lobby) {
      http_res.send(await render_error(req, 'Could not find the lobby. Maybe it has been closed?', 404));
      return;
    }

    const user = await get_user_by_id(req.user_id, false);
    await bancho.privmsg(user.username, `${user.username}, here's your invite: [http://osump://${inviting_lobby.invite_id}/ ${inviting_lobby.name}]`);
    http_res.send(await render_error(req, 'An invite to the lobby has been sent. Check your in-game messages.', 200));
  });

  // In production, we let expressjs return a blank page of status 404, so
  // that nginx serves the index.html page directly. During development
  // however, it's useful to serve that page since it avoids having to run a
  // proxy on the development machine.
  if (!Config.IS_PRODUCTION) {
    app.get('*', async (req, http_res) => {
      http_res.set('Cache-control', 'public, max-age=14400');
      http_res.send(fs.readFileSync('public/index.html', 'utf-8'));
    });
  }

  // Dirty hack to handle Discord embeds nicely
  app.get('/u/:userId', async (req, http_res) => {
    if (req.get('User-Agent').indexOf('Discordbot') != -1) {
      const user = await get_user_by_id(req.params.userId, false);
      const info = get_user_ranks(user.user_id);
      if (!user || !info) {
        http_res.status(404).send('');
        return;
      }

      // Keep the best rank only
      info.reduce((prev, curr) => prev.ratio > curr.ratio ? prev : curr);

      http_res.send(`<html>
        <head>
          <meta content="${user.username} - o!RL" property="og:title" />
          <meta content="#${info.rank_nb} - ${info.text}" property="og:description" />
          <meta content="https://osu.kiwec.net/u/${user.user_id}" property="og:url" />
          <meta content="https://s.ppy.sh/a/${user.user_id}" property="og:image" />
        </head>
        <body>hi :)</body>
      </html>`);
      return;
    }

    if (Config.IS_PRODUCTION) {
      http_res.status(404).send('');
    } else {
      http_res.set('Cache-control', 'public, max-age=14400');
      http_res.send(fs.readFileSync('public/index.html', 'utf-8'));
    }
  });

  if (Config.ENABLE_SENTRY) {
    app.use(Sentry.Handlers.errorHandler());
  }

  app.listen(3001, () => {
    console.log(`Listening on :${3001}`);
  });
}

export {listen};
