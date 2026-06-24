/* global process */
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

let supabase = null;
if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
  console.log('[DB] Supabase client initialized');
} else {
  console.warn('[DB] Supabase credentials not found — running in local fallback mode (data will not persist across restarts)');
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

function ensureDefaults(profile) {
  if (!profile) return { ...DEFAULT_PROFILE };
  return {
    ...DEFAULT_PROFILE,
    ...profile,
    dailyGoal: profile.dailyGoal ?? DEFAULT_PROFILE.dailyGoal,
    macroTargets: { ...DEFAULT_PROFILE.macroTargets, ...(profile.macroTargets || {}) },
    weight: profile.weight ?? DEFAULT_PROFILE.weight,
    weightHistory: profile.weightHistory || DEFAULT_PROFILE.weightHistory,
    dieticianMemory: { ...DEFAULT_PROFILE.dieticianMemory, ...(profile.dieticianMemory || {}) },
    modelUsage: { ...DEFAULT_PROFILE.modelUsage, ...(profile.modelUsage || {}) },
    waterGoalMl: profile.waterGoalMl ?? DEFAULT_PROFILE.waterGoalMl,
    waterIntakeMl: profile.waterIntakeMl ?? DEFAULT_PROFILE.waterIntakeMl,
    reminderTimes: { ...DEFAULT_PROFILE.reminderTimes, ...(profile.reminderTimes || {}) },
    lastNudgeAt: profile.lastNudgeAt ?? DEFAULT_PROFILE.lastNudgeAt,
    lastReportAt: profile.lastReportAt ?? DEFAULT_PROFILE.lastReportAt,
  };
}

const memLogs = [];
const memProfiles = {};

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

export const db = {
  async getUserLogs(slackUserId) {
    if (!supabase) {
      return memLogs.filter(l => l.slackUserId === slackUserId);
    }
    const { data, error } = await supabase
      .from('logs')
      .select('*')
      .eq('slack_user_id', slackUserId)
      .order('timestamp', { ascending: false });
    if (error) {
      console.error('[DB] getUserLogs error:', error.message);
      return [];
    }
    return data || [];
  },

  async addLog(slackUserId, log) {
    const newLog = {
      id: Date.now().toString() + Math.random().toString(36).substring(2, 7),
      slackUserId,
      timestamp: new Date().toISOString(),
      ...log,
    };
    if (supabase) {
      const { error } = await supabase.from('logs').insert({
        id: newLog.id,
        slack_user_id: newLog.slackUserId,
        name: newLog.name,
        calories: Number(newLog.calories || 0),
        protein: Number(newLog.protein || 0),
        carbs: Number(newLog.carbs || 0),
        fats: Number(newLog.fats || 0),
        category: newLog.category || 'Snack',
        ingredients: newLog.ingredients || [],
        image_url: newLog.imageUrl || null,
        source: newLog.source || 'image',
        timestamp: newLog.timestamp,
      });
      if (error) console.error('[DB] addLog error:', error.message);
    } else {
      memLogs.push(newLog);
    }
    return newLog;
  },

  async deleteLog(slackUserId, logId) {
    if (!supabase) {
      const idx = memLogs.findIndex(l => l.id === logId && l.slackUserId === slackUserId);
      if (idx !== -1) {
        memLogs.splice(idx, 1);
        return true;
      }
      return false;
    }
    const { error } = await supabase
      .from('logs')
      .delete()
      .eq('id', logId)
      .eq('slack_user_id', slackUserId);
    if (error) console.error('[DB] deleteLog error:', error.message);
    return !error;
  },

  async getUserProfile(slackUserId) {
    if (!supabase) {
      if (!memProfiles[slackUserId]) {
        memProfiles[slackUserId] = ensureDefaults(null);
      }
      return memProfiles[slackUserId];
    }
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('slack_user_id', slackUserId)
      .single();
    if (error || !data) return ensureDefaults(null);
    return ensureDefaults({
      dailyGoal: data.daily_goal,
      macroTargets: data.macro_targets,
      weight: data.weight,
      weightHistory: data.weight_history,
      dieticianMemory: data.dietician_memory,
      modelUsage: data.model_usage,
      waterGoalMl: data.water_goal_ml,
      waterIntakeMl: data.water_intake_ml,
      reminderTimes: data.reminder_times,
      lastNudgeAt: data.last_nudge_at,
      lastReportAt: data.last_report_at,
    });
  },

  async updateUserProfile(slackUserId, profileData) {
    const current = await this.getUserProfile(slackUserId);
    const updated = {
      ...current,
      ...profileData,
      dailyGoal: profileData.dailyGoal ?? current.dailyGoal,
      macroTargets: profileData.macroTargets
        ? { ...current.macroTargets, ...profileData.macroTargets }
        : current.macroTargets,
      dieticianMemory: profileData.dieticianMemory
        ? { ...current.dieticianMemory, ...profileData.dieticianMemory }
        : current.dieticianMemory,
      reminderTimes: profileData.reminderTimes
        ? { ...current.reminderTimes, ...profileData.reminderTimes }
        : current.reminderTimes,
    };
    if (supabase) {
      const { error } = await supabase.from('profiles').upsert({
        slack_user_id: slackUserId,
        daily_goal: updated.dailyGoal,
        macro_targets: updated.macroTargets,
        weight: updated.weight,
        weight_history: updated.weightHistory,
        dietician_memory: updated.dieticianMemory,
        model_usage: updated.modelUsage,
        water_goal_ml: updated.waterGoalMl,
        water_intake_ml: updated.waterIntakeMl,
        reminder_times: updated.reminderTimes,
        last_nudge_at: updated.lastNudgeAt,
        last_report_at: updated.lastReportAt,
        updated_at: new Date().toISOString(),
      });
      if (error) console.error('[DB] updateUserProfile error:', error.message);
    } else {
      memProfiles[slackUserId] = updated;
    }
    return updated;
  },

  async updateUserMemory(slackUserId, dieticianMemory) {
    const current = await this.getUserProfile(slackUserId);
    const updatedMemory = { ...current.dieticianMemory, ...dieticianMemory };
    await this.updateUserProfile(slackUserId, { dieticianMemory: updatedMemory });
    return updatedMemory;
  },

  async getModelUsage(slackUserId, dateKey = todayKey()) {
    const profile = await this.getUserProfile(slackUserId);
    const usage = profile.modelUsage || {};
    return {
      calls: 0,
      estimatedTokens: 0,
      models: {},
      ...(usage[dateKey] || {}),
    };
  },

  async recordModelUsage(slackUserId, usage, dateKey = todayKey()) {
    const current = await this.getUserProfile(slackUserId);
    const modelUsage = current.modelUsage || {};
    const today = {
      calls: 0,
      estimatedTokens: 0,
      models: {},
      ...(modelUsage[dateKey] || {}),
    };
    const modelId = usage.modelId || 'unknown';
    today.calls += 1;
    today.estimatedTokens += Number(usage.estimatedTokens || 0);
    today.models[modelId] = (today.models[modelId] || 0) + 1;

    const updated = {
      ...current,
      modelUsage: { ...modelUsage, [dateKey]: today },
    };
    if (supabase) {
      const { error } = await supabase.from('profiles').upsert({
        slack_user_id: slackUserId,
        model_usage: updated.modelUsage,
        updated_at: new Date().toISOString(),
      });
      if (error) console.error('[DB] recordModelUsage error:', error.message);
    } else {
      memProfiles[slackUserId] = updated;
    }
    return today;
  },

  async addWaterIntake(slackUserId, amountMl) {
    const current = await this.getUserProfile(slackUserId);
    const newIntake = (current.waterIntakeMl || 0) + amountMl;
    const updated = { ...current, waterIntakeMl: newIntake };
    if (supabase) {
      const { error } = await supabase.from('profiles').upsert({
        slack_user_id: slackUserId,
        water_intake_ml: newIntake,
        updated_at: new Date().toISOString(),
      });
      if (error) console.error('[DB] addWaterIntake error:', error.message);
    } else {
      memProfiles[slackUserId] = updated;
    }
    return updated;
  },

  async resetWaterIntake(slackUserId) {
    const current = await this.getUserProfile(slackUserId);
    const updated = { ...current, waterIntakeMl: 0 };
    if (supabase) {
      const { error } = await supabase.from('profiles').upsert({
        slack_user_id: slackUserId,
        water_intake_ml: 0,
        updated_at: new Date().toISOString(),
      });
      if (error) console.error('[DB] resetWaterIntake error:', error.message);
    } else {
      memProfiles[slackUserId] = updated;
    }
    return updated;
  },

  async updateReminderTimes(slackUserId, reminderTimes) {
    const current = await this.getUserProfile(slackUserId);
    const updated = { ...current, reminderTimes: { ...current.reminderTimes, ...reminderTimes } };
    if (supabase) {
      const { error } = await supabase.from('profiles').upsert({
        slack_user_id: slackUserId,
        reminder_times: updated.reminderTimes,
        updated_at: new Date().toISOString(),
      });
      if (error) console.error('[DB] updateReminderTimes error:', error.message);
    } else {
      memProfiles[slackUserId] = updated;
    }
    return updated;
  },

  async getAllUserIds() {
    if (!supabase) return Object.keys(memProfiles);
    const { data, error } = await supabase
      .from('profiles')
      .select('slack_user_id');
    if (error) {
      console.error('[DB] getAllUserIds error:', error.message);
      return [];
    }
    return (data || []).map(row => row.slack_user_id);
  },
};
