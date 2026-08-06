// AI Assist (Asset Management > Add Asset) — given just an asset name, suggests Category,
// estimated Cost, and a Warranty Expiry date. Same "optional external integration, clear error if
// unconfigured" shape as sendEmail/sendSms/sendWhatsapp in channels.js: never crashes at import
// time, throws a catchable, specific message if the API key is missing.
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'; // fast/cheap — this is a small structured lookup, not a conversation

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function addMonthsIso(dateIso, months) {
  const d = new Date(dateIso + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

// Suggests { category, cost, warranty_expiry } for a new asset from its name alone. The model is
// asked for a category and a typical cost/warranty-length for that KIND of asset — never a real
// serial number (that's specific to the one physical unit being registered, not something any
// model could know), so the caller/form always leaves serial number for the human to fill in.
export async function suggestAssetInfo(assetName) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('AI Assist is not configured — set ANTHROPIC_API_KEY in server/.env');
  if (!assetName?.trim()) throw new Error('Enter an asset name first');

  const prompt = `You are helping an HR/IT admin fill in a company asset register. Given the asset name "${assetName.trim()}", respond with ONLY a single JSON object (no markdown, no explanation) with exactly these keys:
{"category": "<short category, e.g. Laptop, Monitor, Office Chair, Mobile Phone>", "estimated_cost_inr": <typical cost in Indian Rupees as a plain integer, no commas or currency symbol>, "warranty_months": <typical manufacturer warranty length in whole months as a plain integer, e.g. 12>}
If the name is too vague to identify a real product category, make your best reasonable guess for a generic office/IT asset rather than refusing.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`AI Assist request failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  const data = await res.json();
  const text = data.content?.[0]?.text?.trim() || '';
  let parsed;
  try {
    // The model is instructed to return raw JSON, but defensively strip a ```json fence if one
    // slips through anyway rather than failing the whole request over formatting.
    const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('AI Assist returned an unexpected response — please fill in the fields manually.');
  }

  const cost = Number.isFinite(Number(parsed.estimated_cost_inr)) ? Math.max(0, Math.round(Number(parsed.estimated_cost_inr))) : null;
  const warrantyMonths = Number.isFinite(Number(parsed.warranty_months)) ? Math.max(0, Math.round(Number(parsed.warranty_months))) : 0;
  return {
    category: parsed.category?.toString().trim() || null,
    cost,
    warranty_expiry: warrantyMonths > 0 ? addMonthsIso(todayIso(), warrantyMonths) : null
  };
}
