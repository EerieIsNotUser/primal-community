require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

// ─── Config ──────────────────────────────────────────────────────────────────
// MAIN_GUILD_ID = the main Primal Pursuit Discord server. This is the ONLY
// guild this bot ever reacts to. Chickenblox and AnkyTrike are sync TARGETS
// only — we never listen for ban/unban events from them, so there is no path
// for anything to flow back to main or sideways between externals.
const MAIN_GUILD_ID = process.env.MAIN_GUILD_ID;

const CHICKENBLOX_GUILD_ID = process.env.CHICKENBLOX_GUILD_ID || '1477266726642254039';
const ANKYTRIKE_GUILD_ID   = process.env.ANKYTRIKE_GUILD_ID   || '1470057083696189452';

const EXTERNAL_GUILDS = {
  [CHICKENBLOX_GUILD_ID]: {
    name: 'Chickenblox',
    logChannelId: process.env.CHICKENBLOX_LOG_CHANNEL_ID || '1477287745708884149',
  },
  [ANKYTRIKE_GUILD_ID]: {
    name: 'AnkyTrike',
    logChannelId: process.env.ANKYTRIKE_LOG_CHANNEL_ID || '1475918226759090278',
  },
};

const SYNC_REASON = 'Action happened in Primal Pursuit server';

// Combined dev channel — GitHub push notifications + live ban/unban events.
// Backfill does NOT post here (would flood it on first deploy); only live
// events do.
const DEV_LOG_CHANNEL_ID = process.env.DEV_LOG_CHANNEL_ID || '1518162818380202054';

// ─── Supabase ────────────────────────────────────────────────────────────────
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

async function logEvent({ userId, username, action, targetGuildId, targetGuildName, success, errorMessage = null, source }) {
  const { error } = await supabase.from('ban_sync_events').insert({
    user_id: userId,
    username,
    action,
    target_guild_id: targetGuildId,
    target_guild_name: targetGuildName,
    success,
    error_message: errorMessage,
    source,
  });
  if (error) {
    console.error('[bansync] Failed to write event to Supabase:', error.message);
  }
}

// ─── Client ──────────────────────────────────────────────────────────────────
// Minimal intents on purpose. GuildModeration is NOT a privileged intent —
// no Developer Portal application needed, unlike GuildMembers/MessageContent.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildModeration, // required to receive guildBanAdd / guildBanRemove
  ],
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
// Cache-first guild/channel resolution — avoids a REST round-trip on every
// single ban/unban event when the bot is already a member of the guild
// (which it always is here, since it only ever sits in 3 fixed servers).
async function resolveGuild(guildId) {
  return client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
}

async function resolveChannel(guild, channelId) {
  return guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
}

async function isBanned(guild, userId) {
  try {
    await guild.bans.fetch(userId);
    return true;
  } catch {
    return false; // GuildBanManager#fetch rejects when the user isn't banned
  }
}

async function postLog(guild, cfg, embed) {
  try {
    const channel = await resolveChannel(guild, cfg.logChannelId);
    if (channel?.isTextBased()) {
      await channel.send({ embeds: [embed] });
    } else {
      console.warn(`[bansync] Log channel ${cfg.logChannelId} not found or not text-based in ${cfg.name}.`);
    }
  } catch (err) {
    console.error(`[bansync] Failed to post log in ${cfg.name}:`, err.message);
  }
}

// Dev channel uses the global channel manager (not guild-scoped) since it
// can live in any server the bot is a member of, independent of main/
// Chickenblox/AnkyTrike.
async function postDevLog(embed) {
  try {
    const channel = client.channels.cache.get(DEV_LOG_CHANNEL_ID)
      || await client.channels.fetch(DEV_LOG_CHANNEL_ID).catch(() => null);
    if (channel?.isTextBased()) {
      await channel.send({ embeds: [embed] });
    } else {
      console.warn(`[bansync] Dev log channel ${DEV_LOG_CHANNEL_ID} not found or not text-based.`);
    }
  } catch (err) {
    console.error('[bansync] Failed to post dev log:', err.message);
  }
}

const STATUS_LABELS = {
  banned: '✅ Banned',
  unbanned: '✅ Unbanned',
  already_banned: '⏭️ Already banned',
  not_banned: '⏭️ Not banned there',
  not_in_guild: '⚠️ Bot not in server',
  error: '❌ Failed',
};

function buildDevLogEmbed(action, userId, username, results) {
  const fieldValue = results
    .map(r => `**${r.guildName}:** ${STATUS_LABELS[r.status] || r.status}${r.error ? ` — ${r.error}` : ''}`)
    .join('\n') || 'No targets configured';

  return new EmbedBuilder()
    .setColor(action === 'ban' ? 0xE74C3C : 0x2ECC71)
    .setTitle(action === 'ban' ? '🔨 Ban Event — Primal Pursuit Main' : '🔓 Unban Event — Primal Pursuit Main')
    .setDescription(`**${username}** (\`${userId}\`)`)
    .addFields({ name: 'Sync Results', value: fieldValue })
    .setTimestamp();
}

// ─── Sync ────────────────────────────────────────────────────────────────────
// Chickenblox and AnkyTrike are synced in parallel — fully independent of
// each other, no reason to wait on one before starting the other.
async function syncBan(userId, username, { isBackfill = false } = {}) {
  const source = isBackfill ? 'backfill' : 'live';

  return Promise.all(Object.entries(EXTERNAL_GUILDS).map(async ([guildId, cfg]) => {
    try {
      const guild = await resolveGuild(guildId);
      if (!guild) {
        console.error(`[bansync] Bot is not in ${cfg.name} (${guildId}) — skipping.`);
        return { guildName: cfg.name, status: 'not_in_guild' };
      }

      const alreadyBanned = await isBanned(guild, userId);
      if (alreadyBanned) {
        console.log(`[bansync]${isBackfill ? ' [backfill]' : ''} ${username} (${userId}) already banned in ${cfg.name} — skipping.`);
        return { guildName: cfg.name, status: 'already_banned' };
      }

      await guild.bans.create(userId, { reason: SYNC_REASON });
      console.log(`[bansync]${isBackfill ? ' [backfill]' : ''} Banned ${username} (${userId}) in ${cfg.name}.`);

      await Promise.all([
        logEvent({
          userId, username, action: 'ban',
          targetGuildId: guildId, targetGuildName: cfg.name,
          success: true, source,
        }),
        postLog(guild, cfg, new EmbedBuilder()
          .setColor(0xE74C3C)
          .setTitle('🔨 Cross-Server Ban Sync')
          .setDescription(
            `**${username}** (\`${userId}\`) was banned in the Primal Pursuit main server and has been automatically banned from this server.` +
            (isBackfill ? '\n*(applied via startup backfill)*' : '')
          )
          .addFields({ name: 'Reason', value: SYNC_REASON })
          .setTimestamp()
        ),
      ]);

      return { guildName: cfg.name, status: 'banned' };
    } catch (err) {
      console.error(`[bansync] Failed to sync ban for ${userId} in ${cfg.name}:`, err.message);
      await logEvent({
        userId, username, action: 'ban',
        targetGuildId: guildId, targetGuildName: cfg.name,
        success: false, errorMessage: err.message, source,
      });
      return { guildName: cfg.name, status: 'error', error: err.message };
    }
  }));
}

async function syncUnban(userId, username) {
  return Promise.all(Object.entries(EXTERNAL_GUILDS).map(async ([guildId, cfg]) => {
    try {
      const guild = await resolveGuild(guildId);
      if (!guild) {
        console.error(`[bansync] Bot is not in ${cfg.name} (${guildId}) — skipping.`);
        return { guildName: cfg.name, status: 'not_in_guild' };
      }

      const stillBanned = await isBanned(guild, userId);
      if (!stillBanned) {
        console.log(`[bansync] ${username} (${userId}) not banned in ${cfg.name} — skipping unban.`);
        return { guildName: cfg.name, status: 'not_banned' };
      }

      await guild.bans.remove(userId, SYNC_REASON);
      console.log(`[bansync] Unbanned ${username} (${userId}) in ${cfg.name}.`);

      await Promise.all([
        logEvent({
          userId, username, action: 'unban',
          targetGuildId: guildId, targetGuildName: cfg.name,
          success: true, source: 'live',
        }),
        postLog(guild, cfg, new EmbedBuilder()
          .setColor(0x2ECC71)
          .setTitle('🔓 Cross-Server Unban Sync')
          .setDescription(`**${username}** (\`${userId}\`) was unbanned in the Primal Pursuit main server and has been automatically unbanned from this server.`)
          .addFields({ name: 'Reason', value: SYNC_REASON })
          .setTimestamp()
        ),
      ]);

      return { guildName: cfg.name, status: 'unbanned' };
    } catch (err) {
      console.error(`[bansync] Failed to sync unban for ${userId} in ${cfg.name}:`, err.message);
      await logEvent({
        userId, username, action: 'unban',
        targetGuildId: guildId, targetGuildName: cfg.name,
        success: false, errorMessage: err.message, source: 'live',
      });
      return { guildName: cfg.name, status: 'error', error: err.message };
    }
  }));
}

// ─── Startup backfill ────────────────────────────────────────────────────────
// Catches up anything banned in main BEFORE this bot existed. Only ever adds
// missing bans to the externals — never removes anything, so a local ban a
// server placed for its own reasons is never touched.
async function backfill() {
  console.log('[bansync] Running startup backfill...');
  try {
    const mainGuild = await resolveGuild(MAIN_GUILD_ID);
    if (!mainGuild) {
      console.error('[bansync] Bot is not in the main guild — cannot backfill.');
      return;
    }
    const mainBans = await mainGuild.bans.fetch();
    console.log(`[bansync] Main server has ${mainBans.size} ban(s) on record.`);

    for (const ban of mainBans.values()) {
      await syncBan(ban.user.id, ban.user.username, { isBackfill: true });
    }
    console.log('[bansync] Backfill complete.');
  } catch (err) {
    console.error('[bansync] Backfill failed:', err.message);
  }
}

// ─── Live events ─────────────────────────────────────────────────────────────
client.on('guildBanAdd', async (ban) => {
  if (ban.guild.id !== MAIN_GUILD_ID) return; // ignore anything not from main
  const results = await syncBan(ban.user.id, ban.user.username);
  await postDevLog(buildDevLogEmbed('ban', ban.user.id, ban.user.username, results));
});

client.on('guildBanRemove', async (ban) => {
  if (ban.guild.id !== MAIN_GUILD_ID) return; // ignore anything not from main
  const results = await syncUnban(ban.user.id, ban.user.username);
  await postDevLog(buildDevLogEmbed('unban', ban.user.id, ban.user.username, results));
});

client.once('ready', async () => {
  console.log(`[bansync] Logged in as ${client.user.tag}.`);
  if (!MAIN_GUILD_ID) {
    console.error('[bansync] MAIN_GUILD_ID is not set — refusing to run backfill or sync anything.');
    return;
  }
  await backfill();
});

client.login(process.env.DISCORD_TOKEN);