import Database from 'better-sqlite3';


const db = new Database('ranks.db');
db.pragma('foreign_keys = ON');
db.pragma('JOURNAL_MODE = WAL');

if (process.argv[1].endsWith('recompute_ranks.js')) {
  db.pragma('count_changes = OFF');
  db.pragma('TEMP_STORE = MEMORY');
  db.pragma('JOURNAL_MODE = OFF');
  db.pragma('SYNCHRONOUS = OFF');
  db.pragma('LOCKING_MODE = EXCLUSIVE');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS full_map (
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
    strain_arm    REAL,                       -- null for taiko, ctb, mania
    strain_speed  REAL,                       -- null for taiko, ctb, mania
    ar            REAL    NOT NULL,
    cs            REAL    NOT NULL,
    hp            REAL    NOT NULL,
    od            REAL    NOT NULL,
    bpm           REAL    NOT NULL,

    -- info from osu!api or from osu.db scan (https://github.com/kiwec/orl-maps-db-generator)
    set_id        INTEGER NOT NULL,
    length        REAL    NOT NULL,
    ranked        INTEGER NOT NULL,          -- not a boolean but an enum
    dmca          INTEGER NOT NULL,

    -- ...and our own stuff
    season2       INTEGER NOT NULL DEFAULT 0 -- is it part of the S2 map pool?
  );


  CREATE TABLE IF NOT EXISTS full_user (
    user_id         INTEGER PRIMARY KEY,
    username        TEXT    NOT NULL,
    avatar_url      TEXT    NOT NULL,
    auth_token      TEXT    NOT NULL,
    country_code    TEXT,   -- nullable for transition from old database

    -- glicko data
    pp              REAL    NOT NULL DEFAULT 0.0,
    pp_tms          INTEGER NOT NULL,
    mu              REAL    NOT NULL DEFAULT 0.0,
    sig             REAL    NOT NULL DEFAULT (350.0 / 173.7178),
    rank_division   TEXT    NOT NULL DEFAULT 'Unranked',

    -- discord data
    discord_user_id TEXT,
    discord_role    TEXT
  );


  CREATE TABLE IF NOT EXISTS map_pool (
    season        INTEGER NOT NULL,
    collection_id INTEGER NOT NULL,
    user_id       INTEGER NOT NULL,
    added_tms     INTEGER NOT NULL,
    data          TEXT    NOT NULL,

    FOREIGN KEY(user_id) REFERENCES full_user(user_id)
  );


  CREATE TABLE IF NOT EXISTS match (
    match_id   INTEGER PRIMARY KEY,
    invite_id  INTEGER NOT NULL,
    creator_id INTEGER NOT NULL,
    name       TEXT    NOT NULL,
    start_time INTEGER NOT NULL,
    end_time   INTEGER,

    data       TEXT,
    discord_channel_id TEXT,
    discord_message_id TEXT,

    FOREIGN KEY(creator_id) REFERENCES full_user(user_id)
  );


  CREATE TABLE IF NOT EXISTS game (
    game_id      INTEGER PRIMARY KEY,
    match_id     INTEGER NOT NULL, -- "match" means lobby
    start_time   INTEGER NOT NULL,
    end_time     INTEGER NOT NULL,
    beatmap_id   INTEGER NOT NULL,
    play_mode    INTEGER NOT NULL,
    match_type   INTEGER NOT NULL,
    scoring_type INTEGER NOT NULL,
    team_type    INTEGER NOT NULL,
    mods         INTEGER NOT NULL,

    FOREIGN KEY(match_id)   REFERENCES match(match_id),
    FOREIGN KEY(beatmap_id) REFERENCES full_map(map_id)
  );


  CREATE TABLE IF NOT EXISTS full_score (
    game_id      INTEGER NOT NULL,
    user_id      INTEGER NOT NULL,
    slot         INTEGER NOT NULL,
    team         INTEGER NOT NULL,
    score        INTEGER NOT NULL,
    maxcombo     INTEGER NOT NULL,
    count50      INTEGER NOT NULL,
    count100     INTEGER NOT NULL,
    count300     INTEGER NOT NULL,
    countmiss    INTEGER NOT NULL,
    countgeki    INTEGER NOT NULL,
    countkatu    INTEGER NOT NULL,
    perfect      INTEGER NOT NULL,
    pass         INTEGER NOT NULL,
    enabled_mods INTEGER NOT NULL,

    end_time     INTEGER NOT NULL, -- used for sorting by tms on player profiles
    beatmap_id   INTEGER NOT NULL, -- used for website display
    dodged       INTEGER NOT NULL,

    FOREIGN KEY(game_id)    REFERENCES game(game_id),
    FOREIGN KEY(user_id)    REFERENCES full_user(user_id),
    FOREIGN KEY(beatmap_id) REFERENCES full_map(map_id)
  );
  CREATE INDEX IF NOT EXISTS full_game_id_idx    ON full_score(game_id);
  CREATE INDEX IF NOT EXISTS full_score_user_idx ON full_score(user_id);

  -- TODO: discord auth tokens, website auth tokens
`);

export default db;
