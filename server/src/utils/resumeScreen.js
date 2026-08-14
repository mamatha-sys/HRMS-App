import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import Tesseract from 'tesseract.js';
import { chatWithAssistant } from './aiAssist.js';

const { recognize } = Tesseract;

// Extracts plain text from a candidate's resume (stored as a base64 data URL, same pattern as
// employee documents). Supports the formats the "Add Candidate" upload actually accepts
// (.pdf, .doc, .docx, image/*) — legacy .doc (the old binary Word format, not .docx) has no
// lightweight pure-JS parser available, so it's the one explicitly unsupported format.
export async function extractResumeText(dataUrl, fileName) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) throw new Error('No resume file to read');
  const [, mime, b64] = match;
  const buffer = Buffer.from(b64, 'base64');
  const ext = fileName?.toLowerCase().split('.').pop();

  if (mime === 'application/pdf' || ext === 'pdf') {
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    return result.text?.trim() || '';
  }
  if (mime.includes('wordprocessingml') || ext === 'docx') {
    const result = await mammoth.extractRawText({ buffer });
    return result.value?.trim() || '';
  }
  if (mime.startsWith('image/')) {
    const { data } = await recognize(buffer, 'eng');
    return data?.text?.trim() || '';
  }
  if (ext === 'doc') {
    throw new Error('Legacy .doc files can\'t be read yet — please re-upload as PDF or .docx to use AI resume screening.');
  }
  throw new Error('Unsupported resume file format for AI screening.');
}

// Screens resume text against the role before an interview invite goes out — a best-effort
// first-pass filter, not a hard reject: the caller decides what "review" actually means (e.g.
// hold the auto-invite for HR to check manually) rather than this function silently discarding
// anyone. Same fallback shape as scoreInterviewTranscript — always returns something usable.
export async function screenResume(resumeText, jobTitle, jobDescription) {
  if (!resumeText?.trim()) throw new Error('Resume has no readable text to screen');

  const jdContext = jobDescription?.trim() ? `\n\nJob description:\n${jobDescription.trim().slice(0, 1000)}` : '';
  const prompt = `You are an HR recruiter doing a first-pass resume screen for a "${jobTitle?.trim() || 'open'}" position.${jdContext}

Resume text (extracted automatically — expect some formatting noise):
${resumeText.slice(0, 4000)}

Score how well this resume matches the role from 0-100, and recommend whether to proceed straight to interview or have a human review it first (recommend "review" for a resume that's clearly unrelated to the role, very thin, or where the extracted text looks broken/unreadable — not for minor gaps). Respond with ONLY a single JSON object, no markdown, no explanation:
{"score": <integer 0-100>, "recommendation": "proceed" or "review", "summary": "<1-2 sentence reason>"}`;

  try {
    const reply = await chatWithAssistant('You are a careful resume-screening assistant. Always respond with ONLY the requested JSON object.', [{ role: 'user', content: prompt }]);
    const jsonText = reply.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(jsonText);
    const score = Number.isFinite(Number(parsed.score)) ? Math.max(0, Math.min(100, Math.round(Number(parsed.score)))) : null;
    if (score === null) throw new Error('no score');
    return {
      score,
      recommendation: parsed.recommendation === 'review' ? 'review' : 'proceed',
      summary: parsed.summary?.toString().trim() || ''
    };
  } catch {
    // Screening failure is a technical hiccup, not a signal about the candidate — default to
    // "proceed" so a flaky model/JSON response never silently blocks someone from being invited.
    return { score: null, recommendation: 'proceed', summary: 'AI screening did not return a usable result — proceeding without it.' };
  }
}
