import EventEmitter from 'events';

import bancho from './bancho.js';
import commands from './commands.js';
import db from './database.js';

import Config from './util/config.js';
import {capture_sentry_exception} from './util/helpers.js';
import {get_user_by_id, get_user_by_name} from './user.js';


class BanchoLobby extends EventEmitter {
  constructor(channel) {
    super();

    this.id = parseInt(channel.substring(4), 10);
    this.channel = channel;
    this.invite_id = null;

    // A player is a full_player from the database (safe to assume they have a rank, etc)
    // It has an additional irc_username field, that can differ from their actual username.
    this.players = [];

    this.voteaborts = [];
    this.joined = false;
    this.playing = false;

    let match = db.prepare(`SELECT * FROM match WHERE match_id = ?`).get(this.id);
    if (!match) {
      match = db.prepare(
          `INSERT INTO match (match_id, start_time) VALUES (?, ?) RETURNING *`,
      ).get(this.id, Date.now());
    }

    // Save every lobby.data update to the database
    const lobby_id = this.id;
    this.data = new Proxy(JSON.parse(match.data), {
      set(obj, prop, value) {
        obj[prop] = value;
        db.prepare(`UPDATE match SET data = ? WHERE match_id = ?`).run(JSON.stringify(obj), lobby_id);
        return true;
      },
    });
  }

  handle_line(line) {
    const parts = line.split(' ');

    if (line == `:${Config.osu_username}!cho@ppy.sh PART :${this.channel}`) {
      this.joined = false;
      db.prepare(`UPDATE match SET end_time = ? WHERE match_id = ?`).run(Date.now(), this.id);
      bancho._lobbies.splice(bancho._lobbies.indexOf(this), 1);
      bancho.joined_lobbies.splice(bancho.joined_lobbies.indexOf(this), 1);
      this.emit('close');
      return;
    }

    if (parts[1] == '332' && parts[3] == this.channel) {
      this.joined = true;
      this.invite_id = parseInt(parts[6].substring(1), 10);
      db.prepare(`UPDATE match SET invite_id = ? WHERE match_id = ?`).run(this.invite_id, this.id);
      bancho.emit('lobbyJoined', {
        channel: this.channel,
        lobby: this,
      });
      return;
    }

    if (parts[1] == 'PRIVMSG' && parts[2] == this.channel) {
      const full_source = parts.shift();
      parts.splice(0, 2);
      let source = null;
      if (full_source.indexOf('!') != -1) {
        source = full_source.substring(1, full_source.indexOf('!'));
      }
      const message = parts.join(' ').substring(1);

      if (source == 'BanchoBot') {
        let m;
        const joined_regex = /(.+) joined in slot \d+\./;
        const left_regex = /(.+) left the game\./;
        const room_name_regex = /Room name: (.+), History: https:\/\/osu\.ppy\.sh\/mp\/(\d+)/;
        const room_name_updated_regex = /Room name updated to "(.+)"/;
        const beatmap_regex = /Beatmap: https:\/\/osu\.ppy\.sh\/b\/(\d+) (.+)/;
        const mode_regex = /Team mode: (.+), Win condition: (.+)/;
        const mods_regex = /Active mods: (.+)/;
        const players_regex = /Players: (\d+)/;
        const slot_regex = /Slot (\d+) +(.+?) +https:\/\/osu\.ppy\.sh\/u\/(\d+) (.+)/;
        const ref_add_regex = /Added (.+) to the match referees/;
        const ref_del_regex = /Removed (.+) from the match referees/;
        const beatmap_change_regex = /Changed beatmap to https:\/\/osu\.ppy\.sh\/b\/(\d+) (.+)/;
        const player_changed_beatmap_regex = /Beatmap changed to: (.+) \(https:\/\/osu.ppy.sh\/b\/(\d+)\)/;
        const new_host_regex = /(.+) became the host./;

        if (message == 'Cleared match host') {
          this.host = null;
          this.emit('host');
        } else if (message == 'The match has started!') {
          this.voteaborts = [];
          this.playing = true;
          this.emit('matchStarted');
        } else if (message == 'The match has finished!') {
          this.playing = false;

          // Used for !skip command
          for (const player of this.players) {
            if (!player.matches_finished) {
              player.matches_finished = 0;
            }

            player.matches_finished++;
          }

          this.emit('matchFinished');
        } else if (message == 'Aborted the match') {
          this.playing = false;
          this.emit('matchAborted');
        } else if (message == 'All players are ready') {
          this.emit('allPlayersReady');
        } else if (message == 'Changed the match password') {
          this.passworded = true;
          this.emit('password');
        } else if (message == 'Removed the match password') {
          this.passworded = false;
          this.emit('password');
        } else if (m = room_name_regex.exec(message)) {
          this.name = m[1];
          this.id = parseInt(m[2], 10);
        } else if (m = room_name_updated_regex.exec(message)) {
          this.name = m[1];
          db.prepare(`UPDATE match SET name = ? WHERE match_id = ?`).run(this.name, this.id);
        } else if (m = beatmap_regex.exec(message)) {
          this.map_data = null;
          this.beatmap_id = parseInt(m[1], 10);
          this.beatmap_name = m[2];
        } else if (m = beatmap_change_regex.exec(message)) {
          this.map_data = null;
          this.beatmap_id = parseInt(m[1], 10);
          this.beatmap_name = m[2];
          this.emit('refereeChangedBeatmap');
        } else if (m = player_changed_beatmap_regex.exec(message)) {
          this.map_data = null;
          this.beatmap_id = parseInt(m[2], 10);
          this.beatmap_name = m[1];
          this.emit('playerChangedBeatmap');
        } else if (m = mode_regex.exec(message)) {
          this.team_mode = m[1];
          this.win_condition = m[2];
        } else if (m = mods_regex.exec(message)) {
          this.active_mods = m[1];
        } else if (m = players_regex.exec(message)) {
          this.players = [];
          this.players_to_parse = parseInt(m[1], 10);
        } else if (m = ref_add_regex.exec(message)) {
          this.emit('refereeAdded', m[1]);
        } else if (m = ref_del_regex.exec(message)) {
          if (m[1] == Config.osu_username) {
            this.leave();
          }
          this.emit('refereeRemoved', m[1]);
        } else if (m = slot_regex.exec(message)) {
          // !mp settings - single user result
          get_user_by_id(parseInt(m[3], 10), true).then((player) => {
            player.irc_username = m[4].substring(0, 15).trimEnd();
            player.state = m[2];
            player.is_host = m[4].substring(16).indexOf('Host') != -1;
            if (player.is_host) {
              this.host = player;
            }

            if (!this.players.some((p) = p.user_id == player.user_id)) {
              this.players.push(player);
            }
            this.players_to_parse--;
            if (this.players_to_parse == 0) {
              this.emit('settings');
            }
          }).catch((err) => {
            console.error(`Failed to init user on !mp settings`);
            capture_sentry_exception(err);
            this.players_to_parse--;
            if (this.players_to_parse == 0) {
              this.emit('settings');
            }
          });
        } else if (m = new_host_regex.exec(message)) {
          // host changed
          for (const player of this.players) {
            player.is_host = player.irc_username == m[1];
            this.host = player;
          }
          this.emit('host');
        } else if (m = joined_regex.exec(message)) {
          // player joined
          get_user_by_name(m[1]).then((player) => {
            player.irc_username = m[1];
            if (!this.players.some((p) = p.user_id == player.user_id)) {
              this.players.push(player);
            }
            this.emit('playerJoined', player);
          }).catch((err) => {
            // nothing to do ¯\_(ツ)_/¯
            // will fix itself on the next !mp settings call.
          });
        } else if (m = left_regex.exec(message)) {
          // player left
          const irc_username = m[1];

          let leaving_player = null;
          for (const player of this.players) {
            if (player.irc_username == irc_username) {
              leaving_player = player;
              break;
            }
          }

          if (leaving_player != null) {
            this.players = this.players.filter((player) => player.irc_username != irc_username);
            this.emit('playerLeft', leaving_player);
          }
        }

        return;
      }

      this.emit('message', {
        from: source,
        message: message,
      });

      for (const cmd of commands) {
        const match = cmd.regex.exec(message);
        if (!match) continue;

        if (!cmd.modes.includes(this.data.type)) break;

        if (cmd.creator_only) {
          const user_is_host = this.host && this.host.irc_username == source;
          let user_is_creator = false;
          for (const player of this.players) {
            if (player.irc_username == source) {
              user_is_creator = player.user_id == this.data.creator_id;
              break;
            }
          }

          if (!user_is_host && !user_is_creator) {
            this.send(`${source}: You need to be the lobby creator to use this command.`);
            break;
          }
        }

        cmd.handler({from: source, message: message}, match, this);
        break;
      }

      return;
    }
  }

  leave() {
    if (!this.joined) {
      return;
    }

    bancho._send('PART ' + this.channel);
  }

  async send(message) {
    if (!this.joined) {
      return;
    }

    return await bancho.privmsg(this.channel, message);
  }

  // Override EventEmitter to redirect errors to Sentry
  on(event_name, callback) {
    return super.on(event_name, (...args) => {
      try {
        Promise.resolve(callback(...args));
      } catch (err) {
        Sentry.setContext('lobby', {
          id: this.id,
          median_pp: this.median_overall,
          nb_players: this.players.length,
          data: this.data,
          task: event_name,
        });
        capture_sentry_exception(err);
      }
    });
  }
}

export {BanchoLobby};
