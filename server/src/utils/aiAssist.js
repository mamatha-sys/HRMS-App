// AI Assist — small AI helpers that suggest form content across a few modules (Assets,
// Recruitment, Announcements) plus the chat assistant widget. Runs against a LOCAL Ollama
// instance (https://ollama.com) instead of a cloud API — no account, no API key, no per-request
// cost, no internet dependency once the model is pulled. Same "optional integration, clear error
// if unavailable" shape as sendEmail/sendSms/sendWhatsapp in channels.js: never crashes at import
// time, throws a catchable, specific message if Ollama isn't running.
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
// Tried llama3.1:8b as a quality upgrade — reverted. On this machine's CPU (no GPU, dual-core
// i5-7300U) it took 90-100s per offer-letter-length generation (vs 3b's 10-30s) and, worse, it
// reintroduced the exact bracketed-placeholder hallucination ([Company Address], [Date]) that was
// already fixed for 3b — the bigger model did not actually raise quality on this hardware/prompt.
// Revisit only with real GPU acceleration available.
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2:3b';

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// Cheap health probe backing the global "AI status" indicator (Topbar + chat panel) — every AI
// feature in this file otherwise fails silently from the end user's point of view (a background
// job that never lands, a chat reply that just errors) with no way to tell "Ollama isn't running"
// from "the model is just slow". Cached briefly since multiple open tabs/pages poll this.
let statusCache = null;
const STATUS_CACHE_MS = 15000;

export async function checkAiStatus() {
  if (statusCache && Date.now() - statusCache.checkedAt < STATUS_CACHE_MS) return statusCache;
  let available = false;
  let modelPulled = false;
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      available = true;
      const data = await res.json();
      modelPulled = Array.isArray(data.models) && data.models.some((m) => m.name === OLLAMA_MODEL || m.model === OLLAMA_MODEL);
    }
  } catch {
    available = false;
  }
  statusCache = { available, modelPulled, model: OLLAMA_MODEL, checkedAt: Date.now() };
  return statusCache;
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

// Single-prompt completion, used by the suggest* form helpers below (exported for the rare
// caller outside this file that needs true single-shot JSON extraction rather than a
// conversational reply — see documentVerify.js's verifyDocumentFields, which switched to this
// from chatWithAssistant after testing showed /api/chat's freeform reply mode was unreliable at
// returning a fixed-length JSON array for every field asked about, silently dropping entries).
export async function askOllama(prompt, maxTokens) {
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
export function parseJsonReply(text) {
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

// Drafts a warm festival/occasion greeting — distinct from suggestAnnouncementBody below (which
// writes plain operational notices like "office closed"): this is meant to read like a genuine
// greeting from company leadership, sent to every employee's inbox, not a policy/logistics notice.
// The occasion name is the only fact the model may state as real (never invents a date/holiday
// detail), same "no invented specifics" guardrail as the offer letter prompt.
export async function generateFestivalGreeting({ occasionName, companyName }) {
  if (!occasionName?.trim()) throw new Error('An occasion name is required (e.g. Diwali, Independence Day, New Year)');

  const prompt = `Write a warm, genuine festival/occasion greeting message from a company to all of its employees, for the occasion of "${occasionName.trim()}".

This should read like a heartfelt greeting from company leadership, not a policy notice — celebratory and warm, thanking employees for their contributions, wishing them and their families well for the occasion. 3-5 sentences, plain text, no markdown, no bracketed placeholders (no [Company Name], no [Date], no [Your Name]). Sign off as "${companyName?.trim() || 'the Company'} Leadership Team" — never a placeholder for an individual's name. Do not invent any specific company policy, holiday date, or detail beyond the occasion name itself. Respond with ONLY the greeting text, nothing else.`;

  const text = await askOllama(prompt, 350);
  if (!text) throw new Error('AI could not draft a greeting — please write it manually.');
  return { title: `${occasionName.trim()} Greetings from ${companyName?.trim() || 'the Company'}!`, body: text };
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

// Suggests a first-response answer for a newly raised helpdesk ticket. Grounded the same way as
// the chat assistant: real company Knowledge Base articles (if any match the ticket's category)
// are handed over as the ONLY source of specific company facts/policy — the model is explicitly
// told not to invent a specific policy, number, or procedure that isn't in them, falling back to
// generic troubleshooting guidance instead. This runs automatically right after a ticket is
// created (never blocks it — caller wraps this in try/catch) so the requester sees a candidate
// answer immediately, which they then accept (resolves the ticket) or reject (escalates it).
export async function suggestTicketAnswer(category, subject, description, kbArticles) {
  if (!subject?.trim()) throw new Error('A subject is required');

  const kbBlock = kbArticles?.length
    ? kbArticles.map((a) => `- "${a.title}": ${a.body}`).join('\n')
    : '(no matching knowledge base articles on file)';

  const prompt = `You are a helpdesk assistant for a company's internal HR system. An employee just raised this ${category} ticket:
Subject: ${subject.trim()}
Description: ${description?.trim() || '(no further description given)'}

Relevant company Knowledge Base articles (the ONLY source you may treat as company-specific fact):
${kbBlock}

Write a short, helpful first-response answer (3-6 sentences, plain text, no markdown). If the Knowledge Base articles above answer this, use them directly and don't contradict them. If they don't cover it, give generic, safe troubleshooting/guidance for this kind of issue, but do NOT invent a specific company policy, number, deadline, or procedure that isn't in the articles above — say the employee may need HR/IT to follow up on those specifics instead. Respond with ONLY the answer text, nothing else.`;

  const text = await askOllama(prompt, 350);
  if (!text) throw new Error('AI Assist returned an empty response.');
  return text;
}

// Drafts an offer letter once a candidate reaches the Offer stage. The candidate name, position,
// department, offered CTC, and joining date are the ONLY facts the model may state as real —
// they're HR-typed, authoritative figures (see recruitment.routes.js's /advance handler), never
// guessed by the model itself. The model's job is purely to write the professional prose around
// them — standard offer-letter boilerplate (subject to background verification, etc.) is fine as
// generic language, but it must not invent a different number, date, or specific company policy
// detail (probation length, notice period, benefits specifics) that wasn't given to it.
export async function generateOfferLetter({ candidateName, positionTitle, department, offeredCtc, joiningDate, companyName }) {
  if (!candidateName?.trim() || !positionTitle?.trim()) throw new Error('Candidate name and position are required');
  if (!offeredCtc?.trim() || !joiningDate?.trim()) throw new Error('Offered CTC and joining date are required');

  const prompt = `Write a formal, professional job offer letter with these exact facts — do not change or invent any of them:
Candidate: ${candidateName.trim()}
Position: ${positionTitle.trim()}${department?.trim() ? `\nDepartment: ${department.trim()}` : ''}
Offered CTC: ${offeredCtc.trim()}
Joining Date: ${joiningDate.trim()}
Company: ${companyName?.trim() || 'the company'}

Structure: a warm congratulatory opening, a short paragraph stating the role/department/CTC/joining date exactly as given above, brief standard generic offer-letter language (the offer is subject to standard background/document verification, and that further terms will be covered in the formal employment agreement — do NOT state a specific probation length, notice period, or benefit detail, since none was given to you), and a closing line asking them to confirm acceptance. Sign off as "${companyName?.trim() || 'the Company'} HR Team" — never a placeholder for an individual's name. Plain text only, no markdown, and no bracketed placeholders anywhere (no [Company Address], no [Your Name], no [Date]) — write it as a finished, ready-to-send letter, omitting any detail you don't actually have rather than leaving a placeholder for it. Respond with ONLY the letter text, nothing else.`;

  const text = await askOllama(prompt, 600);
  if (!text) throw new Error('AI Assist returned an empty response — please write the offer letter manually.');
  return text;
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

// Knowledge Transfer — Weekly Idea Contribution. Checks a newly-submitted idea against every
// existing APPROVED idea on file (capped by the caller, see ideas.routes.js) for duplication —
// judged on substance ("the same underlying suggestion", not just similar wording), not exact
// text match, since that's cheap enough to do without AI. Defaults to "not a duplicate" if the
// model/JSON output misbehaves, rather than blocking a legitimate new idea over a formatting
// hiccup — a false negative here just means an actual duplicate slips through occasionally,
// which is a far smaller cost than incorrectly blocking every submission when Ollama is flaky.
export async function checkIdeaDuplicate(title, description, existingIdeas) {
  if (!existingIdeas?.length) return { isDuplicate: false, duplicateOfId: null, reason: '' };

  const list = existingIdeas.map((idea, i) => `${i + 1}. "${idea.title}": ${idea.description.slice(0, 300)}`).join('\n');
  const prompt = `You are screening employee-submitted ideas for improving an internal company HRMS (HR system) for duplicates, as part of a weekly innovation program.

NEW idea just submitted:
Title: "${title}"
Description: ${description}

EXISTING ideas already on file (numbered):
${list}

Decide if the NEW idea is a duplicate or highly similar in SUBSTANCE to any EXISTING idea — the same underlying suggestion counts as a duplicate even if worded completely differently; a genuinely different idea about a similar general area (e.g. two different ideas both about "improving Attendance") is NOT a duplicate. Respond with ONLY a single JSON object, no markdown:
{"is_duplicate": true or false, "duplicate_number": <the number from the list above it matches, or null if not a duplicate>, "reason": "<one sentence explaining the decision>"}`;

  try {
    const parsed = parseJsonReply(await askOllama(prompt, 200));
    const isDuplicate = parsed.is_duplicate === true;
    const idx = Number(parsed.duplicate_number);
    const matched = isDuplicate && Number.isFinite(idx) && existingIdeas[idx - 1] ? existingIdeas[idx - 1] : null;
    return { isDuplicate: !!matched, duplicateOfId: matched?.id ?? null, reason: parsed.reason?.toString().trim() || '' };
  } catch {
    return { isDuplicate: false, duplicateOfId: null, reason: '' };
  }
}

// Scores a unique idea on 5 named dimensions (0-100 each) plus one overall figure — these are
// the ONLY numbers ever stored for an idea (never hand-edited by HR, same "AI-graded, not
// manually overridable" rule as interview scoring above). Falls back to a neutral all-50 score
// with a clear "needs manual review" note if the model/JSON output misbehaves, rather than
// leaving the submission with no score at all.
export async function scoreIdea(title, description) {
  const prompt = `You are evaluating an employee-submitted idea for improving an internal company HRMS (HR system), as part of a weekly employee innovation program.

Idea title: "${title}"
Idea description: ${description}

Score this idea on exactly these 5 dimensions, each an integer 0-100:
- originality: how novel/non-obvious is this suggestion?
- usefulness: how genuinely useful would this be in practice?
- impact: how much positive difference could this make for employees or the company?
- clarity: how clearly and specifically is the idea explained (vague ideas score low here even if the concept is good)?
- feasibility: how realistic and practical would this be to actually build?

Then give one overall score 0-100 (your own holistic judgment — not required to be a plain average of the five) and one short sentence of constructive feedback.

Respond with ONLY a single JSON object, no markdown:
{"originality": <int>, "usefulness": <int>, "impact": <int>, "clarity": <int>, "feasibility": <int>, "overall": <int>, "feedback": "<one sentence>"}`;

  const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n))));
  try {
    const parsed = parseJsonReply(await askOllama(prompt, 300));
    const scores = ['originality', 'usefulness', 'impact', 'clarity', 'feasibility', 'overall'].map((k) => clamp(parsed[k]));
    if (scores.some((n) => !Number.isFinite(n))) throw new Error('incomplete scores');
    const [originality, usefulness, impact, clarity, feasibility, overall] = scores;
    return { originality, usefulness, impact, clarity, feasibility, overall, feedback: parsed.feedback?.toString().trim() || '' };
  } catch {
    return {
      originality: 50, usefulness: 50, impact: 50, clarity: 50, feasibility: 50, overall: 50,
      feedback: 'AI scoring did not return a usable result for this idea — treat this as a placeholder score, not a real assessment.'
    };
  }
}

// The AI Agent's planning step — unlike chatWithAssistant (which only ever produces a reply the
// user reads), this decides whether the user's message maps to one of a small fixed set of
// ACTIONS the agent can execute on their behalf, and if so extracts its parameters. It never
// executes anything itself — the route layer always shows the human the proposed action and
// waits for an explicit confirm click before calling the real API. Returns a plain object, never
// throws for a "no clear action" case (falls back to a clarify action) — only throws if Ollama
// itself is unreachable, same as the other helpers here.
export async function planAgentAction(system, history) {
  if (!history?.length) throw new Error('No message to plan from');
  const data = await callOllama('/api/chat', { messages: [{ role: 'system', content: system }, ...history], format: 'json' });
  const text = data.message?.content?.trim() || '';
  let parsed;
  try {
    parsed = parseJsonReply(text);
  } catch {
    return { action: 'clarify', params: {}, summary: "I couldn't work out a clear action from that — could you rephrase, e.g. \"apply for 2 days casual leave from Monday to Tuesday, reason: family function\"?" };
  }
  const ALLOWED = ['submit_leave', 'approve_request', 'reject_request', 'request_profile_edit', 'post_announcement', 'clarify'];
  if (!ALLOWED.includes(parsed.action)) {
    return { action: 'clarify', params: {}, summary: "I couldn't work out a clear action from that — could you rephrase?" };
  }
  return { action: parsed.action, params: parsed.params && typeof parsed.params === 'object' ? parsed.params : {}, summary: parsed.summary?.toString().trim() || 'Please confirm this action.' };
}

// Explains WHY payroll changed month-over-month — the actual totals/deltas are always computed
// server-side from real payslip rows (never by the model), this only narrates the reasons behind
// numbers it's handed: headcount changes, LOP/late deductions, and the biggest individual swings.
// Falls back to a plain templated summary (still fact-based, no AI) rather than leaving the screen
// blank if the model/JSON output misbehaves.
export async function explainPayrollComparison(current, previous, details) {
  const netDelta = current.totalNet - previous.totalNet;
  const pctDelta = previous.totalNet ? Math.round((netDelta / previous.totalNet) * 1000) / 10 : null;

  const prompt = `You are explaining a month-over-month payroll comparison to an HR admin. Here are the real, already-computed facts — do not invent any other numbers:

${previous.month}: ${previous.headcount} employees paid, total net payout ₹${previous.totalNet.toLocaleString('en-IN')}, total deductions ₹${previous.totalDeductions.toLocaleString('en-IN')} (LOP ₹${previous.totalLop.toLocaleString('en-IN')}, late-arrival ₹${previous.totalLate.toLocaleString('en-IN')}).
${current.month}: ${current.headcount} employees paid, total net payout ₹${current.totalNet.toLocaleString('en-IN')}, total deductions ₹${current.totalDeductions.toLocaleString('en-IN')} (LOP ₹${current.totalLop.toLocaleString('en-IN')}, late-arrival ₹${current.totalLate.toLocaleString('en-IN')}).
Net payout change: ${netDelta >= 0 ? '+' : ''}₹${netDelta.toLocaleString('en-IN')}${pctDelta !== null ? ` (${pctDelta >= 0 ? '+' : ''}${pctDelta}%)` : ''}.
New hires paid this month who weren't paid last month: ${details.newHires.length ? details.newHires.join(', ') : 'none'}.
Employees paid last month but not this month (exited/inactive): ${details.exited.length ? details.exited.join(', ') : 'none'}.
Biggest individual net-pay changes among employees paid both months: ${details.biggestChanges.length ? details.biggestChanges.map((c) => `${c.name} ${c.delta >= 0 ? '+' : ''}₹${c.delta.toLocaleString('en-IN')}`).join(', ') : 'none significant'}.

Write a short 2-4 sentence explanation of WHY the total payroll moved the way it did, referencing only the facts above (headcount changes, deduction changes, individual swings). Do not restate every number — synthesize the likely reason. Respond with ONLY the explanation text, no markdown, no preamble.`;

  try {
    const text = await askOllama(prompt, 300);
    if (text) return text;
  } catch {
    // fall through to the templated fallback below
  }
  const parts = [];
  if (details.newHires.length) parts.push(`${details.newHires.length} new hire(s) added to payroll (${details.newHires.join(', ')})`);
  if (details.exited.length) parts.push(`${details.exited.length} employee(s) no longer on payroll (${details.exited.join(', ')})`);
  if (current.totalLop !== previous.totalLop) parts.push(`LOP deductions ${current.totalLop > previous.totalLop ? 'increased' : 'decreased'} to ₹${current.totalLop.toLocaleString('en-IN')}`);
  return `Net payout ${netDelta >= 0 ? 'increased' : 'decreased'} by ₹${Math.abs(netDelta).toLocaleString('en-IN')}${pctDelta !== null ? ` (${Math.abs(pctDelta)}%)` : ''} from ${previous.month} to ${current.month}.${parts.length ? ' Likely driven by: ' + parts.join('; ') + '.' : ''}`;
}
