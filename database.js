import Database from 'better-sqlite3';


const db = new Database('orl.db');
db.pragma('foreign_keys = ON');
db.pragma('JOURNAL_MODE = WAL');


db.exec(`
  -- Old stuff, needed to handle migration smoothly
  CREATE TABLE IF NOT EXISTS old_discord_user (osu_id, discord_id);


  CREATE TABLE IF NOT EXISTS rating (
    rowid          INTEGER PRIMARY KEY,

    mode           INTEGER NOT NULL, -- player: 0 = std, 1 = taiko, 2 = ctb, 3 = mania
                                     -- map:    4 = std, 5 = taiko, 6 = ctb, 7 = mania
                                     -- used for leaderboard indexing
    base_mu        REAL    NOT NULL,
    base_sig       REAL    NOT NULL DEFAULT (350.0 / 173.7178),
    base_score_id  INTEGER NOT NULL DEFAULT 0,
    current_mu     REAL    NOT NULL,
    current_sig    REAL    NOT NULL DEFAULT (350.0 / 173.7178),
    nb_scores      INTEGER NOT NULL DEFAULT 0,
    elo            REAL    NOT NULL DEFAULT 1500
  );

  CREATE INDEX IF NOT EXISTS rating_mode_idx ON rating(mode);
  CREATE INDEX IF NOT EXISTS rating_elo_idx  ON rating(elo);


  CREATE TABLE IF NOT EXISTS map (
    map_id        INTEGER PRIMARY KEY,

    -- info from .osu file
    name          TEXT    NOT NULL,
    mode          INTEGER NOT NULL,           -- (0 = std, 1 = taiko, 2 = ctb, 3 = mania)
    stars         REAL    NOT NULL,
    pp            REAL    NOT NULL,
    pp_aim        REAL,                       -- null for taiko, ctb, mania
    pp_acc        REAL,                       -- null for ctb
    pp_fl         REAL,                       -- null for taiko, ctb, mania
    pp_speed      REAL,                       -- null for taiko, ctb, mania
    pp_strain     REAL,                       -- null for std, ctb
    strain_aim    REAL,                       -- null for taiko, ctb, mania
    strain_speed  REAL,                       -- null for taiko, ctb, mania
    ar            REAL    NOT NULL,
    cs            REAL    NOT NULL,
    hp            REAL    NOT NULL,
    od            REAL    NOT NULL,
    bpm           REAL    NOT NULL,

    -- info from osu!api or from osu.db scan (https://github.com/kiwec/orl-maps-db-generator)
    set_id        INTEGER NOT NULL,
    length        REAL    NOT NULL,
    ranked        INTEGER NOT NULL,           -- not a boolean but an enum
    dmca          INTEGER NOT NULL,

    -- ...and our own stuff
    rating_id     INTEGER NOT NULL,
    season2       INTEGER NOT NULL DEFAULT 0,  -- is it part of the S2 map pool?

    FOREIGN KEY(rating_id) REFERENCES rating(rowid)
  );


  CREATE TABLE IF NOT EXISTS user (
    user_id         INTEGER   PRIMARY KEY,
    username        TEXT      NOT NULL,
    country_code    TEXT      NOT NULL,
    profile_data    TEXT      NOT NULL,

    osu_elo         REAL      NOT NULL,
    osu_rating      INTEGER   NOT NULL,
    osu_division    TEXT      NOT NULL DEFAULT 'Unranked',
    taiko_elo       REAL      NOT NULL,
    taiko_rating    INTEGER   NOT NULL,
    taiko_division  TEXT      NOT NULL DEFAULT 'Unranked',
    catch_elo       REAL      NOT NULL,
    catch_rating    INTEGER   NOT NULL,
    catch_division  TEXT      NOT NULL DEFAULT 'Unranked',
    mania_elo       REAL      NOT NULL,
    mania_rating    INTEGER   NOT NULL,
    mania_division  TEXT      NOT NULL DEFAULT 'Unranked',

    discord_user_id TEXT,
    discord_role    TEXT,

    FOREIGN KEY(osu_rating)   REFERENCES rating(rowid),
    FOREIGN KEY(taiko_rating) REFERENCES rating(rowid),
    FOREIGN KEY(catch_rating) REFERENCES rating(rowid),
    FOREIGN KEY(mania_rating) REFERENCES rating(rowid)
  );


  CREATE TABLE IF NOT EXISTS map_pool (
    season        INTEGER NOT NULL,
    collection_id INTEGER NOT NULL,
    user_id       INTEGER NOT NULL,
    added_tms     INTEGER NOT NULL,
    data          TEXT    NOT NULL
  );


  CREATE TABLE IF NOT EXISTS match (
    match_id   INTEGER PRIMARY KEY,
    invite_id  INTEGER,
    name       TEXT,
    data       TEXT    NOT NULL DEFAULT '{"type":"new"}',
    start_time INTEGER NOT NULL,
    end_time   INTEGER
  );


  CREATE TABLE IF NOT EXISTS game (
    game_id      INTEGER PRIMARY KEY,
    match_id     INTEGER NOT NULL, -- "match" means lobby
    start_time   INTEGER NOT NULL,
    end_time     INTEGER NOT NULL,
    beatmap_id   INTEGER NOT NULL,
    play_mode    INTEGER NOT NULL,
    scoring_type INTEGER NOT NULL,
    team_type    INTEGER NOT NULL,
    mods         INTEGER NOT NULL,

    FOREIGN KEY(match_id)   REFERENCES match(match_id),
    FOREIGN KEY(beatmap_id) REFERENCES map(map_id)
  );


  CREATE TABLE IF NOT EXISTS score (
    game_id      INTEGER NOT NULL,
    user_id      INTEGER NOT NULL,
    mode         INTEGER NOT NULL,
    accuracy     REAL    NOT NULL,
    score        INTEGER NOT NULL,
    max_combo    INTEGER NOT NULL,
    count_50     INTEGER NOT NULL,
    count_100    INTEGER NOT NULL,
    count_300    INTEGER NOT NULL,
    count_miss   INTEGER NOT NULL,
    count_geki   INTEGER NOT NULL,
    count_katu   INTEGER NOT NULL,
    perfect      INTEGER NOT NULL,
    pass         INTEGER NOT NULL,
    enabled_mods INTEGER NOT NULL,

    created_at   INTEGER NOT NULL,
    beatmap_id   INTEGER NOT NULL,
    won          INTEGER NOT NULL,

    FOREIGN KEY(game_id)    REFERENCES game(game_id),
    FOREIGN KEY(user_id)    REFERENCES user(user_id),
    FOREIGN KEY(beatmap_id) REFERENCES map(map_id)
  );
  CREATE INDEX IF NOT EXISTS score_beatmap_idx ON score(beatmap_id);
  CREATE INDEX IF NOT EXISTS score_user_idx    ON score(user_id);


  CREATE TABLE IF NOT EXISTS token (
    token      TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    osu_id     INTEGER,
    discord_id TEXT
  );
`);

export default db;
