import { query } from './db.js';
import { publishEvent } from './events.js';
import { logger } from './logger.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

interface AnalysisData {
  challengeId: string;
  challengeTitle: string;
  description: string;
  inputSpec: string;
  outputSpec: string;
  winnerAlias: string;
  winnerLanguage: string;
  winnerRuntimeMs: number;
  winnerMemoryKB: number;
  winnerPassed: number;
  winnerTotal: number;
  winnerCode: string;
  loserAlias: string;
  loserLanguage: string;
  loserRuntimeMs: number;
  loserMemoryKB: number;
  loserPassed: number;
  loserTotal: number;
  loserCode: string;
}

async function callGemini(data: AnalysisData): Promise<string> {
  const model = 'gemini-1.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

  const systemPrompt = 'You are a senior software engineer and competitive programming judge. You analyze code submissions that competed head-to-head. Be specific, technical, and fair. Format your response in Markdown.';

  const userPrompt = `Two solutions competed for the challenge: '${data.challengeTitle}'

CHALLENGE DESCRIPTION:
${data.description}

INPUT SPEC: ${data.inputSpec}
OUTPUT SPEC: ${data.outputSpec}

--- CHAMPION SOLUTION (${data.winnerAlias}) ---
Language: ${data.winnerLanguage}
Runtime: ${data.winnerRuntimeMs}ms | Memory: ${data.winnerMemoryKB}KB | Test cases: ${data.winnerPassed}/${data.winnerTotal}

\`\`\`${data.winnerLanguage}
${data.winnerCode}
\`\`\`

--- RUNNER-UP SOLUTION (${data.loserAlias}) ---
Language: ${data.loserLanguage}
Runtime: ${data.loserRuntimeMs}ms | Memory: ${data.loserMemoryKB}KB | Test cases: ${data.loserPassed}/${data.loserTotal}

\`\`\`${data.loserLanguage}
${data.loserCode}
\`\`\`

Generate a structured analysis card with these exact sections:
## Why ${data.winnerAlias} Won
## Key Algorithmic Differences
## Performance Breakdown
## What ${data.loserAlias} Could Improve
## Verdict

Be specific: cite actual code from both solutions. Mention Big-O complexity where relevant.`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }]
      }],
      generationConfig: {
        maxOutputTokens: 4096,
        temperature: 0.2,
      }
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Gemini API error: ${response.status} ${response.statusText} - ${errorBody}`);
  }

  const result = await response.json() as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
  return result.candidates[0]?.content.parts[0]?.text || '';
}

export async function generateWinAnalysis(challengeId: string): Promise<void> {
  const log = logger.child({ challengeId });

  try {
    // Find the champion (last round winner) and runner-up
    const finalMatchup = await query<{
      winner_id: string;
      submission_a_id: string;
      submission_b_id: string;
    }>(
      `SELECT bm.winner_id, bm.submission_a_id, bm.submission_b_id
       FROM bracket_matchups bm
       JOIN bracket_rounds br ON bm.round_id = br.id
       WHERE br.challenge_id = $1
       ORDER BY br.round_number DESC
       LIMIT 1`,
      [challengeId]
    );

    const matchup = finalMatchup.rows[0];
    if (!matchup) {
      log.error({ message: 'No final matchup found' });
      return;
    }

    const winnerId = matchup.winner_id;
    const loserId = matchup.submission_a_id === winnerId ? matchup.submission_b_id : matchup.submission_a_id;

    // Fetch all data
    const [challengeRes, winnerRes, loserRes, winnerExecRes, loserExecRes] = await Promise.all([
      query<{ title: string; description: string; input_spec: string; output_spec: string }>(
        'SELECT title, description, input_spec, output_spec FROM challenges WHERE id = $1', [challengeId]
      ),
      query<{ gladiator_alias: string; language: string; code: string }>(
        'SELECT gladiator_alias, language, code FROM submissions WHERE id = $1', [winnerId]
      ),
      query<{ gladiator_alias: string; language: string; code: string }>(
        'SELECT gladiator_alias, language, code FROM submissions WHERE id = $1', [loserId]
      ),
      query<{ runtime_ms: number; peak_memory_bytes: string; test_cases_passed: number; test_cases_total: number }>(
        'SELECT runtime_ms, peak_memory_bytes, test_cases_passed, test_cases_total FROM execution_results WHERE submission_id = $1', [winnerId]
      ),
      query<{ runtime_ms: number; peak_memory_bytes: string; test_cases_passed: number; test_cases_total: number }>(
        'SELECT runtime_ms, peak_memory_bytes, test_cases_passed, test_cases_total FROM execution_results WHERE submission_id = $1', [loserId]
      ),
    ]);

    const challenge = challengeRes.rows[0];
    const winner = winnerRes.rows[0];
    const loser = loserRes.rows[0];
    const winnerExec = winnerExecRes.rows[0];
    const loserExec = loserExecRes.rows[0];

    if (!challenge || !winner || !loser || !winnerExec || !loserExec) {
      log.error({ message: 'Missing data for analysis' });
      return;
    }

    const analysisData: AnalysisData = {
      challengeId,
      challengeTitle: challenge.title,
      description: challenge.description,
      inputSpec: challenge.input_spec,
      outputSpec: challenge.output_spec,
      winnerAlias: winner.gladiator_alias,
      winnerLanguage: winner.language,
      winnerRuntimeMs: winnerExec.runtime_ms,
      winnerMemoryKB: Math.round(parseInt(String(winnerExec.peak_memory_bytes)) / 1024),
      winnerPassed: winnerExec.test_cases_passed,
      winnerTotal: winnerExec.test_cases_total,
      winnerCode: winner.code,
      loserAlias: loser.gladiator_alias,
      loserLanguage: loser.language,
      loserRuntimeMs: loserExec.runtime_ms,
      loserMemoryKB: Math.round(parseInt(String(loserExec.peak_memory_bytes)) / 1024),
      loserPassed: loserExec.test_cases_passed,
      loserTotal: loserExec.test_cases_total,
      loserCode: loser.code,
    };

    // Retry logic with exponential backoff
    let analysis = '';
    const delays = [2000, 4000, 8000];

    for (let attempt = 0; attempt <= 3; attempt++) {
      try {
        if (!GEMINI_API_KEY) {
          throw new Error('GEMINI_API_KEY not set');
        }
        analysis = await callGemini(analysisData);
        break;
      } catch (err) {
        log.warn({ message: `Gemini API attempt ${attempt + 1} failed`, error: String(err) });
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, delays[attempt]!));
        } else {
          analysis = `Analysis temporarily unavailable. Champion ${winner.gladiator_alias} won with superior performance.`;
        }
      }
    }

    // Store analysis
    await query(
      `INSERT INTO win_analyses (challenge_id, winner_submission_id, runner_up_submission_id, analysis_markdown)
       VALUES ($1, $2, $3, $4)`,
      [challengeId, winnerId, loserId, analysis]
    );

    // Broadcast
    await publishEvent(challengeId, 'WIN_ANALYSIS_READY', {
      analysisMarkdown: analysis,
    });

    log.info({ message: 'Win analysis generated and published' });
  } catch (err) {
    log.error({ message: 'Failed to generate win analysis', error: String(err) });
  }
}
