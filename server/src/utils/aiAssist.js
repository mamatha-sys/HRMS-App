// AI Assist — small AI helpers that suggest form content across a few modules (Assets,
// Recruitment, Announcements) plus the chat assistant widget. Runs against a LOCAL Ollama
// instance (https://ollama.com) instead of a cloud API — no account, no API key, no per-request
// cost, no internet dependency once the model is pulled. Same "optional integration, clear error
// if unavailable" shape as sendEmail/sendSms/sendWhatsapp in channels.js: never crashes at import
// time, throws a catchable, specific message if Ollama isn't running.
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2:3b';

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function addMonthsIso(dateIso, months) {
  const d = new Date(dateIso + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

// Shared fetch/error-shape logic for both the single-prompt and chat helpers below. A connection
// failure (Ollama not running) gets turned into one clear, actionable message instead of a raw
// ECONNREFUSED stack — everything else about the shape mirrors the old cloud-API version.
async function callOllama(path, body) {
  let res;
  try {
    res = await fetch(`${OLLAMA_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, stream: false, ...body })
    });
  } catch {
    throw new Error('Local AI is not running — start Ollama on this machine and try again.');
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`AI request failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  return res.json();
}

// Single-prompt completion, used by the suggest* form helpers below.
async function askOllama(prompt, maxTokens) {
  const data = await callOllama('/api/generate', { prompt, options: { num_predict: maxTokens } });
  return data.response?.trim() || '';
}

// Multi-turn variant for the chat assistant widget — takes a system prompt (grounding facts about
// the current user, built server-side) plus the running message history ({role: 'user'|'assistant',
// content} pairs), and returns the next assistant reply as plain conversational text. Ollama's
// /api/chat uses the same role names we already use internally, so no remapping is needed.
export async function chatWithAssistant(system, history) {
  if (!history?.length) throw new Error('No message to reply to');

  const data = await callOllama('/api/chat', { messages: [{ role: 'system', content: system }, ...history] });
  const text = data.message?.content?.trim() || '';
  if (!text) throw new Error('The assistant returned an empty response — please try rephrasing.');
  return text;
}

// The model is instructed to return raw JSON, but this defensively strips a ```json fence if one
// slips through anyway rather than failing the whole request over formatting.
function parseJsonReply(text) {
  const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(jsonText);
  } catch {
    throw new Error('AI Assist returned an unexpected response — please fill in the fields manually.');
  }
}

// Suggests { category, cost, warranty_expiry } for a new asset from its name alone. The model is
// asked for a category and a typical cost/warranty-length for that KIND of asset — never a real
// serial number (that's specific to the one physical unit being registered, not something any
// model could know), so the caller/form always leaves serial number for the human to fill in.
export async function suggestAssetInfo(assetName) {
  if (!assetName?.trim()) throw new Error('Enter an asset name first');

  const prompt = `You are helping an HR/IT admin fill in a company asset register. Given the asset name "${assetName.trim()}", respond with ONLY a single JSON object (no markdown, no explanation) with exactly these keys:
{"category": "<short category, e.g. Laptop, Monitor, Office Chair, Mobile Phone>", "estimated_cost_inr": <typical cost in Indian Rupees as a plain integer, no commas or currency symbol>, "warranty_months": <typical manufacturer warranty length in whole months as a plain integer, e.g. 12>}
If the name is too vague to identify a real product category, make your best reasonable guess for a generic office/IT asset rather than refusing.`;

  const parsed = parseJsonReply(await askOllama(prompt, 200));

  const cost = Number.isFinite(Number(parsed.estimated_cost_inr)) ? Math.max(0, Math.round(Number(parsed.estimated_cost_inr))) : null;
  const warrantyMonths = Number.isFinite(Number(parsed.warranty_months)) ? Math.max(0, Math.round(Number(parsed.warranty_months))) : 0;
  return {
    category: parsed.category?.toString().trim() || null,
    cost,
    warranty_expiry: warrantyMonths > 0 ? addMonthsIso(todayIso(), warrantyMonths) : null
  };
}

// Suggests a job description for a new position from its title (+ optional department name).
// Plain text, not JSON — a description is prose, not structured data, so there's nothing to parse.
export async function suggestJobDescription(title, departmentName) {
  if (!title?.trim()) throw new Error('Enter a position title first');

  const context = departmentName?.trim() ? ` in the ${departmentName.trim()} department` : '';
  const prompt = `Write a professional job description for an open position titled "${title.trim()}"${context}. Include a short intro line, then "Responsibilities" and "Requirements" as plain-text sections with hyphen bullet points (no markdown headers, no asterisks/bold). Keep it concise — under 200 words total. Respond with ONLY the job description text, nothing else.`;

  const text = await askOllama(prompt, 500);
  if (!text) throw new Error('AI Assist returned an empty response — please write the description manually.');
  return { job_description: text };
}

// Suggests an announcement body from its title (+ category). Plain text, same reasoning as above.
export async function suggestAnnouncementBody(title, category) {
  if (!title?.trim()) throw new Error('Enter a title first');

  const categoryHint = category?.trim() ? ` This is a "${category.trim()}" category announcement.` : '';
  const prompt = `Write a short internal company announcement for employees with the title "${title.trim()}".${categoryHint} Keep a clear, professional, friendly tone. 2-4 sentences, plain text, no markdown formatting. Respond with ONLY the announcement body text, nothing else.`;

  const text = await askOllama(prompt, 300);
  if (!text) throw new Error('AI Assist returned an empty response — please write the announcement manually.');
  return { body: text };
}

// Generates the fixed question set for a candidate's AI video interview, from the position's
// title (+ job description, if one was written). Generated once when the interview is created —
// every candidate for that same interview record answers the same questions, so scores are
// comparable. Falls back to generic questions if the model/JSON parsing fails, rather than
// blocking the invite entirely over a formatting hiccup.
export async function generateInterviewQuestions(jobTitle, jobDescription) {
  if (!jobTitle?.trim()) throw new Error('Job title is required to generate interview questions');

  const jdContext = jobDescription?.trim() ? `\n\nJob description:\n${jobDescription.trim().slice(0, 1000)}` : '';
  const prompt = `You are preparing a first-round video interview for a "${jobTitle.trim()}" position.${jdContext}

Write exactly 5 interview questions: the first should be a short "tell me about yourself" style opener, the next 3 should be specific to the role's actual responsibilities/skills (not generic), and the last should be a general communication/behavioral question (e.g. handling a challenge or working with a team). Each question should be answerable out loud in under 90 seconds.

Respond with ONLY a JSON array of 5 plain strings, no markdown, no explanation, no numbering — e.g. ["question one", "question two", ...]`;

  try {
    const parsed = parseJsonReply(await askOllama(prompt, 500));
    const questions = Array.isArray(parsed) ? parsed.map((q) => q?.toString().trim()).filter(Boolean) : [];
    if (questions.length >= 3) return questions.slice(0, 6);
  } catch {
    // fall through to the generic set below
  }
  return [
    `Tell me a bit about yourself and why you're interested in the ${jobTitle.trim()} role.`,
    'Walk me through a project or piece of work you\'re proud of that\'s relevant to this role.',
    'What skills or experience make you a good fit for this position?',
    'Describe a challenge you faced at work and how you handled it.',
    'Do you have any questions about the role, or anything else you\'d like us to know?'
  ];
}

// Scores a completed interview from its full question/transcript pairs against the role — the AI
// only ever sees the TEXT transcript (our local model has no vision), never the video itself, so
// scoring reflects content/communication in what was said, not anything visual. Always returns a
// usable result (falls back to a neutral "needs manual review" score) rather than leaving HR with
// nothing if the model/JSON output misbehaves on a particular transcript.
export async function scoreInterviewTranscript(jobTitle, jobDescription, qaPairs) {
  if (!qaPairs?.length) throw new Error('No answers to score');

  const jdContext = jobDescription?.trim() ? `\n\nJob description:\n${jobDescription.trim().slice(0, 1000)}` : '';
  const transcript = qaPairs.map((qa, i) => `Q${i + 1}: ${qa.question}\nA${i + 1}: ${qa.transcript?.trim() || '(no speech was captured for this answer)'}`).join('\n\n');
  const prompt = `You are an HR interviewer evaluating a candidate's first-round video interview transcript for a "${jobTitle?.trim() || 'open'}" position.${jdContext}

Transcript (candidate's spoken answers, transcribed automatically — expect some transcription noise):
${transcript.slice(0, 4000)}

Score this candidate on two separate dimensions:
1. Overall fit for the role (0-100) — based on the substance/relevance of what they said.
2. Communication (0-100) — how clearly, concisely, and confidently they expressed themselves (independent of technical correctness).

Then give a plain eligibility recommendation: is this candidate worth advancing to the next round? Treat 60 as a rough passing threshold on overall fit, but use judgment — a strong communicator with real substance should pass even at a slightly lower raw number, and someone with major red flags shouldn't pass even with a high number.

Respond with ONLY a single JSON object, no markdown, no explanation:
{"score": <integer 0-100, overall fit>, "communication_score": <integer 0-100>, "eligible": <true or false>, "summary": "<2-3 sentence overall assessment>", "strengths": "<short comma-separated list>", "concerns": "<short comma-separated list, or 'None noted' if there aren't any>"}`;

  try {
    const parsed = parseJsonReply(await askOllama(prompt, 400));
    const score = Number.isFinite(Number(parsed.score)) ? Math.max(0, Math.min(100, Math.round(Number(parsed.score)))) : null;
    if (score === null) throw new Error('no score');
    const communicationScore = Number.isFinite(Number(parsed.communication_score)) ? Math.max(0, Math.min(100, Math.round(Number(parsed.communication_score)))) : null;
    return {
      score,
      communicationScore,
      eligible: typeof parsed.eligible === 'boolean' ? parsed.eligible : score >= 60,
      summary: parsed.summary?.toString().trim() || '',
      strengths: parsed.strengths?.toString().trim() || '',
      concerns: parsed.concerns?.toString().trim() || ''
    };
  } catch {
    return { score: null, communicationScore: null, eligible: null, summary: 'AI scoring did not return a usable result for this transcript — please review the answers manually.', strengths: '', concerns: '' };
  }
}
