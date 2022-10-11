import db from './database.js';
import {get_user_by_id} from './user.js';
import Config from './util/config.js';
import {capture_sentry_exception} from './util/helpers.js';
import {get_user_ranks} from './glicko.js';


let guild = null;
async function init(discord_client) {
  guild = await discord_client.guilds.fetch(Config.discord_guild_id);
}


async function get_discord_member(user) {
  if (!guild) return null;

  try {
    return await guild.members.fetch(user.discord_user_id);
  } catch (err) {
    console.error(`[Discord] <@${user.discord_user_id}> left the discord server: ${err}`);
    db.prepare(`
      UPDATE user
      SET    discord_user_id = NULL, discord_role = NULL
      WHERE  user_id = ?
    `).run(user.user_id);
    return null;
  }
}


async function update_discord_username(osu_user_id, new_username, reason) {
  if (!guild) return;

  const user = await get_user_by_id(osu_user_id, false);
  if (!user) return;

  const member = await get_discord_member(user);
  if (!member) return;

  try {
    await member.setNickname(new_username, reason);
  } catch (err) {
    console.error(`[Discord] Failed to update nickname for <@${user.discord_user_id}>: ${err}`);
    capture_sentry_exception(err);
  }
}


async function update_division(osu_user_id) {
  // Get best available division for this user, without '++' suffix
  const info = get_user_ranks(osu_user_id);
  if (!info) return;

  let best_ruleset = {nb_scores: 0};
  for (const ruleset of info) {
    if (ruleset.nb_scores > best_ruleset.nb_scores) {
      best_ruleset = ruleset;
    }
  }

  const new_division = best_ruleset.text.split('+')[0];
  const discord_user = db.prepare(
      `SELECT discord_role, discord_user_id FROM user WHERE user_id = ?`,
  ).get(osu_user_id);
  const old_role = discord_user.discord_role;
  if (old_role == new_division) return;
  const member = await get_discord_member(discord_user);
  if (!member) return;

  console.log(`[Discord] Updating role for user ${osu_user_id}: ${old_role} -> ${new_division}`);
  const DISCORD_ROLES = {
    'Cardboard': Config.discord_cardboard_role_id,
    'Wood': Config.discord_wood_role_id,
    'Bronze': Config.discord_bronze_role_id,
    'Silver': Config.discord_silver_role_id,
    'Gold': Config.discord_gold_role_id,
    'Platinum': Config.discord_platinum_role_id,
    'Diamond': Config.discord_diamond_role_id,
    'Rhythm Incarnate': Config.discord_legendary_role_id,
    'The One': Config.discord_the_one_role_id,
  };

  // Add 'Linked account' role
  await member.roles.add(Config.discord_linked_account_role_id);

  // Remove 'The One' role from whoever's no longer The One
  if (new_division == 'The One') {
    const role = await guild.roles.fetch(DISCORD_ROLES[new_division]);
    role.members.each(async (member) => {
      try {
        await member.roles.remove(DISCORD_ROLES['The One']);
        await member.roles.add(DISCORD_ROLES['Rhythm Incarnate']);
      } catch (err) {
        console.error(`Failed to remove the one/add Rhythm Incarnate to ${member}: ${err}`);
        capture_sentry_exception(err);
      }
    });
  }

  try {
    await member.roles.remove(DISCORD_ROLES[old_role]);
    await member.roles.add(DISCORD_ROLES[new_division]);
  } catch (err) {
    console.log(`[Discord] Failed to update rank ${new_division} from discord user ${member.displayName}`);
  }
}


export {
  init,
  update_discord_username,
  update_division,
};
