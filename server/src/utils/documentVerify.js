// tesseract.js's ESM named exports aren't statically detectable from its CJS build, so import the
// namespace and destructure at runtime instead of `import { recognize } from 'tesseract.js'`.
import Tesseract from 'tesseract.js';
const { recognize } = Tesseract;
import { chatWithAssistant } from './aiAssist.js';

// Reads a base64 data URL (the same storage shape used for employee documents/photos) into a
// Buffer that tesseract.js can OCR directly.
function bufferFromDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) throw new Error('Not a valid file');
  return { mime: match[1], buffer: Buffer.from(match[2], 'base64') };
}

// Cross-checks a typed employee name against the text OCR'd from an uploaded document (ID proof,
// offer letter, etc.) — a best-effort consistency check, NOT identity/fraud verification. It can
// only tell you whether the name you typed shows up in the document's text; it has no way to
// confirm the document itself is genuine or unaltered.
export async function verifyDocumentName(typedName, documentDataUrl) {
  if (!typedName?.trim()) throw new Error('Enter the employee name first');
  if (!documentDataUrl) throw new Error('No document to verify');

  const { mime, buffer } = bufferFromDataUrl(documentDataUrl);
  if (mime === 'application/pdf') {
    throw new Error('PDF documents can\'t be read for verification yet — please verify this one manually, or re-upload it as an image (JPG/PNG) to use AI verification.');
  }

  const { data } = await recognize(buffer, 'eng');
  const extractedText = (data?.text || '').trim();
  if (!extractedText) {
    return { match: null, note: 'Could not read any text from this document — it may be too blurry, low-resolution, or handwritten. Please check it manually.', extractedText: '' };
  }

  const prompt = `An HR system extracted this text from a scanned employee document via OCR (so it may contain scan noise/typos):

"""
${extractedText.slice(0, 1500)}
"""

The employee's name as typed into the HR form is: "${typedName.trim()}"

Does this document's text plausibly contain/support that name (allowing for OCR noise, minor spelling variation, initials, or name order differences — e.g. "John A. Smith" matching "Smith John A")? Respond with ONLY a single JSON object, no markdown, no explanation:
{"match": true or false, "note": "<one short sentence explaining why, e.g. what name you found instead, or confirming the match>"}`;

  const reply = await chatWithAssistant('You are a careful document-matching assistant. Always respond with ONLY the requested JSON object.', [{ role: 'user', content: prompt }]);
  const jsonText = reply.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { match: null, note: 'AI verification returned an unexpected response — please check this document manually.', extractedText };
  }
  return { match: !!parsed.match, note: parsed.note?.toString().trim() || '', extractedText };
}
