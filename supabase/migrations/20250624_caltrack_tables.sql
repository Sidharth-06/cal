-- Caltrack Supabase Migration
-- Run this in your Supabase project's SQL Editor

CREATE TABLE IF NOT EXISTS profiles (
  slack_user_id TEXT PRIMARY KEY,
  daily_goal INTEGER DEFAULT 2000,
  macro_targets JSONB DEFAULT '{"protein": 150, "carbs": 250, "fats": 70}',
  weight REAL,
  weight_history JSONB DEFAULT '[]',
  dietician_memory JSONB DEFAULT '{"preferences": [], "allergies": [], "habits": [], "milestones": [], "rawMemoryLog": []}',
  model_usage JSONB DEFAULT '{}',
  water_goal_ml INTEGER DEFAULT 2000,
  water_intake_ml INTEGER DEFAULT 0,
  reminder_times JSONB DEFAULT '{"morning": "08:30", "afternoon": "15:30", "evening": "19:00", "report": "21:30"}',
  last_nudge_at TIMESTAMPTZ,
  last_report_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS logs (
  id TEXT PRIMARY KEY,
  slack_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  calories INTEGER NOT NULL,
  protein INTEGER DEFAULT 0,
  carbs INTEGER DEFAULT 0,
  fats INTEGER DEFAULT 0,
  category TEXT DEFAULT 'Snack',
  ingredients JSONB DEFAULT '[]',
  image_url TEXT,
  source TEXT DEFAULT 'image',
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_logs_user ON logs(slack_user_id, timestamp DESC);
