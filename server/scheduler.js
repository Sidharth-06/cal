import cron from 'node-cron';
import { generateDailyReport, generateProactiveNudge, generateWaterReminder, generateMissedMealNudge } from './dietician.js';
import { db } from './db.js';

const DEFAULT_PROFILE = {
  reminderTimes: { morning: '08:30', afternoon: '15:30', evening: '19:00', report: '21:30' },
};


function isReminderDue(reminderTime, currentTime) {
  if (!reminderTime) return false;
  const [rH, rM] = reminderTime.split(':').map(Number);
  const [cH, cM] = currentTime.split(':').map(Number);
  const rTotal = rH * 60 + rM;
  const cTotal = cH * 60 + cM;
  return cTotal === rTotal;
}

function getCurrentTime24() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/**
 * Initialize all cron scheduler jobs.
 */
export function initScheduler(app) {
  console.log('[Scheduler] Initializing dynamic cron schedules...');

  // Main scheduler tick — runs every minute to check per-user reminder times
  cron.schedule('* * * * *', async () => {
    const currentTime = getCurrentTime24();
    const userIds = await db.getAllUserIds();

    for (const userId of userIds) {
      try {
        const profile = await db.getUserProfile(userId);
        const reminderTimes = profile.reminderTimes || DEFAULT_PROFILE.reminderTimes;

        // Check each reminder slot
        for (const [slot, time] of Object.entries(reminderTimes)) {
          if (!time) continue;
          if (isReminderDue(time, currentTime)) {
            // Throttle: avoid sending same reminder twice in same minute
            const throttleKey = `last_${slot}_at`;
            const lastSent = profile[throttleKey];
            if (lastSent) {
              const lastDate = new Date(lastSent);
              const now = new Date();
              if (now - lastDate < 60000) continue;
            }

            console.log(`[Scheduler] Triggering ${slot} nudge for ${userId} at ${time}`);

            if (slot === 'report') {
              await triggerDailyReportNow(app, userId);
            } else {
              const nudge = await generateProactiveNudge(userId, slot);
              if (nudge) {
                await app.client.chat.postMessage({
                  channel: userId,
                  text: `*💡 ${capitalize(slot)} Nudge*\n\n${nudge}`
                });
              }
            }

            // Update last sent timestamp
            const updateData = {};
            updateData[`last${capitalize(slot)}At`] = new Date().toISOString();
            await db.updateUserProfile(userId, updateData);
          }
        }

        // Proactive: Check for missed meals (every 2 hours)
        const hour = new Date().getHours();
        const minute = new Date().getMinutes();
        if (minute === 0 && [10, 14, 20].includes(hour)) {
          const missedMeal = await generateMissedMealNudge(userId);
          if (missedMeal) {
            await app.client.chat.postMessage({
              channel: userId,
              text: `🍽️ *Heads up!*\n\n${missedMeal}`
            });
          }
        }

        // Proactive: Water reminder (every 2 hours during daytime)
        if (minute === 30 && hour >= 9 && hour <= 21 && hour % 2 === 0) {
          const profile = await db.getUserProfile(userId);
          const waterGoal = profile.waterGoalMl || 2000;
          const waterIntake = profile.waterIntakeMl || 0;
          if (waterIntake < waterGoal) {
            const waterReminder = await generateWaterReminder(userId);
            if (waterReminder) {
              await app.client.chat.postMessage({
                channel: userId,
                text: `💧 *Hydration Check*\n\n${waterReminder}`
              });
            }
          }
        }

        // Nightly: Reset water intake at midnight
        if (hour === 0 && minute === 0) {
          await db.resetWaterIntake(userId);
          console.log(`[Scheduler] Reset water intake for ${userId}`);
        }

      } catch (err) {
        console.error(`[Scheduler] Error processing user ${userId}:`, err.message);
      }
    }
  }, {
    timezone: "Asia/Kolkata"
  });

  console.log('[Scheduler] Dynamic cron schedules loaded successfully.');
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Manually trigger the daily report for a user and send it to Slack.
 */
export async function triggerDailyReportNow(app, slackUserId) {
  try {
    const reportText = await generateDailyReport(slackUserId);
    await app.client.chat.postMessage({
      channel: slackUserId,
      text: `*📊 Daily Dietician Report* 🌟\n\n${reportText}`
    });
    console.log(`[Scheduler] Manually sent daily report to user ${slackUserId}`);
    return true;
  } catch (err) {
    console.error(`[Scheduler] Failed to trigger manual daily report for ${slackUserId}:`, err.message);
    throw err;
  }
}

/**
 * Manually trigger a proactive nudge for a user and send it to Slack.
 */
export async function triggerNudgeNow(app, slackUserId, timeOfDay) {
  try {
    const nudgeText = await generateProactiveNudge(slackUserId, timeOfDay);
    if (nudgeText) {
      await app.client.chat.postMessage({
        channel: slackUserId,
        text: `*💡 Dietician Nudge (${timeOfDay})*\n\n${nudgeText}`
      });
      console.log(`[Scheduler] Manually sent ${timeOfDay} nudge to user ${slackUserId}`);
      return true;
    }
    return false;
  } catch (err) {
    console.error(`[Scheduler] Failed to trigger manual nudge for ${slackUserId}:`, err.message);
    throw err;
  }
}
