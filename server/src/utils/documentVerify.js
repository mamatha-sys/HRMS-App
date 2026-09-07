// tesseract.js's ESM named exports aren't statically detectable from its CJS build, so import the
// namespace and destructure at runtime instead of `import { recognize } from 'tesseract.js'`.
import Tesseract from 'tesseract.js';
const { recognize } = Tesseract;
import { askOllama, parseJsonReply } from './aiAssist.js';

// Reads a base64 data URL (the same storage shape used for employee documents/photos) into a
// Buffer that tesseract.js can OCR directly.
export function bufferFromDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) throw new Error('Not a valid file');
  return { mime: match[1], buffer: Buffer.from(match[2], 'base64') };
}

// ID/account numbers (Aadhaar, PAN, passport, bank account, employee ID, etc.) are judged
// DETERMINISTICALLY rather than by the AI — testing showed the local 3B model's digit-level
// comparison is genuinely unreliable (it flip-flopped match:true/false for the exact same
// correct-vs-wrong-number inputs across repeated calls, which is unacceptable for anything
// billed as verification). A plain normalized-substring check is slower to forgive OCR noise but
// never contradicts itself.
function isIdNumberLabel(label) {
  return /\b(number|no\.?|id|aadhaar|pan|account)\b/i.test(label);
}
function normalizeAlnum(s) {
  return (s || '').toString().toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function deterministicIdMatch(value, extractedText) {
  const needle = normalizeAlnum(value);
  if (needle.length < 4) return null; // too short to trust a substring check either way
  return normalizeAlnum(extractedText).includes(needle);
}

// Name fields are ALSO judged deterministically, not by the AI — testing found the model marking
// a completely different typed name as a "match" against the document (it appears to pattern
// -match "this looks like a plausible name" rather than actually compare the two names). A
// word-overlap check is more literal than true semantic matching (won't catch e.g. a maiden-name
// vs married-name change) but, unlike the AI, it never claims two different names are the same.
function isNameLabel(label) {
  return /\bname\b/i.test(label);
}
function normalizeWords(s) {
  return (s || '').toString().toUpperCase().replace(/[^A-Z\s]/g, ' ').split(/\s+/).filter(Boolean);
}
function deterministicNameMatch(value, extractedText) {
  const words = normalizeWords(value);
  if (!words.length) return null;
  const textWords = new Set(normalizeWords(extractedText));
  const foundCount = words.filter((w) => textWords.has(w)).length;
  return foundCount / words.length >= 0.6; // allow a missing middle name / minor OCR noise
}

// Cross-checks EVERY relevant typed field against the text OCR'd from an uploaded document — a
// best-effort consistency check, NOT identity/fraud verification. It can only tell you whether
// what was typed shows up in the document's text; it has no way to confirm the document itself is
// genuine or unaltered. Which fields are "relevant" is decided by the caller based on the
// document's own type (see relevantFieldsFor in Employees.jsx — an Aadhaar Card checks name +
// Aadhaar number + date of birth, a PAN Card checks name + PAN number, etc.) — this function just
// checks whatever field/value pairs it's handed against the OCR'd text, one verdict per field.
export async function verifyDocumentFields(documentLabel, fields, documentDataUrl) {
  const entries = Object.entries(fields || {}).filter(([, v]) => v?.toString().trim());
  if (!entries.length) throw new Error('Enter the relevant details on the form first (name, ID number, date of birth, etc.)');
  if (!documentDataUrl) throw new Error('No document to verify');

  const { mime, buffer } = bufferFromDataUrl(documentDataUrl);
  if (mime === 'application/pdf') {
    throw new Error('PDF documents can\'t be read for verification yet — please verify this one manually, or re-upload it as an image (JPG/PNG) to use AI verification.');
  }

  const { data } = await recognize(buffer, 'eng');
  const extractedText = (data?.text || '').trim();
  if (!extractedText) {
    return {
      results: entries.map(([label]) => ({ label, match: null, note: '' })),
      overallNote: 'Could not read any text from this document — it may be too blurry, low-resolution, or handwritten. Please check it manually.',
      extractedText: ''
    };
  }

  const isDeterministicLabel = (label) => isIdNumberLabel(label) || isNameLabel(label);
  const normalize = (s) => (s || '').toString().trim().toLowerCase();
  const deterministicEntries = entries.filter(([label]) => isDeterministicLabel(label));
  const aiEntries = entries.filter(([label]) => !isDeterministicLabel(label));

  const deterministicResults = {};
  deterministicEntries.forEach(([label, value]) => {
    const match = isNameLabel(label) ? deterministicNameMatch(value, extractedText) : deterministicIdMatch(value, extractedText);
    deterministicResults[normalize(label)] = {
      match,
      note: match === null ? 'Value too short to check reliably' : match ? 'Found in document' : 'Not found in document text'
    };
  });

  let aiByNormalizedLabel = {};
  let aiOverallNote = '';
  if (aiEntries.length) {
    const fieldsList = aiEntries.map(([label, value]) => `- ${label}: "${value.toString().trim()}"`).join('\n');
    const prompt = `An HR system extracted this text from a scanned "${documentLabel || 'employee document'}" via OCR (so it may contain scan noise/typos):

"""
${extractedText.slice(0, 1500)}
"""

The employee typed these details into the HR form. For EACH one, decide whether the document's text plausibly contains/supports it (allowing for OCR noise, spacing/punctuation differences, minor formatting variation, or name order differences — e.g. "John A. Smith" matching "Smith John A"). A field the document type wouldn't reasonably contain (e.g. no date of birth printed on this kind of document at all) should be reported as match: false with a note saying so, not skipped.

${fieldsList}

Respond with ONLY a single JSON object, no markdown, no explanation. Keep every "note" under 6 words. "results" MUST have exactly ${aiEntries.length} entries, one per field listed above, in the same order — do not omit any field:
{"results": [{"label": "<field label exactly as given above>", "match": true or false, "note": "<reason, max 6 words>"}], "overallNote": "<one sentence overall summary>"}`;

    // Small local models occasionally drop entries from the results array even with a valid
    // overallNote proving they judged every field correctly, so retry once with a more emphatic
    // reminder before giving up on any field that didn't come back — reproduced during testing on
    // a mismatch case where fields were silently missing from the first response.
    const attempt = async (extraReminder) => {
      const reply = await askOllama(extraReminder ? `${prompt}\n\n${extraReminder}` : prompt, 700);
      const parsed = parseJsonReply(reply);
      const aiResults = Array.isArray(parsed.results) ? parsed.results : [];
      const byNormalizedLabel = {};
      aiResults.forEach((r) => { byNormalizedLabel[normalize(r.label)] = r; });
      return { parsed, byNormalizedLabel };
    };

    try {
      let parsed, byNormalizedLabel;
      // First attempt may throw (invalid JSON) — give it one clean retry before giving up entirely.
      try {
        ({ parsed, byNormalizedLabel } = await attempt());
      } catch {
        ({ parsed, byNormalizedLabel } = await attempt('Reminder: respond with ONLY the JSON object, nothing else.'));
      }
      const missing = aiEntries.filter(([label]) => !byNormalizedLabel[normalize(label)]);
      if (missing.length) {
        const retry = await attempt(`Reminder: your last response was missing results for: ${missing.map(([l]) => l).join(', ')}. Include ALL ${aiEntries.length} fields this time.`);
        byNormalizedLabel = { ...byNormalizedLabel, ...retry.byNormalizedLabel };
        parsed = { ...parsed, overallNote: retry.parsed.overallNote || parsed.overallNote };
      }
      aiByNormalizedLabel = byNormalizedLabel;
      aiOverallNote = parsed.overallNote?.toString().trim() || '';
    } catch {
      aiOverallNote = 'AI verification returned an unexpected response for the remaining fields — please check them manually.';
    }
  }

  // Match results back to our own authoritative labels by NORMALIZED label text (case/whitespace
  // -insensitive — a small local model doesn't always echo a label back byte-for-byte even when
  // told to).
  const results = entries.map(([label]) => {
    if (isDeterministicLabel(label)) {
      const r = deterministicResults[normalize(label)];
      return { label, match: r?.match ?? null, note: r?.note || '' };
    }
    const r = aiByNormalizedLabel[normalize(label)];
    return { label, match: typeof r?.match === 'boolean' ? r.match : null, note: r?.note?.toString().trim() || '' };
  });
  // If every field was decided deterministically (no AI fields to summarize), synthesize an
  // overallNote from the results instead of leaving it blank.
  const overallNote = aiOverallNote || (() => {
    const mismatches = results.filter((r) => r.match === false).map((r) => r.label);
    return mismatches.length ? `Mismatch on: ${mismatches.join(', ')}` : 'All fields matched the document.';
  })();
  return { results, overallNote, extractedText };
}


// --- Expense receipt AI check ---
// A best-effort consistency check on ONE uploaded receipt image, not fraud detection: does the
// claimed amount actually appear printed on it, and (for a travel claim) does the claimed place
// show up in the text. It cannot confirm the receipt is genuine or unaltered.
//
// The amount is judged deterministically, the same reasoning as an ID/account number in
// verifyDocumentFields above: testing an LLM on digit-level comparison was unreliable enough to be
// unusable for something a payout decision might lean on. Every run of digits in the OCR'd text
// (after stripping currency symbols/commas/decimals) is compared to the claimed amount as a whole
// number; a receipt with GST/subtotal/total lines legitimately contains several numbers, so ANY
// one of them matching counts as found — it is a presence check, not "the total equals this".
//
// Place is judged the same permissive way as a name: word overlap, not an exact phrase, since a
// receipt prints an address/city in whatever formatting the vendor's printer used.
function extractAmounts(text) {
  const matches = text.match(/\d[\d,]*(?:\.\d+)?/g) || [];
  return matches
    .map((m) => Math.round(parseFloat(m.replace(/,/g, ''))))
    .filter((n) => Number.isFinite(n) && n > 0);
}
function amountFoundIn(claimedAmount, text) {
  const claimed = Math.round(Number(claimedAmount));
  if (!Number.isFinite(claimed) || claimed <= 0) return null;
  return extractAmounts(text).includes(claimed);
}
function placeFoundIn(place, text) {
  if (!place?.toString().trim()) return null;
  return deterministicNameMatch(place, text);
}

export async function verifyExpenseReceipt({ amount, place }, dataUrl) {
  const { mime, buffer } = bufferFromDataUrl(dataUrl);
  if (mime === 'application/pdf') {
    return {
      extractedText: '',
      amountMatch: null,
      placeMatch: null,
      note: "PDF receipts can't be read for verification yet — check this one manually."
    };
  }

  const { data } = await recognize(buffer, 'eng');
  const extractedText = (data?.text || '').trim();
  if (!extractedText) {
    return {
      extractedText: '',
      amountMatch: null,
      placeMatch: null,
      note: 'Could not read any text from this receipt — it may be too blurry or low-resolution. Check it manually.'
    };
  }

  const amountMatch = amountFoundIn(amount, extractedText);
  const placeMatch = placeFoundIn(place, extractedText);
  const parts = [];
  if (amountMatch === true) parts.push('Amount found on receipt');
  else if (amountMatch === false) parts.push('Amount not found on receipt');
  if (placeMatch === true) parts.push('place found');
  else if (placeMatch === false) parts.push('place not found');
  const note = parts.length ? parts.join(', ') : 'Nothing to check against.';

  return { extractedText, amountMatch, placeMatch, note };
}
