# CalTrack 🥗🤖

An AI-powered nutrition tracking Slack Bot that analyzes food photos, estimates nutritional value, tracks daily calorie and macro goals, and acts as a proactive "co-living dietician."

## ✨ Features

- **Food Photo Logging**: Send/upload a picture of what you are eating in Slack. The bot uses **Llama 3.2 11B Vision** (via Cloudflare Workers AI) to recognize the meal, parse ingredients, calculate macros/micronutrients, assign a health score, check for allergens, and log it automatically.
- **Natural Language Input**: Tell the bot what you ate in plain English (e.g., *"I just had two idlis for breakfast and some coffee"*), and it will automatically classify the intent, extract foods, estimate nutrition, and log them under the right meal category.
- **Water Tracking**: Log daily water intake using simple slash-like commands (e.g., `/water 500` to log 500ml of water, `/water status` to check progress).
- **Proactive Dietician Reminders & Nudges**: Dynamic cron scheduling triggers helpful nudges throughout the day (morning breakfast prompts, afternoon sweet-craving alternatives, evening dinner planning, and water reminders).
- **Consolidated Nightly Report**: A friendly daily dietician summary analyzing calorie goals, macro/micronutrient balance, and actionable tips for the next day.
- **Long-term Memory (Mem0 integration)**: Automatically learns your personal eating habits, allergies, preferences, and milestones, customizing advice accordingly.

---

## 🛠️ Architecture & Tech Stack

- **Runtime**: Node.js (ESM)
- **Framework**: Express + `@slack/bolt` (supports Socket Mode out of the box)
- **Database**: Supabase PostgreSQL (via `@supabase/supabase-js`)
- **LLM & Vision**: Cloudflare Workers AI (Llama 3.2 11B Vision & Llama 3.1 8B Instruct)
- **Memory Store**: Mem0 Cloud API (with local profile fallback)
- **Scheduler**: `node-cron` for dynamic background reminders

---

## 🚀 Environment Setup

Create a `.env` file in the root directory:

```env
# Slack Bot Credentials
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...

# Cloudflare Workers AI
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...

# Mem0 Cloud Memory (Optional)
MEM0_API_KEY=...

# Supabase Credentials
SUPABASE_URL=...
SUPABASE_ANON_KEY=...

# App Config
PORT=3000
```

---

## 💻 Local Development

Run the following commands to install dependencies and start the server:

```bash
npm install
npm run dev
```

The Express server will launch on port `3000`, and Bolt will connect to Slack via Socket Mode.

---

## ☁️ Deploying on Render

This project contains a `render.yaml` Blueprint definition file for immediate deployment on Render.

1. Go to your **Render Dashboard** -> **New** -> **Blueprint**.
2. Connect your Git repository.
3. Fill in the environment variables when prompted.
4. Deploy! Render will build the web service using `npm install` and start it using `npm start`.
