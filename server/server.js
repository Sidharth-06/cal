import express from 'express';
import cors from 'cors';
import pkg from '@slack/bolt';
import dotenv from 'dotenv';
import axios from 'axios';
import { db } from './db.js';
import { analyzeFoodImage, addMemoryFact, interpretMessage, agreeToMetaLicense, getModelQuotaStatus, hasModelQuota } from './dietician.js';
import { initScheduler, triggerDailyReportNow, triggerNudgeNow } from './scheduler.js';

const { App, ExpressReceiver } = pkg;

// Load environment variables
dotenv.config();

const PORT = process.env.PORT || 3000;
const expressApp = express();

process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught exception:', err);
});

// ─── GRACEFUL SHUTDOWN ───────────────────────────────────────────────────────
// Flushes any pending in-memory DB writes before the process exits.
// Without this, a nodemon restart during the 500ms debounce window
// would lose the last batch of writes.
let _isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (_isShuttingDown) return;
  _isShuttingDown = true;
  console.log(`[Server] ${signal} — flushing DB and shutting down...`);
  if (boltApp) {
    try { await boltApp.stop(); } catch { /* ignore */ }
  }
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

expressApp.use(cors());
expressApp.use(express.json());

// Initialize Slack Bolt Application
let boltApp;
let expressReceiver;

if (process.env.SLACK_APP_TOKEN) {
  console.log('[Slack] Starting Bolt App in Socket Mode...');
  boltApp = new App({
    token: process.env.SLACK_BOT_TOKEN,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN
  });
} else if (process.env.SLACK_SIGNING_SECRET && process.env.SLACK_BOT_TOKEN) {
  console.log('[Slack] Starting Bolt App in Webhook Mode...');
  expressReceiver = new ExpressReceiver({
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    endpoints: '/slack/events'
  });
  boltApp = new App({
    token: process.env.SLACK_BOT_TOKEN,
    receiver: expressReceiver
  });
  // Mount Slack webhook route on Express
  expressApp.use(expressReceiver.router);
} else {
  console.warn('[Slack] Slack Bot credentials not fully configured in environment. Bot functionality disabled.');
}

function makeBar(percent, width = 10) {
  const safePercent = Math.max(0, Math.min(100, Number(percent || 0)));
  const filledCount = Math.round((safePercent / 100) * width);
  return '▓'.repeat(filledCount) + '░'.repeat(width - filledCount);
}

async function modelQuotaLine(userId) {
  const quota = await getModelQuotaStatus(userId);
  return `🤖 *Model quota:* ${quota.used}/${quota.limit} calls today  \`${makeBar(quota.percent)}\` ${quota.percent}% used`;
}

async function progressBlocks(userId, title, percent, statusText) {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${title}\n\`${makeBar(percent)}\` ${percent}% — ${statusText}`
      }
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: await modelQuotaLine(userId) }]
    }
  ];
}

async function quotaLimitText(userId) {
  const quota = await getModelQuotaStatus(userId);
  const quotaLine = await modelQuotaLine(userId);
  return `⚠️ *Daily model limit reached.*\n\n${quotaLine}\nYou have ${quota.remaining} calls remaining today. Try again after the daily reset, or increase \`MODEL_DAILY_CALL_LIMIT\` in your server environment.`;
}

function isModelQuotaError(err) {
  return err?.code === 'MODEL_QUOTA_EXCEEDED';
}

function shouldHandleSlackMessage(message) {
  if (!message?.user || !message?.channel || !message?.ts) return false;
  if (message.bot_id || message.subtype === 'bot_message') return false;
  if (message.subtype && message.subtype !== 'file_share') return false;
  return true;
}

function parseWaterAmount(arg) {
  if (!arg) return 0;
  const mlMatch = arg.match(/(\d+)\s*ml/i);
  if (mlMatch) return parseInt(mlMatch[1]);
  const lMatch = arg.match(/(\d+(?:\.\d+)?)\s*l/i);
  if (lMatch) return Math.round(parseFloat(lMatch[1]) * 1000);
  const numMatch = arg.match(/^(\d+)$/);
  if (numMatch) return parseInt(numMatch[1]);
  return 0;
}

function parseTimeArg(arg) {
  if (!arg) return null;
  const timeMatch = arg.match(/(\d{1,2}):(\d{2})(?:\s*(am|pm)?)/i);
  if (!timeMatch) return null;
  let hours = parseInt(timeMatch[1]);
  const minutes = timeMatch[2];
  const suffix = timeMatch[3]?.toLowerCase();
  if (suffix === 'pm' && hours < 12) hours += 12;
  if (suffix === 'am' && hours === 12) hours = 0;
  if (!suffix && hours < 7 && hours > 0) hours += 12;
  if (hours < 0 || hours > 23 || parseInt(minutes) > 59) return null;
  return `${String(hours).padStart(2, '0')}:${minutes}`;
}

const DEFAULT_PROFILE = {
  dailyGoal: 2000,
  macroTargets: { protein: 150, carbs: 250, fats: 70 },
  weight: null,
  weightHistory: [],
  dieticianMemory: {
    preferences: [],
    allergies: [],
    habits: [],
    milestones: [],
    rawMemoryLog: [],
  },
  modelUsage: {},
  waterGoalMl: 2000,
  waterIntakeMl: 0,
  reminderTimes: { morning: '08:30', afternoon: '15:30', evening: '19:00', report: '21:30' },
  lastNudgeAt: null,
  lastReportAt: null,
};

async function postProgressMessage(client, channelId, userId, title, statusText = 'Starting...') {
  return client.chat.postMessage({
    channel: channelId,
    text: `${title} ${statusText}`,
    blocks: await progressBlocks(userId, title, 0, statusText)
  });
}

async function updateProgressMessage(client, channelId, progressMsg, userId, title, percent, statusText) {
  if (!progressMsg?.ts) return;
  try {
    await client.chat.update({
      channel: channelId,
      ts: progressMsg.ts,
      text: `${title} ${percent}%`,
      blocks: await progressBlocks(userId, title, percent, statusText)
    });
  } catch (updateErr) {
    console.error("Failed to update progress message:", updateErr);
  }
}

async function publishFinalMessage(client, channelId, progressMsg, say, payload) {
  if (progressMsg?.ts) {
    await client.chat.update({
      channel: channelId,
      ts: progressMsg.ts,
      ...payload
    });
  } else {
    await say(payload);
  }
}

// -------------------------------------------------------------
// REST API Endpoints for React PWA Sync
// -------------------------------------------------------------

// Get all logs for a Slack User ID
expressApp.get('/api/logs/:slackUserId', async (req, res) => {
  try {
    const { slackUserId } = req.params;
    const logs = await db.getUserLogs(slackUserId);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a log item from React PWA
expressApp.post('/api/logs', async (req, res) => {
  try {
    const { slackUserId, name, calories, protein, carbs, fats, category, ingredients } = req.body;
    if (!slackUserId || !name || calories === undefined) {
      return res.status(400).json({ error: 'Missing required log fields' });
    }
    const newLog = await db.addLog(slackUserId, {
      name,
      calories: Number(calories),
      protein: Number(protein || 0),
      carbs: Number(carbs || 0),
      fats: Number(fats || 0),
      category: category || 'Snack',
      ingredients: ingredients || []
    });
    res.json(newLog);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a log item
expressApp.delete('/api/logs/:slackUserId/:id', async (req, res) => {
  try {
    const { slackUserId, id } = req.params;
    const deleted = await db.deleteLog(slackUserId, id);
    if (deleted) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Log not found' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get profile & memory details
expressApp.get('/api/profile/:slackUserId', async (req, res) => {
  try {
    const { slackUserId } = req.params;
    const profile = await db.getUserProfile(slackUserId);
    res.json(profile);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update profile details
expressApp.post('/api/profile', async (req, res) => {
  try {
    const { slackUserId, dailyGoal, macroTargets, weight, weightHistory, dieticianMemory } = req.body;
    if (!slackUserId) {
      return res.status(400).json({ error: 'Missing slackUserId' });
    }
    const updated = await db.updateUserProfile(slackUserId, {
      dailyGoal: dailyGoal !== undefined ? Number(dailyGoal) : undefined,
      macroTargets,
      weight: weight !== undefined ? Number(weight) : undefined,
      weightHistory,
      dieticianMemory
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Water tracking endpoints
expressApp.post('/api/water/:slackUserId', async (req, res) => {
  try {
    const { slackUserId } = req.params;
    const { amount } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid water amount' });
    }
    const updated = await db.addWaterIntake(slackUserId, amount);
    res.json({
      success: true,
      waterIntakeMl: updated.waterIntakeMl,
      waterGoalMl: updated.waterGoalMl,
      remainingMl: updated.waterGoalMl - updated.waterIntakeMl,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

expressApp.post('/api/water/:slackUserId/reset', async (req, res) => {
  try {
    const { slackUserId } = req.params;
    const updated = await db.resetWaterIntake(slackUserId);
    res.json({
      success: true,
      waterIntakeMl: updated.waterIntakeMl,
      waterGoalMl: updated.waterGoalMl,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reminder customization endpoints
expressApp.post('/api/reminders/:slackUserId', async (req, res) => {
  try {
    const { slackUserId } = req.params;
    const { reminderTimes } = req.body;
    if (!reminderTimes) {
      return res.status(400).json({ error: 'Missing reminderTimes' });
    }
    const updated = await db.updateReminderTimes(slackUserId, reminderTimes);
    res.json({ success: true, reminderTimes: updated.reminderTimes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger a test daily report (manual REST call)
expressApp.post('/api/test-report/:slackUserId', async (req, res) => {
  try {
    const { slackUserId } = req.params;
    if (!boltApp) return res.status(503).json({ error: 'Slack App is not running.' });
    await triggerDailyReportNow(boltApp, slackUserId);
    res.json({ success: true, message: 'Report sent to Slack.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger a test nudge (manual REST call)
expressApp.post('/api/test-nudge/:slackUserId', async (req, res) => {
  try {
    const { slackUserId } = req.params;
    const { time } = req.body; // 'morning' | 'afternoon' | 'evening'
    if (!boltApp) return res.status(503).json({ error: 'Slack App is not running.' });
    const sent = await triggerNudgeNow(boltApp, slackUserId, time || 'morning');
    res.json({ success: sent, message: sent ? 'Nudge sent to Slack.' : 'Nudge not generated.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check endpoint
expressApp.get('/health', (req, res) => {
  res.json({ status: 'ok', slackConnected: !!boltApp });
});

// -------------------------------------------------------------
// Slack Event Handlers (Bolt)
// -------------------------------------------------------------
if (boltApp) {
  // Listen for direct messages or mentions
  boltApp.message(async ({ message, say, client }) => {
    // Skip bot/system messages and Slack echoes from our own progress updates.
    if (!shouldHandleSlackMessage(message)) return;

    const userId = message.user;
    const channelId = message.channel;
    const rawText = message.text || "";

    console.log(`[Slack] Received message from user ${userId} in channel ${channelId}`);

    // Case 1: Image attachment (Food Photo log)
    if (message.files && message.files.length > 0) {
      const imageFile = message.files.find(file => file.mimetype.startsWith('image/'));
      if (imageFile) {
        if (!hasModelQuota(userId)) {
          await client.chat.postMessage({
            channel: channelId,
            text: "Daily model limit reached",
            blocks: [{ type: 'section', text: { type: 'mrkdwn', text: await quotaLimitText(userId) } }]
          });
          return;
        }

        // Add a reaction to show we are processing
        try {
          await client.reactions.add({
            channel: channelId,
            timestamp: message.ts,
            name: 'eyes'
          });
        } catch { /* ignore */ }

        let loadingMsg = null;
        try {
          loadingMsg = await postProgressMessage(client, channelId, userId, "🥗 *Let me look at your meal!*", "Initiating analysis...");
        } catch (postErr) {
          console.error("Failed to post initial progress message:", postErr);
        }

        const updateProgress = async (percent, statusText) => {
          await updateProgressMessage(client, channelId, loadingMsg, userId, "🥗 *Let me look at your meal!*", percent, statusText);
        };

        try {
          // 1. Download image from Slack (needs token authorization)
          await updateProgress(15, "Downloading image from Slack...");
          const imgResponse = await axios.get(imageFile.url_private, {
            headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
            responseType: 'arraybuffer'
          });
          const buffer = Buffer.from(imgResponse.data, 'binary');
          const base64Image = buffer.toString('base64');
          const mimetype = imageFile.mimetype;

          // 2. Call dietician vision parser
          const userNotes = message.text || "";
          const result = await analyzeFoodImage(
            userId, 
            base64Image, 
            mimetype, 
            userNotes,
            async ({ percent, status }) => updateProgress(percent, status)
          );

          await updateProgress(95, "Saving meal log and finalizing details...");

          // 3. Save full entry to DB
          await db.addLog(userId, {
            name: result.foodName,
            cuisineType: result.cuisineType,
            category: result.category,
            servingSize: result.servingSize,
            calories: result.calories,
            protein: result.protein,
            carbs: result.carbs,
            fats: result.fats,
            fiber: result.fiber,
            sugar: result.sugar,
            saturatedFat: result.saturatedFat,
            unsaturatedFat: result.unsaturatedFat,
            sodium: result.sodium,
            potassium: result.potassium,
            calcium: result.calcium,
            iron: result.iron,
            vitaminC: result.vitaminC,
            cholesterol: result.cholesterol,
            glycemicIndex: result.glycemicIndex,
            healthScore: result.healthScore,
            allergens: result.allergens || [],
            tags: result.tags || [],
            ingredients: result.ingredients || [],
            imageUrl: imageFile.url_private
          });

          // 4. Calculate today's totals
          const todayStart = new Date();
          todayStart.setHours(0, 0, 0, 0);
          const allTodayLogs = (await db.getUserLogs(userId)).filter(log => new Date(log.timestamp) >= todayStart);
          const totalCalories = allTodayLogs.reduce((sum, f) => sum + f.calories, 0);
          const totalProtein  = allTodayLogs.reduce((sum, f) => sum + (f.protein || 0), 0);
          const totalCarbs    = allTodayLogs.reduce((sum, f) => sum + (f.carbs || 0), 0);
          const totalFats     = allTodayLogs.reduce((sum, f) => sum + (f.fats || 0), 0);

          const profile = await db.getUserProfile(userId);
          const remaining = profile.dailyGoal - totalCalories;
          const pct = Math.min(100, Math.round((totalCalories / profile.dailyGoal) * 100));

          // Remove 👀 and add ✅
          try {
            await client.reactions.remove({ channel: channelId, timestamp: message.ts, name: 'eyes' });
            await client.reactions.add({ channel: channelId, timestamp: message.ts, name: 'white_check_mark' });
          } catch { /* ignore */ }

          // Health score bar
          const scoreEmoji = result.healthScore >= 8 ? '🟢' : result.healthScore >= 5 ? '🟡' : '🔴';
          const scoreDots = '█'.repeat(result.healthScore || 0) + '░'.repeat(10 - (result.healthScore || 0));

          // Ingredient list with quantities
          const ingredientLines = (result.ingredients || [])
            .map(i => typeof i === 'object' ? `• ${i.name} _(${i.quantity})_` : `• ${i}`)
            .join('\n');

          // Allergen & tag line
          const allergenText = result.allergens && result.allergens.length > 0
            ? `⚠️ *Allergens:* ${result.allergens.join(', ')}`
            : '✅ *Allergens:* None detected';

          const tagsText = result.tags && result.tags.length > 0
            ? result.tags.map(t => `\`${t}\``).join(' ')
            : '';

          // GI label
          const giLabel = { low: '🟢 Low', medium: '🟡 Medium', high: '🔴 High' }[result.glycemicIndex] || result.glycemicIndex || 'N/A';

          // Progress bar for daily goal
          const progressBar = makeBar(pct);

          // 5. Update progress message with final rich multi-section Slack card
          const cardPayload = {
            channel: channelId,
            text: `Logged: ${result.foodName} — ${result.calories} kcal`,
            blocks: [
              // Header
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `🍽️ *${result.foodName}*   ${tagsText}\n${result.cuisineType || ''} • ${result.category} • ${result.servingSize || ''}`
                }
              },
              { type: 'divider' },
              // Macros
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `*📊 Macronutrients*\n🔥 *Calories:* ${result.calories} kcal\n🥩 *Protein:* ${result.protein}g\n🍞 *Carbs:* ${result.carbs}g  _(Sugar: ${result.sugar}g)_\n🧈 *Fats:* ${result.fats}g  _(Sat: ${result.saturatedFat}g | Unsat: ${result.unsaturatedFat}g)_\n🌾 *Fiber:* ${result.fiber}g\n🩸 *Cholesterol:* ${result.cholesterol}mg\n📈 *Glycemic Index:* ${giLabel}`
                }
              },
              { type: 'divider' },
              // Micronutrients
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `*🔬 Micronutrients*\n🧂 Sodium: ${result.sodium}mg  |  🍌 Potassium: ${result.potassium}mg\n🦴 Calcium: ${result.calcium}mg  |  🩸 Iron: ${result.iron}mg\n🍊 Vit C: ${result.vitaminC}mg  |  ☀️ Vit D: ${result.vitaminD}µg  |  🔴 Vit B12: ${result.vitaminB12}µg`
                }
              },
              { type: 'divider' },
              // Ingredients
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `*🥗 Ingredients*\n${ingredientLines || 'N/A'}`
                }
              },
              { type: 'divider' },
              // Health score + allergens
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `${scoreEmoji} *Health Score:* ${result.healthScore}/10   \`${scoreDots}\`\n${allergenText}`
                }
              },
              // Insight
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `💡 *Dietician Insight*\n_${result.insight}_`
                }
              },
              { type: 'divider' },
              // Daily progress footer
              {
                type: 'context',
                elements: [{
                  type: 'mrkdwn',
                  text: `📅 *Today's Progress* — ${totalCalories} / ${profile.dailyGoal} kcal  \`${progressBar}\` ${pct}%\nProtein: ${totalProtein}g | Carbs: ${totalCarbs}g | Fats: ${totalFats}g  •  ${remaining > 0 ? `${remaining} kcal remaining` : `🚨 ${Math.abs(remaining)} kcal over goal`}\n${await modelQuotaLine(userId)}`
                }]
              }
            ]
          };

          if (loadingMsg && loadingMsg.ts) {
            await client.chat.update({
              ts: loadingMsg.ts,
              ...cardPayload
            });
          } else {
            await client.chat.postMessage(cardPayload);
          }

        } catch (err) {
          console.error('[Slack] Vision log error:', err);
          const errorText = isModelQuotaError(err)
            ? await quotaLimitText(userId)
            : "⚠️ *Oops, I hit a snag trying to analyze that meal picture.* Please make sure the photo is clear or try again!";
          if (loadingMsg && loadingMsg.ts) {
            try {
              await client.chat.update({
                channel: channelId,
                ts: loadingMsg.ts,
                text: isModelQuotaError(err) ? "Daily model limit reached" : "Meal analysis failed",
                blocks: [
                  {
                    type: "section",
                    text: {
                      type: "mrkdwn",
                      text: errorText
                    }
                  }
                ]
              });
            } catch {
              await say(errorText);
            }
          } else {
            await say(errorText);
          }
          try {
            await client.reactions.remove({ channel: channelId, timestamp: message.ts, name: 'eyes' });
            await client.reactions.add({ channel: channelId, timestamp: message.ts, name: 'warning' });
          } catch { /* ignore */ }
        }
      }
      return;
    }

    // ─── WATER TRACKING COMMANDS ───────────────────────────────────────
    const waterMatch = rawText.match(/^\/water\s*(.*)$/i);
    if (waterMatch) {
      const arg = waterMatch[1].trim().toLowerCase();
      if (!arg || arg === 'status' || arg === 'today') {
        const profile = await db.getUserProfile(userId);
        const intake = profile.waterIntakeMl || 0;
        const goal = profile.waterGoalMl || 2000;
        const remaining = Math.max(0, goal - intake);
        const pct = Math.min(100, Math.round((intake / goal) * 100));
        const bar = makeBar(pct);
        const glasses = Math.round(intake / 250);
        const goalGlasses = Math.round(goal / 250);
        await client.chat.postMessage({
          channel: channelId,
          text: `Water status: ${intake}ml / ${goal}ml`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `💧 *Water Intake*\n\`${bar}\` ${pct}%\n${glasses} / ${goalGlasses} glasses (250ml each)\n${remaining > 0 ? `${remaining}ml remaining` : `🎉 Goal reached!`}`
              }
            },
            {
              type: 'context',
              elements: [{ type: 'mrkdwn', text: `Use /water 500 to log 500ml, /water reset to clear today's intake, or /water goal 3000 to set a new goal.` }]
            }
          ]
        });
      } else if (arg === 'reset') {
        await db.resetWaterIntake(userId);
        await client.chat.postMessage({
          channel: channelId,
          text: 'Water intake reset for today.',
        });
      } else if (arg.startsWith('goal')) {
        const goalArg = arg.replace(/^goal\s*/, '').trim();
        const goalMl = goalArg ? parseInt(goalArg) : 2000;
        if (!goalMl || goalMl < 500) {
          await client.chat.postMessage({
            channel: channelId,
            text: '⚠️ Water goal must be at least 500ml. Usage: /water goal 2000',
          });
        } else {
          await db.updateUserProfile(userId, { waterGoalMl: goalMl });
          await client.chat.postMessage({
            channel: channelId,
            text: `✅ Water goal set to ${goalMl}ml (${Math.round(goalMl / 250)} glasses).`,
          });
        }
      } else {
        const parsed = parseWaterAmount(arg);
        if (parsed <= 0) {
          await client.chat.postMessage({
            channel: channelId,
            text: '⚠️ Could not parse water amount. Try: /water 500, /water 2L, /water 1.5L, /water 300ml',
          });
        } else {
          const updated = await db.addWaterIntake(userId, parsed);
          const intake = updated.waterIntakeMl || 0;
          const goal = updated.waterGoalMl || 2000;
          const remaining = Math.max(0, goal - intake);
          const pct = Math.min(100, Math.round((intake / goal) * 100));
          const bar = makeBar(pct);
          const glasses = Math.round(intake / 250);
          const goalGlasses = Math.round(goal / 250);
          await client.chat.postMessage({
            channel: channelId,
            text: `Logged ${parsed}ml water`,
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `💧 *Water Logged*\n\`${bar}\` ${pct}%\n${glasses} / ${goalGlasses} glasses\n${remaining > 0 ? `${remaining}ml remaining` : `🎉 Goal reached!`}`
                }
              }
            ]
          });
        }
      }
      return;
    }

    // ─── REMINDER CUSTOMIZATION COMMANDS ───────────────────────────────
    const remindMatch = rawText.match(/^\/remind\s*(.*)$/i);
    if (remindMatch) {
      const arg = remindMatch[1].trim().toLowerCase();
      if (!arg || arg === 'status' || arg === 'list' || arg === 'show') {
        const profile = await db.getUserProfile(userId);
        const times = profile.reminderTimes || DEFAULT_PROFILE.reminderTimes;
        await client.chat.postMessage({
          channel: channelId,
          text: 'Your current reminders:',
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `⏰ *Your Reminders*\n🌅 Morning: ${times.morning || '08:30'}\n🌞 Afternoon: ${times.afternoon || '15:30'}\n🌆 Evening: ${times.evening || '19:00'}\n📊 Daily Report: ${times.report || '21:30'}`
              }
            },
            {
              type: 'context',
              elements: [{ type: 'mrkdwn', text: 'Set custom times: /remind morning 9:00, /remind afternoon 14:00, /remind evening 20:00, /remind report 22:00' }]
            }
          ]
        });
      } else if (arg === 'off' || arg === 'disable' || arg === 'pause') {
        const newTimes = {
          morning: null,
          afternoon: null,
          evening: null,
          report: null,
        };
        await db.updateReminderTimes(userId, newTimes);
        await client.chat.postMessage({
          channel: channelId,
          text: '🔕 All reminders paused. Use /remind morning 9:00 to re-enable specific reminders.',
        });
      } else if (arg.startsWith('morning')) {
        const time = parseTimeArg(arg);
        if (!time) {
          await client.chat.postMessage({ channel: channelId, text: '⚠️ Invalid time. Usage: /remind morning 9:00 or /remind morning 9:00am' });
        } else {
          await db.updateReminderTimes(userId, { morning: time });
          await client.chat.postMessage({ channel: channelId, text: `✅ Morning nudge set to ${time}.` });
        }
      } else if (arg.startsWith('afternoon')) {
        const time = parseTimeArg(arg);
        if (!time) {
          await client.chat.postMessage({ channel: channelId, text: '⚠️ Invalid time. Usage: /remind afternoon 15:00 or /remind afternoon 3pm' });
        } else {
          await db.updateReminderTimes(userId, { afternoon: time });
          await client.chat.postMessage({ channel: channelId, text: `✅ Afternoon nudge set to ${time}.` });
        }
      } else if (arg.startsWith('evening')) {
        const time = parseTimeArg(arg);
        if (!time) {
          await client.chat.postMessage({ channel: channelId, text: '⚠️ Invalid time. Usage: /remind evening 19:00 or /remind evening 7pm' });
        } else {
          await db.updateReminderTimes(userId, { evening: time });
          await client.chat.postMessage({ channel: channelId, text: `✅ Evening nudge set to ${time}.` });
        }
      } else if (arg.startsWith('report')) {
        const time = parseTimeArg(arg);
        if (!time) {
          await client.chat.postMessage({ channel: channelId, text: '⚠️ Invalid time. Usage: /remind report 21:30 or /remind report 9:30pm' });
        } else {
          await db.updateReminderTimes(userId, { report: time });
          await client.chat.postMessage({ channel: channelId, text: `✅ Daily report set to ${time}.` });
        }
      } else {
        await client.chat.postMessage({
          channel: channelId,
          text: 'Usage: /remind [morning|afternoon|evening|report] [HH:MM] | /remind off | /remind status',
        });
      }
      return;
    }

    // ─── FOOD LOGGING HELPERS ──────────────────────────────────────────
    if (!rawText.trim()) return; // ignore empty messages

    if (/\b(model\s*)?(quota|usage|limit|budget)\b/i.test(rawText)) {
      const quota = await getModelQuotaStatus(userId);
      await client.chat.postMessage({
        channel: channelId,
        text: `Model quota: ${quota.used}/${quota.limit} calls used today`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `${await modelQuotaLine(userId)}\n${quota.remaining} calls remaining. Estimated tokens today: ${quota.estimatedTokens}.`
            }
          }
        ]
      });
      return;
    }

    if (!(await hasModelQuota(userId))) {
      await client.chat.postMessage({
        channel: channelId,
        text: "Daily model limit reached",
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: await quotaLimitText(userId) } }]
      });
      return;
    }

    // Show "thinking" reaction while processing
    try {
      await client.reactions.add({ channel: channelId, timestamp: message.ts, name: 'thinking_face' });
    } catch { /* ignore */ }

    let textProgressMsg = null;
    try {
      textProgressMsg = await postProgressMessage(client, channelId, userId, "💬 *Working on your message...*", "Received your input...");
    } catch (postErr) {
      console.error("Failed to post text progress message:", postErr);
    }

    try {
      await updateProgressMessage(client, channelId, textProgressMsg, userId, "💬 *Working on your message...*", 25, "Classifying intent and nutrition context...");
      const intent = await interpretMessage(userId, rawText);
      console.log(`[Intent] Detected intent: ${intent.intent} (${intent.confidence}) for message: "${rawText}"`);
      await updateProgressMessage(client, channelId, textProgressMsg, userId, "💬 *Working on your message...*", 55, "Preparing your response...");

      // Remove thinking reaction
      try {
        await client.reactions.remove({ channel: channelId, timestamp: message.ts, name: 'thinking_face' });
      } catch { /* ignore */ }

      // -------------------------------------------------------
      // INTENT: User described food they ate in text
      // -------------------------------------------------------
      if (intent.intent === 'LOG_FOOD_TEXT' && (intent.foodLogs?.length || intent.foodLog)) {
        await updateProgressMessage(client, channelId, textProgressMsg, userId, "💬 *Working on your message...*", 75, "Logging food and updating totals...");
        const foodLogs = intent.foodLogs?.length ? intent.foodLogs : [intent.foodLog];
        const savedLogs = [];
        for (const f of foodLogs) {
          if (f?.foodName) {
            const log = await db.addLog(userId, {
              name: f.foodName,
              calories: Number(f.calories || 0),
              protein: Number(f.protein || 0),
              carbs: Number(f.carbs || 0),
              fats: Number(f.fats || 0),
              category: f.category || 'Snack',
              ingredients: f.ingredients || [],
              source: 'text'
            });
            savedLogs.push(log);
          }
        }

        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const allTodayLogs = (await db.getUserLogs(userId)).filter(log => new Date(log.timestamp) >= todayStart);
        const totalCalories = allTodayLogs.reduce((sum, l) => sum + l.calories, 0);
        const profile = await db.getUserProfile(userId);
        const remaining = profile.dailyGoal - totalCalories;

        try {
          await client.reactions.add({ channel: channelId, timestamp: message.ts, name: 'white_check_mark' });
        } catch { /* ignore */ }

        const loggedLines = savedLogs
          .map(f => `• *${f.name}* — ${f.category || 'Snack'} — ${f.calories} kcal | P: ${f.protein || 0}g, C: ${f.carbs || 0}g, F: ${f.fats || 0}g`)
          .join('\n');

        const insightLines = foodLogs
          .map(f => f?.insight)
          .filter(Boolean)
          .map(text => `_${text}_`)
          .join('\n');

        await publishFinalMessage(client, channelId, textProgressMsg, say, {
          channel: channelId,
          text: `Logged ${savedLogs.length} food item${savedLogs.length === 1 ? '' : 's'}`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `✍️ *Logged from your description*\n${loggedLines || 'No food items were detected.'}`
              }
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `💡 ${insightLines || '_Timeline updated based on your message._'}`
              }
            },
            {
              type: 'context',
              elements: [{
                type: 'mrkdwn',
                 text: `📊 *Today so far:* ${totalCalories} / ${profile.dailyGoal} kcal  •  ${remaining > 0 ? `${remaining} kcal remaining` : `${Math.abs(remaining)} kcal over goal 🚨`}\n${await modelQuotaLine(userId)}`
              }]
            }
          ]
        });
        return;
      }

      // -------------------------------------------------------
      // INTENT: User wants a report / check-in
      // -------------------------------------------------------
      if (intent.intent === 'REQUEST_REPORT') {
        try {
          await updateProgressMessage(client, channelId, textProgressMsg, userId, "💬 *Working on your message...*", 75, "Generating your daily report...");
          await triggerDailyReportNow(boltApp, userId);
          await updateProgressMessage(client, channelId, textProgressMsg, userId, "💬 *Working on your message...*", 100, "Report sent.");
        } catch (err) {
          console.error("Failed to generate daily report:", err);
          await publishFinalMessage(client, channelId, textProgressMsg, say, {
            text: "⚠️ Couldn't generate your report. Log some meals first!",
            blocks: [{ type: 'section', text: { type: 'mrkdwn', text: "⚠️ Couldn't generate your report. Log some meals first!" } }]
          });
        }
        return;
      }

      // -------------------------------------------------------
      // INTENT: User wants a food suggestion
      // -------------------------------------------------------
      if (intent.intent === 'ASK_SUGGESTION' && intent.suggestion) {
        try {
          await client.reactions.add({ channel: channelId, timestamp: message.ts, name: 'salad' });
        } catch { /* ignore */ }
        await publishFinalMessage(client, channelId, textProgressMsg, say, {
          text: "Here's my suggestion for you",
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `🥗 *Here's my suggestion for you:*\n\n${intent.suggestion}` }
            },
            {
              type: 'context',
              elements: [{ type: 'mrkdwn', text: await modelQuotaLine(userId) }]
            }
          ]
        });
        return;
      }

      // -------------------------------------------------------
      // INTENT: User shared a personal preference / allergy / goal
      // -------------------------------------------------------
      if (intent.intent === 'SAVE_MEMORY' && intent.memoryFact) {
        await updateProgressMessage(client, channelId, textProgressMsg, userId, "💬 *Working on your message...*", 75, "Saving this to your dietician memory...");
        await addMemoryFact(userId, intent.memoryFact);
        try {
          await client.reactions.add({ channel: channelId, timestamp: message.ts, name: 'brain' });
        } catch { /* ignore */ }
        await publishFinalMessage(client, channelId, textProgressMsg, say, {
          text: "Saved to memory",
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `🧠 *Got it — saved to memory!*\n\nI'll keep "_${intent.memoryFact}_" in mind for all future meal analysis and recommendations.` }
            },
            {
              type: 'context',
              elements: [{ type: 'mrkdwn', text: await modelQuotaLine(userId) }]
            }
          ]
        });
        return;
      }

      // -------------------------------------------------------
      // INTENT: User skipped a meal
      // -------------------------------------------------------
      if (intent.intent === 'LOG_SKIP') {
        const meal = intent.skippedMeal || 'a meal';
        await updateProgressMessage(client, channelId, textProgressMsg, userId, "💬 *Working on your message...*", 75, "Saving skipped-meal context...");
        // Save skip as a memory observation
        await addMemoryFact(userId, `Skipped ${meal} on ${new Date().toLocaleDateString()}`);
        try {
          await client.reactions.add({ channel: channelId, timestamp: message.ts, name: 'no_entry_sign' });
        } catch { /* ignore */ }
        await publishFinalMessage(client, channelId, textProgressMsg, say, {
          text: `Noted skipped ${meal}`,
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `⚠️ Noted — I've logged that you skipped ${meal} today. I'll take that into account in your report tonight. Remember, even a light snack is better than skipping! 💪` }
            },
            {
              type: 'context',
              elements: [{ type: 'mrkdwn', text: await modelQuotaLine(userId) }]
            }
          ]
        });
        return;
      }

      // -------------------------------------------------------
      // INTENT: General chat / greeting — still respond smartly
      // -------------------------------------------------------
      if (intent.chatReply) {
        await publishFinalMessage(client, channelId, textProgressMsg, say, {
          text: intent.chatReply,
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: intent.chatReply }
            },
            {
              type: 'context',
              elements: [{ type: 'mrkdwn', text: await modelQuotaLine(userId) }]
            }
          ]
        });
      } else {
        const helpText = `👋 *Hey! I'm your co-living dietician.* 🍎\n\nJust *send me a photo* of what you're eating and I'll log it automatically. You can also tell me what you ate in plain text, share a preference, or just ask how you're doing today!`;
        await publishFinalMessage(client, channelId, textProgressMsg, say, {
          text: "CalTrack help",
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: helpText }
            },
            {
              type: 'context',
              elements: [{ type: 'mrkdwn', text: await modelQuotaLine(userId) }]
            }
          ]
        });
      }

    } catch (intentErr) {
      console.error('[Slack] Intent processing error:', intentErr);
      // Remove thinking reaction on error too
      try {
        await client.reactions.remove({ channel: channelId, timestamp: message.ts, name: 'thinking_face' });
        await client.reactions.add({ channel: channelId, timestamp: message.ts, name: 'warning' });
      } catch { /* ignore */ }
      const errorText = isModelQuotaError(intentErr)
        ? await quotaLimitText(userId)
        : "⚠️ I hit a snag processing that. Try again in a moment!";
      await publishFinalMessage(client, channelId, textProgressMsg, say, {
        text: isModelQuotaError(intentErr) ? "Daily model limit reached" : "Message processing failed",
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: errorText } }]
      });
    }
  });

  // Handle bot mentions in channels
  boltApp.event('app_mention', async ({ event, say }) => {
    await say(`👋 Hi <@${event.user}>! For private tracking and customized daily nutrition reports, please message me directly in a DM! 💬`);
  });
}

// Start Express Server
expressApp.listen(PORT, async () => {
  console.log(`[Server] Express server running on port ${PORT}`);

  // Agree/Verify Meta license on startup
  try {
    await agreeToMetaLicense();
  } catch (err) {
    console.warn('[Cloudflare] Meta license check warning:', err.message);
  }

  // Start Bolt App
  if (boltApp) {
    try {
      await boltApp.start();
      console.log('[Slack] Bolt application started successfully.');
      
      // Initialize Background Scheduler
      initScheduler(boltApp);
    } catch (err) {
      console.error('[Slack] Failed to start Bolt app:', err.message);
    }
  }
});
