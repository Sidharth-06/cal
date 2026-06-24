import axios from 'axios';
import { db } from './db.js';

// Retrieve keys from environment
const getCFToken = () => process.env.CLOUDFLARE_API_TOKEN;
const getCFAccountId = () => process.env.CLOUDFLARE_ACCOUNT_ID;
const getMem0ApiKey = () => process.env.MEM0_API_KEY;
const getDailyModelCallLimit = () => Number(process.env.MODEL_DAILY_CALL_LIMIT || 100);

function estimatePayloadTokens(payload, result) {
  const textParts = [];
  if (payload?.prompt) textParts.push(payload.prompt);
  if (Array.isArray(payload?.messages)) {
    for (const message of payload.messages) {
      textParts.push(message.content || '');
    }
  }
  if (result?.response) textParts.push(result.response);
  const textTokens = Math.ceil(textParts.join('\n').length / 4);
  const imageTokens = payload?.image ? 1000 : 0;
  return textTokens + imageTokens;
}

export async function getModelQuotaStatus(slackUserId) {
  const limit = getDailyModelCallLimit();
  const usage = await db.getModelUsage(slackUserId);
  const used = usage.calls || 0;
  const remaining = Math.max(0, limit - used);
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return {
    limit,
    used,
    remaining,
    percent,
    estimatedTokens: usage.estimatedTokens || 0,
  };
}

export async function hasModelQuota(slackUserId) {
  return (await getModelQuotaStatus(slackUserId)).remaining > 0;
}

async function createQuotaError(slackUserId) {
  const quota = await getModelQuotaStatus(slackUserId);
  const err = new Error(`Daily model call limit reached (${quota.used}/${quota.limit}).`);
  err.code = 'MODEL_QUOTA_EXCEEDED';
  err.quota = quota;
  return err;
}

/**
 * Execute inference on Cloudflare Workers AI REST API.
 */
async function runCFModel(modelId, payload, metadata = {}) {
  const token = getCFToken();
  const accountId = getCFAccountId();

  if (!token || !accountId) {
    throw new Error('Cloudflare credentials not configured. Please set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in .env.');
  }

  if (metadata.slackUserId && !(await hasModelQuota(metadata.slackUserId))) {
    throw await createQuotaError(metadata.slackUserId);
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${modelId}`;

  try {
    const response = await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.data || !response.data.success) {
      throw new Error(`Cloudflare API Error: ${JSON.stringify(response.data?.errors || 'Unknown error')}`);
    }

    return response.data.result;
  } catch (err) {
    console.error(`[Cloudflare] Model run failed for ${modelId}:`, err.message);
    throw err;
  } finally {
    if (metadata.slackUserId) {
      try {
        await db.recordModelUsage(metadata.slackUserId, {
          modelId,
          purpose: metadata.purpose,
          estimatedTokens: estimatePayloadTokens(payload, undefined),
        });
      } catch (usageErr) {
        console.warn('[Usage] Failed to record model usage:', usageErr.message);
      }
    }
  }
}

function extractMarkdownSection(text, heading) {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sectionPattern = new RegExp(
    `(?:\\*\\*)?${escapedHeading}:?(?:\\*\\*)?\\s*\\n?([\\s\\S]*?)(?=\\n\\s*(?:\\*\\*)?[A-Z][^\\n:]{1,80}:(?:\\*\\*)?\\s*(?:\\n|$)|$)`,
    'i'
  );
  const match = text.match(sectionPattern);
  return match ? match[1].trim() : '';
}

function extractFirstMarkdownSection(text, headings) {
  for (const heading of headings) {
    const section = extractMarkdownSection(text, heading);
    if (section) return section;
  }
  return '';
}

function parseNumber(value, fallback = 0) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const match = String(value ?? '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : fallback;
}

function extractJsonCandidates(text) {
  const candidates = [];
  const fencedPattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  let fencedMatch;
  while ((fencedMatch = fencedPattern.exec(text)) !== null) {
    candidates.push(fencedMatch[1].trim());
  }

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return [...new Set(candidates)];
}

function parseBulletList(section) {
  const lines = section.split('\n');
  const bulletLines = lines.filter(line => /^\s*[-*]\s+/.test(line));
  return (bulletLines.length > 0 ? bulletLines : lines)
    .map(line => line.replace(/^\s*[-*]\s*/, '').trim())
    .filter(Boolean);
}

function parseLabeledNumber(section, label) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = section.match(new RegExp(`${escapedLabel}\\s*:\\s*([^\\n]+)`, 'i'));
  return parseNumber(match?.[1]);
}

function parseMarkdownFoodReport(text) {
  const foodSection = extractFirstMarkdownSection(text, ['Food Name and Cuisine Type', 'Dish Name', 'Food Name']);
  const category = extractMarkdownSection(text, 'Category').split(/\s+or\s+/i)[0].trim() || 'Snack';
  const servingSize = extractMarkdownSection(text, 'Serving Size');
  const ingredientLines = parseBulletList(extractMarkdownSection(text, 'Ingredients'));
  const macrosSection = extractFirstMarkdownSection(text, ['Macronutrients', 'Macros']);
  const microsSection = extractFirstMarkdownSection(text, ['Micros', 'Micronutrients']);
  const tags = parseBulletList(extractMarkdownSection(text, 'Tags'));
  const newMemoryFacts = parseBulletList(extractMarkdownSection(text, 'New Memory Facts'));
  const allergensText = extractMarkdownSection(text, 'Allergens');

  const foodName =
    foodSection.match(/appears to be (?:a |an )?([^,.]+)/i)?.[1]?.trim() ||
    foodSection.match(/dish is (?:a |an )?([^,.]+)/i)?.[1]?.trim() ||
    foodSection.split(/[,.]/)[0].trim() ||
    'Unknown food';

  const cuisineType =
    foodSection.match(/from (?:a )?([^,.]+(?:region|cuisine|area|country))/i)?.[1]?.trim() ||
    foodSection.match(/possibly from ([^,.]+)/i)?.[1]?.trim() ||
    'Unknown';

  const ingredients = ingredientLines.map(line => {
    const quantityMatch = line.match(/^(.*?)(?:\s*\(([^)]+)\)|\s+-\s+(.+))$/);
    if (quantityMatch) {
      return {
        name: quantityMatch[1].trim(),
        quantity: (quantityMatch[2] || quantityMatch[3] || '').trim()
      };
    }
    return { name: line, quantity: '' };
  });

  const glycemicText = extractMarkdownSection(text, 'Glycemic Index').toLowerCase();
  const glycemicIndex = glycemicText.includes('low')
    ? 'low'
    : glycemicText.includes('medium')
      ? 'medium'
      : glycemicText.includes('high')
        ? 'high'
        : 'medium';

  const allergenList = /^none\b/i.test(allergensText)
    ? []
    : parseBulletList(allergensText).length > 0
      ? parseBulletList(allergensText)
      : allergensText
        ? allergensText.split(',').map(item => item.trim()).filter(Boolean)
        : [];

  return {
    foodName,
    cuisineType,
    category,
    servingSize,
    ingredients,
    macros: {
      calories: parseLabeledNumber(macrosSection, 'Calories'),
      protein: parseLabeledNumber(macrosSection, 'Protein'),
      carbs: parseLabeledNumber(macrosSection, 'Carbs'),
      fats: parseLabeledNumber(macrosSection, 'Fats'),
      fiber: parseLabeledNumber(macrosSection, 'Fiber'),
      sugar: parseLabeledNumber(macrosSection, 'Sugar'),
      saturatedFat: parseLabeledNumber(macrosSection, 'Saturated Fat'),
      unsaturatedFat: parseLabeledNumber(macrosSection, 'Unsaturated Fat')
    },
    micros: {
      sodium: parseLabeledNumber(microsSection, 'Sodium'),
      potassium: parseLabeledNumber(microsSection, 'Potassium'),
      calcium: parseLabeledNumber(microsSection, 'Calcium'),
      iron: parseLabeledNumber(microsSection, 'Iron'),
      vitaminC: parseLabeledNumber(microsSection, 'Vitamin C'),
      vitaminD: parseLabeledNumber(microsSection, 'Vitamin D'),
      vitaminB12: parseLabeledNumber(microsSection, 'Vitamin B12'),
      cholesterol: parseLabeledNumber(microsSection, 'Cholesterol')
    },
    glycemicIndex,
    healthScore: parseNumber(extractMarkdownSection(text, 'Health Score')),
    allergens: allergenList,
    tags,
    insight: extractMarkdownSection(text, 'Insight'),
    newMemoryFacts
  };
}

function normalizeCategory(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('breakfast')) return 'Breakfast';
  if (text.includes('lunch')) return 'Lunch';
  if (text.includes('dinner')) return 'Dinner';
  if (text.includes('beverage') || text.includes('drink')) return 'Beverage';
  if (text.includes('snack')) return 'Snack';
  return 'Snack';
}

function normalizeFoodLog(raw) {
  const source = raw || {};
  const foodName = String(source.foodName || source.name || source.food || '').trim();
  return {
    foodName,
    category: normalizeCategory(source.category || source.mealType || source.timeline),
    ingredients: normalizeStringArray(source.ingredients),
    calories: parseNumber(source.calories),
    protein: parseNumber(source.protein),
    carbs: parseNumber(source.carbs),
    fats: parseNumber(source.fats),
    insight: String(source.insight || '').trim()
  };
}

function normalizeIntentResult(raw) {
  const intent = raw || {};
  const foodLogs = Array.isArray(intent.foodLogs)
    ? intent.foodLogs.map(normalizeFoodLog).filter(food => food.foodName)
    : [];

  if (foodLogs.length === 0 && intent.foodLog) {
    const foodLog = normalizeFoodLog(intent.foodLog);
    if (foodLog.foodName) foodLogs.push(foodLog);
  }

  return {
    ...intent,
    foodLogs,
    foodLog: foodLogs[0] || intent.foodLog || null
  };
}

function normalizeGlycemicIndex(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('low')) return 'low';
  if (text.includes('high')) return 'high';
  return 'medium';
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return value
      .map(item => (typeof item === 'string' ? item : item?.name || item?.text || ''))
      .map(item => item.trim())
      .filter(Boolean);
  }
  if (typeof value !== 'string' || /^none\b/i.test(value.trim())) return [];
  return value
    .split(/,|\n/)
    .map(item => item.replace(/^\s*[-*]\s*/, '').trim())
    .filter(Boolean);
}

function normalizeIngredients(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => {
      if (typeof item === 'string') return { name: item.trim(), quantity: '' };
      return {
        name: String(item?.name || item?.ingredient || '').trim(),
        quantity: String(item?.quantity || item?.amount || item?.serving || '').trim()
      };
    })
    .filter(item => item.name);
}

function clampHealthScore(value) {
  const score = parseNumber(value, 5);
  return Math.max(1, Math.min(10, Math.round(score)));
}

function normalizeFoodAnalysis(raw) {
  const source = raw || {};
  const macros = source.macros || source.macronutrients || {};
  const micros = source.micros || source.micronutrients || {};
  const foodName = String(source.foodName || source.name || source.dishName || source.food || '').trim();

  return {
    foodName: foodName || 'Unknown food',
    cuisineType: String(source.cuisineType || source.cuisine || 'Unknown').trim() || 'Unknown',
    category: normalizeCategory(source.category || source.mealType),
    servingSize: String(source.servingSize || source.serving || source.portion || '').trim(),
    ingredients: normalizeIngredients(source.ingredients),
    macros: {
      calories: parseNumber(macros.calories ?? source.calories),
      protein: parseNumber(macros.protein ?? source.protein),
      carbs: parseNumber(macros.carbs ?? macros.carbohydrates ?? source.carbs ?? source.carbohydrates),
      fats: parseNumber(macros.fats ?? macros.fat ?? source.fats ?? source.fat),
      fiber: parseNumber(macros.fiber ?? source.fiber),
      sugar: parseNumber(macros.sugar ?? macros.sugars ?? source.sugar ?? source.sugars),
      saturatedFat: parseNumber(macros.saturatedFat ?? macros.saturated_fat ?? source.saturatedFat ?? source.saturated_fat),
      unsaturatedFat: parseNumber(macros.unsaturatedFat ?? macros.unsaturated_fat ?? source.unsaturatedFat ?? source.unsaturated_fat)
    },
    micros: {
      sodium: parseNumber(micros.sodium ?? source.sodium),
      potassium: parseNumber(micros.potassium ?? source.potassium),
      calcium: parseNumber(micros.calcium ?? source.calcium),
      iron: parseNumber(micros.iron ?? source.iron),
      vitaminC: parseNumber(micros.vitaminC ?? micros.vitamin_c ?? source.vitaminC ?? source.vitamin_c),
      vitaminD: parseNumber(micros.vitaminD ?? micros.vitamin_d ?? source.vitaminD ?? source.vitamin_d),
      vitaminB12: parseNumber(micros.vitaminB12 ?? micros.vitamin_b12 ?? source.vitaminB12 ?? source.vitamin_b12),
      cholesterol: parseNumber(micros.cholesterol ?? source.cholesterol)
    },
    glycemicIndex: normalizeGlycemicIndex(source.glycemicIndex || source.gi),
    healthScore: clampHealthScore(source.healthScore),
    allergens: normalizeStringArray(source.allergens),
    tags: normalizeStringArray(source.tags),
    insight: String(source.insight || source.dieticianInsight || '').trim(),
    newMemoryFacts: normalizeStringArray(source.newMemoryFacts || source.memoryFacts)
  };
}

function hasUsableFoodAnalysis(analysis) {
  return Boolean(
    analysis &&
    analysis.foodName &&
    analysis.foodName !== 'Unknown food' &&
    (analysis.macros.calories > 0 || analysis.ingredients.length > 0)
  );
}

function parseFoodAnalysisJson(text) {
  for (const candidate of extractJsonCandidates(text)) {
    try {
      const parsed = normalizeFoodAnalysis(JSON.parse(candidate));
      if (hasUsableFoodAnalysis(parsed)) return parsed;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

async function emitProgress(onProgress, percent, status) {
  if (!onProgress) return;
  try {
    await onProgress({ percent, status });
  } catch {
    // Progress updates should never fail the actual food analysis.
  }
}

/**
 * Proactively accept/verify Meta's model license agreement on startup.
 */
export async function agreeToMetaLicense() {
  try {
    await runCFModel('@cf/meta/llama-3.2-11b-vision-instruct', { prompt: "agree" });
    console.log('[Cloudflare] Llama Vision license agreement verified/agreed.');
  } catch (err) {
    console.log('[Cloudflare] Llama Vision license check complete (already agreed or verified):', err.message);
  }
}

/**
 * Fetch long-term memory context for a user.
 * Combines either Mem0 Cloud data or local fallback memory.
 */
export async function getMemoryContext(slackUserId) {
  const mem0ApiKey = getMem0ApiKey();
  
  if (mem0ApiKey) {
    try {
      console.log(`[Memory] Fetching memory from Mem0 Cloud for ${slackUserId}`);
      const response = await axios.get(`https://api.mem0.ai/v1/memories/?user_id=${slackUserId}`, {
        headers: { 'Authorization': `Token ${mem0ApiKey}` }
      });
      if (response.data && Array.isArray(response.data)) {
        if (response.data.length === 0) return 'No profile memory established yet.';
        return response.data.map(m => `- ${m.memory}`).join('\n');
      }
    } catch (err) {
      console.error('[Memory] Error fetching from Mem0 Cloud:', err.message);
    }
  }

  // Fallback to local file-based memory
  console.log(`[Memory] Fetching local memory from db.json for ${slackUserId}`);
  const profile = await db.getUserProfile(slackUserId);
  const mem = profile.dieticianMemory || {};
  
  const sections = [];
  if (mem.preferences && mem.preferences.length > 0) {
    sections.push(`Preferences:\n${mem.preferences.map(p => `  - ${p}`).join('\n')}`);
  }
  if (mem.allergies && mem.allergies.length > 0) {
    sections.push(`Allergies/Sensitivities:\n${mem.allergies.map(a => `  - ${a}`).join('\n')}`);
  }
  if (mem.habits && mem.habits.length > 0) {
    sections.push(`Behavioral Habits:\n${mem.habits.map(h => `  - ${h}`).join('\n')}`);
  }
  if (mem.milestones && mem.milestones.length > 0) {
    sections.push(`Milestones/Progress:\n${mem.milestones.map(m => `  - ${m}`).join('\n')}`);
  }

  return sections.length > 0 ? sections.join('\n\n') : 'No profile memory established yet.';
}

// ─── INTENT CLASSIFIER — Stage 1 ─────────────────────────────────────────────
// Maps BART zero-shot labels → internal intent names
const BART_LABEL_MAP = {
  'food or drink consumed':          'LOG_FOOD_TEXT',
  'daily summary or report':         'REQUEST_REPORT',
  'food suggestion or advice':       'ASK_SUGGESTION',
  'personal preference allergy goal':'SAVE_MEMORY',
  'skipped or missed a meal':        'LOG_SKIP',
  'greeting or general chat':        'GENERAL_CHAT',
};
const BART_LABELS = Object.keys(BART_LABEL_MAP);

/**
 * Stage 1: Fast, deterministic intent classification via BART MNLI.
 * No prompt engineering — BART is purpose-built for zero-shot classification.
 */
async function classifyIntentBART(messageText, slackUserId) {
  try {
    const result = await runCFModel('@cf/facebook/bart-large-mnli', {
      text: messageText,
      candidate_labels: BART_LABELS,
    }, { slackUserId, purpose: 'classify' });

    const topLabel = result.labels[0];
    const topScore = result.scores[0];
    const intent = BART_LABEL_MAP[topLabel] || 'GENERAL_CHAT';
    console.log(`[Intent/BART] "${messageText.substring(0, 60)}" → ${intent} (${(topScore * 100).toFixed(1)}%)`);
    return { intent, score: topScore };
  } catch (err) {
    console.error('[Intent/BART] Classification failed, falling back to GENERAL_CHAT:', err.message);
    return { intent: 'GENERAL_CHAT', score: 0 };
  }
}

// ─── EXTRACTION HELPERS — Stage 2 ────────────────────────────────────────────
// Each function is a focused single-purpose prompt — shorter, faster, more reliable.

async function extractFoodLogs(messageText, profile, memoryContext, todayStats, slackUserId) {
  const { totalCalories, totalProtein, totalCarbs, totalFats } = todayStats;
  const prompt = `You are a nutrition assistant. Extract every food and drink item from the message below and estimate their nutrition.

Message: "${messageText}"

User memory: ${memoryContext}
Daily goal: ${profile.dailyGoal} kcal | P: ${profile.macroTargets.protein}g | C: ${profile.macroTargets.carbs}g | F: ${profile.macroTargets.fats}g
Today so far: ${totalCalories} kcal | P: ${totalProtein}g | C: ${totalCarbs}g | F: ${totalFats}g

For each food item, assign a category:
- Breakfast: breakfast, morning, first meal, woke up
- Lunch: lunch, afternoon, noon, midday
- Dinner: dinner, night, evening, late meal
- Beverage: coffee, tea, juice, soda, alcohol, water, smoothie
- Snack: anything else or unclear

Return ONLY a raw JSON array. First char [, last char ]. One object per food item:
[{"foodName":"","category":"Snack","calories":0,"protein":0,"carbs":0,"fats":0,"insight":""}]`;

  const result = await runCFModel('@cf/meta/llama-3.1-8b-instruct-fp8-fast', {
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 700,
  }, { slackUserId, purpose: 'food_extract' });

  const text = result.response.trim();
  console.log(`[Intent/Extract] Food extraction raw (200 chars): ${text.substring(0, 200)}`);

  // Try array form first, then object wrapper
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      const arr = JSON.parse(arrMatch[0]);
      const foodLogs = arr
        .map(f => normalizeFoodLog(f))
        .filter(f => f.foodName);
      return { foodLogs, foodLog: foodLogs[0] || null };
    } catch { /* fall through */ }
  }
  // Fallback: try wrapped object
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const obj = JSON.parse(objMatch[0]);
      const foodLogs = Array.isArray(obj.foodLogs)
        ? obj.foodLogs.map(f => normalizeFoodLog(f)).filter(f => f.foodName)
        : [normalizeFoodLog(obj)].filter(f => f.foodName);
      return { foodLogs, foodLog: foodLogs[0] || null };
    } catch { /* fall through */ }
  }
  console.warn('[Intent/Extract] Food extraction returned no parseable JSON.');
  return { foodLogs: [], foodLog: null };
}

async function extractSuggestion(profile, memoryContext, todayStats, slackUserId) {
  const { totalCalories, totalProtein, totalCarbs, totalFats } = todayStats;
  const remaining = profile.dailyGoal - totalCalories;
  const prompt = `You are a supportive dietician. Give a short, personalized meal suggestion.

User memory: ${memoryContext}
Remaining calories today: ${remaining} kcal
Remaining: P ${profile.macroTargets.protein - totalProtein}g | C ${profile.macroTargets.carbs - totalCarbs}g | F ${profile.macroTargets.fats - totalFats}g

Write 2-3 sentences. Be specific, friendly, and practical. Return only the suggestion text.`;

  const result = await runCFModel('@cf/meta/llama-3.1-8b-instruct-fp8-fast', {
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 250,
  }, { slackUserId, purpose: 'suggestion' });

  return result.response.trim();
}

async function extractMemoryFact(messageText, slackUserId) {
  const prompt = `From the message below, extract the key personal fact the user wants to save (preference, allergy, goal, or habit). Return only the fact as a short plain sentence. If nothing is extractable, return "none".

Message: "${messageText}"`;

  const result = await runCFModel('@cf/meta/llama-3.1-8b-instruct-fp8-fast', {
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 100,
  }, { slackUserId, purpose: 'memory_extract' });

  const fact = result.response.trim();
  return fact.toLowerCase() === 'none' ? null : fact;
}

async function generateChatReply(messageText, memoryContext, slackUserId) {
  const prompt = `You are a friendly nutrition tracking assistant. Reply briefly and naturally to this message.

User memory: ${memoryContext}
Message: "${messageText}"

Keep it under 2 sentences. Be warm and helpful. Return only the reply.`;

  const result = await runCFModel('@cf/meta/llama-3.1-8b-instruct-fp8-fast', {
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 150,
  }, { slackUserId, purpose: 'chat_reply' });

  return result.response.trim();
}

function extractSkippedMeal(messageText) {
  if (/breakfast/i.test(messageText)) return 'Breakfast';
  if (/lunch/i.test(messageText)) return 'Lunch';
  if (/dinner/i.test(messageText)) return 'Dinner';
  return 'a meal';
}

/**
 * Interpret the user's free-form text message and determine what they want.
 *
 * Two-stage pipeline:
 *   Stage 1 — BART MNLI:  Fast, dedicated zero-shot classifier → intent label
 *   Stage 2 — Llama 8B:   Focused extraction prompt (only for intents that need it)
 *
 * Intents:
 *  - LOG_FOOD_TEXT   : User described food they ate
 *  - REQUEST_REPORT  : User wants a daily summary
 *  - ASK_SUGGESTION  : User wants meal advice
 *  - SAVE_MEMORY     : User shared a preference, allergy, goal, or habit
 *  - LOG_SKIP        : User mentioned skipping a meal
 *  - GENERAL_CHAT    : Casual message, greeting, or anything else
 */
export async function interpretMessage(slackUserId, messageText) {
  // Shared context used by stage-2 extraction helpers
  const [profile, memoryContext, allLogs] = await Promise.all([
    db.getUserProfile(slackUserId),
    getMemoryContext(slackUserId),
    db.getUserLogs(slackUserId),
  ]);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayLogs = allLogs.filter(log => new Date(log.timestamp) >= todayStart);

  const todayStats = {
    totalCalories: todayLogs.reduce((s, f) => s + f.calories, 0),
    totalProtein:  todayLogs.reduce((s, f) => s + (f.protein || 0), 0),
    totalCarbs:    todayLogs.reduce((s, f) => s + (f.carbs || 0), 0),
    totalFats:     todayLogs.reduce((s, f) => s + (f.fats || 0), 0),
  };

  // ── Stage 1: Classify with BART MNLI ─────────────────────────────────────
  const { intent } = await classifyIntentBART(messageText, slackUserId);

  // ── Stage 2: Focused extraction per intent ────────────────────────────────
  try {
    switch (intent) {

      case 'LOG_FOOD_TEXT': {
        const { foodLogs, foodLog } = await extractFoodLogs(
          messageText, profile, memoryContext, todayStats, slackUserId
        );
        return normalizeIntentResult({ intent, foodLogs, foodLog });
      }

      case 'REQUEST_REPORT':
        return { intent, foodLogs: [], foodLog: null };

      case 'ASK_SUGGESTION': {
        const suggestion = await extractSuggestion(
          profile, memoryContext, todayStats, slackUserId
        );
        return { intent, suggestion, foodLogs: [], foodLog: null };
      }

      case 'SAVE_MEMORY': {
        const memoryFact = await extractMemoryFact(messageText, slackUserId);
        return { intent, memoryFact, foodLogs: [], foodLog: null };
      }

      case 'LOG_SKIP': {
        const skippedMeal = extractSkippedMeal(messageText);
        return { intent, skippedMeal, foodLogs: [], foodLog: null };
      }

      default: {
        // GENERAL_CHAT — generate a proper reply
        const chatReply = await generateChatReply(
          messageText, memoryContext, slackUserId
        );
        return { intent: 'GENERAL_CHAT', chatReply, foodLogs: [], foodLog: null };
      }
    }
  } catch (err) {
    console.error(`[Intent] Stage-2 extraction failed for intent "${intent}":`, err.message);
    return { intent: 'GENERAL_CHAT', chatReply: "I hit a snag processing that. Try again in a moment! 🙏", foodLogs: [], foodLog: null };
  }
}


/**
 * Add a new fact to the user's memory.
 */
export async function addMemoryFact(slackUserId, factText) {
  if (!factText || factText.trim() === '') return;
  
  const mem0ApiKey = getMem0ApiKey();

  if (mem0ApiKey) {
    try {
      console.log(`[Memory] Adding fact to Mem0 Cloud for ${slackUserId}: "${factText}"`);
      await axios.post('https://api.mem0.ai/v1/memories/', {
        messages: [{ role: 'user', content: factText }],
        user_id: slackUserId
      }, {
        headers: {
          'Authorization': `Token ${mem0ApiKey}`,
          'Content-Type': 'application/json'
        }
      });
      return;
    } catch (err) {
      console.error('[Memory] Error adding to Mem0 Cloud:', err.message);
    }
  }

  // Fallback to local file-based memory
  console.log(`[Memory] Saving local memory fact for ${slackUserId}: "${factText}"`);
  const profile = await db.getUserProfile(slackUserId);
  const mem = profile.dieticianMemory || { preferences: [], allergies: [], habits: [], milestones: [], rawMemoryLog: [] };
  
  if (!mem.rawMemoryLog) mem.rawMemoryLog = [];
  mem.rawMemoryLog.push({ text: factText, date: new Date().toISOString() });
  
  try {
    const prompt = `You are a dietician memory parser. Analyze the new note: "${factText}"
Current Memory Structure:
${JSON.stringify(mem, null, 2)}

Integrate the new note into the memory structure categorizing it under 'preferences', 'allergies', 'habits', or 'milestones'. Remove duplicate or outdated information. Return ONLY the updated JSON structure, no other explanation or markdown formatting.`;

    const result = await runCFModel('@cf/meta/llama-3.1-8b-instruct-fp8-fast', {
      messages: [{ role: 'user', content: prompt }]
    }, { slackUserId, purpose: 'memory' });

    const content = result.response.trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsedMem = JSON.parse(jsonMatch[0]);
      await db.updateUserMemory(slackUserId, parsedMem);
    } else {
      await db.updateUserMemory(slackUserId, mem);
    }
  } catch (err) {
    console.error('[Memory] Local memory categorization pass failed:', err.message);
    await db.updateUserMemory(slackUserId, mem);
  }
}

/**
 * Use Llama 3.2 11B Vision to analyze food image with comprehensive nutritional breakdown.
 * Returns macros, micronutrients, health score, allergens, cuisine type, and more.
 */
export async function analyzeFoodImage(slackUserId, base64Image, mimetype, promptNotes = "", onProgress = null) {
  const profile = await db.getUserProfile(slackUserId);
  const memoryContext = await getMemoryContext(slackUserId);

  const imageBytes = Array.from(Buffer.from(base64Image, 'base64'));

  const promptText = `[INST] You are a clinical nutrition AI. Your ONLY output must be a single raw JSON object. Do NOT write any text, explanation, markdown, or code fences before or after the JSON. The very first character of your response must be { and the very last must be }.

Analyze the food in this image.

USER MEMORY: ${memoryContext}
DAILY TARGETS: Calories ${profile.dailyGoal}kcal | Protein ${profile.macroTargets.protein}g | Carbs ${profile.macroTargets.carbs}g | Fats ${profile.macroTargets.fats}g
USER NOTE: "${promptNotes}"

Output ONLY this JSON (replace all placeholder values with real data, use 0 for unknown numbers, [] for unknown arrays, "" for unknown strings):

{"foodName":"","cuisineType":"","category":"Snack","servingSize":"","ingredients":[{"name":"","quantity":""}],"macros":{"calories":0,"protein":0,"carbs":0,"fats":0,"fiber":0,"sugar":0,"saturatedFat":0,"unsaturatedFat":0},"micros":{"sodium":0,"potassium":0,"calcium":0,"iron":0,"vitaminC":0,"vitaminD":0,"vitaminB12":0,"cholesterol":0},"glycemicIndex":"medium","healthScore":5,"allergens":[],"tags":[],"insight":"","newMemoryFacts":[]}

STRICT RULES — violating any rule makes your response invalid:
- ingredients: ONLY real food items with name+quantity. Never put tags, nutrient names, or memory facts here.
- tags: ONLY short meal descriptors like "high-protein", "vegetarian", "low-fat". Never put sentences here.
- newMemoryFacts: ONLY behavioural observations about this user's eating habits. Max 2 items.
- insight: plain text only, no asterisks, no markdown, no bullet points.
- category must be exactly one of: Breakfast, Lunch, Dinner, Snack, Beverage
- glycemicIndex must be exactly one of: low, medium, high
- All number fields must be plain numbers, never strings or expressions.
[/INST]`

  console.log(`[Vision] Sending full nutritional analysis request to Cloudflare (Llama 3.2 11B Vision) for user ${slackUserId}...`);
  await emitProgress(onProgress, 35, 'Identifying meal and ingredients with AI vision...');

  const result = await runCFModel('@cf/meta/llama-3.2-11b-vision-instruct', {
    prompt: promptText,
    image: imageBytes,
    max_tokens: 2500
  }, { slackUserId, purpose: 'vision' });

  const textResponse = result.response.trim();
  
  let jsonResult;

  // Stage 1: Try direct JSON extraction from the vision model's response
  jsonResult = parseFoodAnalysisJson(textResponse);
  if (jsonResult) {
    console.log('[Vision] Stage 1 parse succeeded (direct JSON).');
  } else {
    console.warn('[Vision] Stage 1 did not find a usable JSON analysis, falling back to Stage 2...');
  }

  // Stage 2: Vision model returned markdown/prose — convert it to JSON using a fast text model
  if (!jsonResult) {
    console.log('[Vision] Stage 2: Converting vision model prose to JSON via Llama 3.1 8B...');
    await emitProgress(onProgress, 65, 'Structuring the nutrition breakdown...');
    try {
      const conversionPrompt = `[INST] You are a JSON extractor. Your ONLY output must be a single raw JSON object. No text before or after. First character must be {, last must be }.

Extract the nutritional data from the report below and fill this exact schema. Use 0 for missing numbers, [] for missing arrays, "" for missing strings.

REPORT TO EXTRACT FROM:
${textResponse}

OUTPUT THIS EXACT JSON SCHEMA (filled with data from the report):
{"foodName":"","cuisineType":"","category":"Snack","servingSize":"","ingredients":[{"name":"","quantity":""}],"macros":{"calories":0,"protein":0,"carbs":0,"fats":0,"fiber":0,"sugar":0,"saturatedFat":0,"unsaturatedFat":0},"micros":{"sodium":0,"potassium":0,"calcium":0,"iron":0,"vitaminC":0,"vitaminD":0,"vitaminB12":0,"cholesterol":0},"glycemicIndex":"medium","healthScore":5,"allergens":[],"tags":[],"insight":"","newMemoryFacts":[]}

RULES:
- ingredients: ONLY real food items. Never put nutrient names, tags, or sentences here.
- tags: ONLY short descriptors like "high-protein". Never put sentences or memory facts here.
- insight: plain text, no markdown.
- category: must be Breakfast, Lunch, Dinner, Snack, or Beverage.
- glycemicIndex: must be low, medium, or high.
- All numbers must be plain numbers.
[/INST]`

      const convResult = await runCFModel('@cf/meta/llama-3.1-8b-instruct-fp8-fast', {
        messages: [{ role: 'user', content: conversionPrompt }],
        max_tokens: 1800
      }, { slackUserId, purpose: 'vision_parse' });

      const convText = convResult.response.trim();
      jsonResult = parseFoodAnalysisJson(convText);
      if (jsonResult) {
        console.log('[Vision] Stage 2 parse succeeded (prose -> JSON conversion).');
      } else {
        throw new Error('Stage 2 conversion returned no usable JSON analysis.');
      }
    } catch (convErr) {
      console.warn('[Vision] Stage 2 parse failed, trying deterministic markdown parser:', convErr.message);
      jsonResult = normalizeFoodAnalysis(parseMarkdownFoodReport(textResponse));
      if (!hasUsableFoodAnalysis(jsonResult)) {
        console.error('[Vision] All parse stages failed. Raw response was:', textResponse);
        throw new Error('AI vision model returned an unrecognised food analysis format.');
      }
      console.log('[Vision] Stage 3 parse succeeded (deterministic markdown fallback).');
    }
  }


  // Normalise: flatten macros/micros to top-level for DB compatibility
  // while preserving the full nested structure for the Slack card
  const macros = jsonResult.macros || {};
  const micros = jsonResult.micros || {};
  jsonResult.calories        = macros.calories        ?? jsonResult.calories        ?? 0;
  jsonResult.protein         = macros.protein         ?? jsonResult.protein         ?? 0;
  jsonResult.carbs           = macros.carbs           ?? jsonResult.carbs           ?? 0;
  jsonResult.fats            = macros.fats            ?? jsonResult.fats            ?? 0;
  jsonResult.fiber           = macros.fiber           ?? jsonResult.fiber           ?? 0;
  jsonResult.sugar           = macros.sugar           ?? jsonResult.sugar           ?? 0;
  jsonResult.saturatedFat    = macros.saturatedFat    ?? jsonResult.saturatedFat    ?? 0;
  jsonResult.unsaturatedFat  = macros.unsaturatedFat  ?? jsonResult.unsaturatedFat  ?? 0;
  jsonResult.sodium          = micros.sodium          ?? jsonResult.sodium          ?? 0;
  jsonResult.potassium       = micros.potassium       ?? jsonResult.potassium       ?? 0;
  jsonResult.calcium         = micros.calcium         ?? jsonResult.calcium         ?? 0;
  jsonResult.iron            = micros.iron            ?? jsonResult.iron            ?? 0;
  jsonResult.vitaminC        = micros.vitaminC        ?? jsonResult.vitaminC        ?? 0;
  jsonResult.vitaminD        = micros.vitaminD        ?? jsonResult.vitaminD        ?? 0;
  jsonResult.vitaminB12      = micros.vitaminB12      ?? jsonResult.vitaminB12      ?? 0;
  jsonResult.cholesterol     = micros.cholesterol     ?? jsonResult.cholesterol     ?? 0;

  // Update memory if there are new facts
  if (jsonResult.newMemoryFacts && Array.isArray(jsonResult.newMemoryFacts)) {
    if (jsonResult.newMemoryFacts.length > 0) await emitProgress(onProgress, 85, 'Updating your dietician memory profile...');
    for (const fact of jsonResult.newMemoryFacts) {
      await addMemoryFact(slackUserId, fact);
    }
  }

  return jsonResult;
}


/**
 * Generate a nightly consolidated dietician report.
 */
export async function generateDailyReport(slackUserId) {
  const profile = await db.getUserProfile(slackUserId);
  const logs = await db.getUserLogs(slackUserId);
  const memoryContext = await getMemoryContext(slackUserId);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayLogs = logs.filter(log => new Date(log.timestamp) >= todayStart);

  const totalCalories = todayLogs.reduce((sum, f) => sum + f.calories, 0);
  const totalProtein = todayLogs.reduce((sum, f) => sum + (f.protein || 0), 0);
  const totalCarbs = todayLogs.reduce((sum, f) => sum + (f.carbs || 0), 0);
  const totalFats = todayLogs.reduce((sum, f) => sum + (f.fats || 0), 0);

  const waterIntake = profile.waterIntakeMl || 0;
  const waterGoal = profile.waterGoalMl || 2000;

  const foodListText = todayLogs
    .map(f => `- [${f.category}] ${f.name} (${f.calories} cal | Protein: ${f.protein}g, Carbs: ${f.carbs}g, Fats: ${f.fats}g)`)
    .join('\n');

  const promptText = `You are a supportive "co-living dietician" analyzing the user's nutrition and hydration logs for today.

User's Daily Targets:
- Calories: ${profile.dailyGoal} kcal
- Protein: ${profile.macroTargets.protein}g
- Carbs: ${profile.macroTargets.carbs}g
- Fats: ${profile.macroTargets.fats}g
- Water: ${waterGoal}ml

Today's Food Log:
${foodListText || "No food items logged today."}

Today's Totals:
- Calories: ${totalCalories} kcal (Remaining: ${profile.dailyGoal - totalCalories} kcal)
- Protein: ${totalProtein}g (Goal: ${profile.macroTargets.protein}g)
- Carbs: ${totalCarbs}g (Goal: ${profile.macroTargets.carbs}g)
- Fats: ${totalFats}g (Goal: ${profile.macroTargets.fats}g)
- Water: ${waterIntake}ml (Goal: ${waterGoal}ml)

User's Long-Term Memory Profile:
${memoryContext}

Provide a consolidated daily review. Write it in a conversational, friendly, and encouraging dietician tone.
Specifically cover:
1. A summary of how today went calorie-wise and macro-wise.
2. A professional nutritional assessment of their food quality and balance.
3. Water intake feedback — praise if on track, encourage more if behind.
4. One specific, actionable goal or focus for tomorrow.
5. Highlight any long-term patterns or milestone progress.
6. Return any NEW long-term facts or habits learned today to update their memory.

You MUST respond ONLY with a raw JSON object matching this schema. Do NOT wrap it in markdown code blocks:
{
  "reportText": "String",
  "newMemoryFacts": ["String"]
}`;

  console.log(`[Report] Generating daily report for user ${slackUserId} using Llama 3.1 8B...`);

  const result = await runCFModel('@cf/meta/llama-3.1-8b-instruct-fp8-fast', {
    messages: [{ role: 'user', content: promptText }],
    max_tokens: 1000
  }, { slackUserId, purpose: 'daily_report' });

  const textResponse = result.response.trim();
  
  let jsonResult;
  try {
    const jsonMatch = textResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonResult = JSON.parse(jsonMatch[0]);
    } else {
      throw new Error("No JSON block found.");
    }
  } catch (err) {
    console.error('[Report] Failed to parse daily report response:', err, textResponse);
    throw new Error('AI returned an invalid report format.');
  }

  // Update memory if there are new facts
  if (jsonResult.newMemoryFacts && Array.isArray(jsonResult.newMemoryFacts)) {
    for (const fact of jsonResult.newMemoryFacts) {
      await addMemoryFact(slackUserId, fact);
    }
  }

  return jsonResult.reportText;
}

/**
 * Generate a proactive dietician nudge.
 */
export async function generateProactiveNudge(slackUserId, timeOfDay) {
  const profile = await db.getUserProfile(slackUserId);
  const logs = await db.getUserLogs(slackUserId);
  const memoryContext = await getMemoryContext(slackUserId);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayLogs = logs.filter(log => new Date(log.timestamp) >= todayStart);

  const totalCalories = todayLogs.reduce((sum, f) => sum + f.calories, 0);
  const totalProtein = todayLogs.reduce((sum, f) => sum + (f.protein || 0), 0);
  const totalCarbs = todayLogs.reduce((sum, f) => sum + (f.carbs || 0), 0);
  const totalFats = todayLogs.reduce((sum, f) => sum + (f.fats || 0), 0);

  const lastMeal = todayLogs.length > 0 ? todayLogs[0] : null;
  const lastMealHoursAgo = lastMeal ? Math.round((Date.now() - new Date(lastMeal.timestamp).getTime()) / (1000 * 60 * 60)) : null;

  const promptText = `You are a supportive "co-living dietician". It is currently ${timeOfDay} (morning, afternoon, or evening).
Generate a proactive, personalized, and friendly DM for the user to keep them on track.

User's Daily Targets:
- Calories: ${profile.dailyGoal} kcal
- Protein: ${profile.macroTargets.protein}g | Carbs: ${profile.macroTargets.carbs}g | Fats: ${profile.macroTargets.fats}g
- Water: ${profile.waterGoalMl || 2000}ml

Today's Consumed So Far:
- Calories: ${totalCalories} kcal
- Protein: ${totalProtein}g | Carbs: ${totalCarbs}g | Fats: ${totalFats}g
- Water: ${profile.waterIntakeMl || 0}ml / ${profile.waterGoalMl || 2000}ml
- Meals logged: ${todayLogs.length}
${lastMealHoursAgo !== null ? `- Last meal was ${lastMealHoursAgo} hours ago` : ''}

User's Long-Term Memory Profile:
${memoryContext}

Context for this message:
- If timeOfDay is 'morning' (default 8:30 AM): Kick off their day, prompt them to log breakfast, or remind them of a focus (e.g. hydration or high protein) based on their memory habits. If no meals logged yet, encourage starting the day right.
- If timeOfDay is 'afternoon' (default 3:30 PM): Check in before snacking hours. If they typically struggle with mid-day sweet cravings or fatigue (check memory), offer a healthy alternative suggestion. If lunch hasn't been logged, gently remind them.
- If timeOfDay is 'evening' (default 7:00 PM): Analyze today's logged nutrients. Give them advice for their upcoming dinner to help hit their protein/calorie targets. If water intake is low, remind them to hydrate.
- If timeOfDay is 'report' (default 9:30 PM): Summarize the day and encourage logging any remaining meals.

Keep the message concise, encouraging, and natural (1-3 sentences). Do not use placeholders. Return ONLY the text of the message.`;

  try {
    const result = await runCFModel('@cf/meta/llama-3.1-8b-instruct-fp8-fast', {
      messages: [{ role: 'user', content: promptText }],
      max_tokens: 300
    }, { slackUserId, purpose: 'nudge' });

    return result.response.trim();
  } catch (err) {
    console.error(`[Nudge] Failed to generate ${timeOfDay} nudge:`, err.message);
    return null;
  }
}

export async function generateWaterReminder(slackUserId) {
  const profile = await db.getUserProfile(slackUserId);
  const intake = profile.waterIntakeMl || 0;
  const goal = profile.waterGoalMl || 2000;
  const remaining = goal - intake;
  const pct = Math.round((intake / goal) * 100);

  if (remaining <= 0) return null;

  const promptText = `You are a supportive "co-living dietician". Send a brief, friendly water reminder to the user.

Current water intake: ${intake}ml / ${goal}ml (${pct}% complete)
Remaining: ${remaining}ml

User's memory context (habits, preferences):
${await getMemoryContext(slackUserId)}

Generate a short, encouraging 1-sentence water reminder. Be specific about how much more they need. Use emojis. Return ONLY the message text.`;

  try {
    const result = await runCFModel('@cf/meta/llama-3.1-8b-instruct-fp8-fast', {
      messages: [{ role: 'user', content: promptText }],
      max_tokens: 150
    }, { slackUserId, purpose: 'water_reminder' });
    return result.response.trim();
  } catch (err) {
    console.error(`[Water] Failed to generate water reminder:`, err.message);
    return null;
  }
}

export async function generateMissedMealNudge(slackUserId) {
  const logs = await db.getUserLogs(slackUserId);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayLogs = logs.filter(log => new Date(log.timestamp) >= todayStart);

  const hour = new Date().getHours();
  let missedMeal = null;
  if (hour >= 10 && todayLogs.filter(l => l.category === 'Breakfast').length === 0) missedMeal = 'Breakfast';
  else if (hour >= 14 && todayLogs.filter(l => l.category === 'Lunch').length === 0) missedMeal = 'Lunch';
  else if (hour >= 20 && todayLogs.filter(l => l.category === 'Dinner').length === 0) missedMeal = 'Dinner';

  if (!missedMeal) return null;

  const promptText = `You are a supportive "co-living dietician". The user has missed logging ${missedMeal} today.

Current time: ${hour}:00
Meals logged today: ${todayLogs.map(l => l.category).join(', ') || 'None'}

User's memory context:
${await getMemoryContext(slackUserId)}

Generate a gentle, non-judgmental 1-sentence reminder to log their ${missedMeal}. Be helpful, not pushy. Return ONLY the message text.`;

  try {
    const result = await runCFModel('@cf/meta/llama-3.1-8b-instruct-fp8-fast', {
      messages: [{ role: 'user', content: promptText }],
      max_tokens: 150
    }, { slackUserId, purpose: 'missed_meal' });
    return result.response.trim();
  } catch (err) {
    console.error(`[MissedMeal] Failed to generate missed meal nudge:`, err.message);
    return null;
  }
}

