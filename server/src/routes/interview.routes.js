import { Router } from 'express';
import db from '../db.js';
import { scoreInterviewTranscript } from '../utils/aiAssist.js';

// Public, unauthenticated router — the candidate taking this interview is never an HRMS user and
// never logs in. Every route is scoped to a single interview by its unguessable token; nothing
// here trusts an id from the client, only the token, and every lookup 404s on an unknown one
// rather than leaking whether a token almost-matched something.
const router = Router();

function getByToken(token) {
  return db.prepare(`
    SELECT ci.*, c.name AS candidate_name, c.position_id, p.title AS position_title
    FROM candidate_interviews ci
    JOIN candidates c ON c.id = ci.candidate_id
    LEFT JOIN positions p ON p.id = c.position_id
    WHERE ci.token = ?
  `).get(token);
}

router.get('/:token', (req, res) => {
  const interview = getByToken(req.params.token);
  if (!interview) return res.status(404).json({ error: 'This interview link is invalid.' });

  const questions = JSON.parse(interview.questions);
  res.json({
    candidateName: interview.candidate_name,
    positionTitle: interview.position_title || null,
    status: interview.status,
    currentIndex: interview.current_index,
    totalQuestions: questions.length,
    question: interview.status === 'completed' ? null : questions[interview.current_index] || null,
    score: interview.status === 'completed' ? interview.score : undefined // candidates never see their own score before completion; even after, only exposed if the client chooses to show it (it currently doesn't)
  });
});

router.post('/:token/answer', async (req, res) => {
  const interview = getByToken(req.params.token);
  if (!interview) return res.status(404).json({ error: 'This interview link is invalid.' });
  if (interview.status === 'completed') return res.status(400).json({ error: 'This interview has already been completed.' });

  const { transcript, video_data_url } = req.body || {};
  const questions = JSON.parse(interview.questions);
  const idx = interview.current_index;
  if (idx >= questions.length) return res.status(400).json({ error: 'No more questions to answer.' });

  db.prepare('INSERT INTO candidate_interview_answers (interview_id, question_index, question, transcript, video_data_url) VALUES (?, ?, ?, ?, ?)')
    .run(interview.id, idx, questions[idx], transcript || '', video_data_url || null);

  const nextIndex = idx + 1;
  const isLast = nextIndex >= questions.length;

  if (!isLast) {
    db.prepare("UPDATE candidate_interviews SET status = 'in_progress', current_index = ? WHERE id = ?").run(nextIndex, interview.id);
    return res.json({ done: false, nextQuestion: questions[nextIndex], currentIndex: nextIndex, totalQuestions: questions.length });
  }

  // Last answer just came in — score the whole transcript now, once, server-side. Scoring failure
  // shouldn't strand the candidate on a broken "submitting..." screen: still mark the interview
  // completed either way, just with a null score for HR to review manually if scoring didn't work.
  const qaPairs = db.prepare('SELECT question, transcript FROM candidate_interview_answers WHERE interview_id = ? ORDER BY question_index').all(interview.id);
  let scored = { score: null, communicationScore: null, eligible: null, summary: 'Scoring did not complete — please review the answers manually.', strengths: '', concerns: '' };
  try {
    scored = await scoreInterviewTranscript(interview.position_title, null, qaPairs);
  } catch (err) {
    scored.summary = `Scoring failed (${err.message}) — please review the answers manually.`;
  }
  // The summary column is one free-text field, so fold strengths/concerns into readable prose
  // rather than adding more columns for what's fundamentally one evaluation write-up.
  const fullSummary = [
    scored.summary,
    scored.strengths ? `Strengths: ${scored.strengths}.` : '',
    scored.concerns && scored.concerns !== 'None noted' ? `Concerns: ${scored.concerns}.` : ''
  ].filter(Boolean).join(' ');

  db.prepare("UPDATE candidate_interviews SET status = 'completed', current_index = ?, score = ?, communication_score = ?, eligible = ?, summary = ?, completed_at = datetime('now') WHERE id = ?")
    .run(nextIndex, scored.score, scored.communicationScore, scored.eligible === null ? null : (scored.eligible ? 1 : 0), fullSummary, interview.id);

  res.json({ done: true });
});

export default router;
