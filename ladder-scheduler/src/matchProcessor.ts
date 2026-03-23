import { query } from './db.js';
import { publishEvent } from './events.js';
import { logger } from './logger.js';

interface MatchupJob {
  matchupId: string;
  submissionAId: string;
  submissionBId: string;
  challengeId: string;
}

interface ExecutionResponse {
  submissionId: string;
  runtimeMs: number;
  peakMemoryBytes: number;
  testCasesPassed: number;
  testCasesTotal: number;
  exitCode: number;
  timedOut: boolean;
}

const SANDBOX_URL = process.env.SANDBOX_URL || 'http://localhost:3001';

async function executeSubmission(
  submissionId: string,
  code: string,
  language: string,
  testCasesS3Key: string,
  challengeId: string
): Promise<ExecutionResponse> {
  const response = await fetch(`${SANDBOX_URL}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      submissionId,
      language,
      code,
      testCasesS3Key,
      challengeId,
    }),
  });

  if (!response.ok) {
    throw new Error(`Sandbox execution failed: ${response.status}`);
  }

  return response.json() as Promise<ExecutionResponse>;
}

function computeScore(result: ExecutionResponse): number {
  if (result.testCasesTotal === 0) return 0;
  return (result.testCasesPassed / result.testCasesTotal) * 100;
}

export async function processMatchup(job: MatchupJob): Promise<void> {
  const log = logger.child({ matchupId: job.matchupId });
  log.info({ message: 'Processing matchup', submissionA: job.submissionAId, submissionB: job.submissionBId });

  try {
    // Mark matchup as running
    await query("UPDATE bracket_matchups SET status = 'running' WHERE id = $1", [job.matchupId]);

    // Fetch both submissions
    const [subAResult, subBResult] = await Promise.all([
      query<{ id: string; code: string; language: string; challenge_id: string }>(
        'SELECT id, code, language, challenge_id FROM submissions WHERE id = $1',
        [job.submissionAId]
      ),
      query<{ id: string; code: string; language: string; challenge_id: string }>(
        'SELECT id, code, language, challenge_id FROM submissions WHERE id = $1',
        [job.submissionBId]
      ),
    ]);

    const subA = subAResult.rows[0];
    const subB = subBResult.rows[0];

    if (!subA || !subB) {
      log.error({ message: 'Submission not found' });
      return;
    }

    // Get challenge for test cases key
    const challengeResult = await query<{ test_cases_s3_key: string }>(
      'SELECT test_cases_s3_key FROM challenges WHERE id = $1',
      [job.challengeId]
    );
    const challenge = challengeResult.rows[0];
    if (!challenge) {
      log.error({ message: 'Challenge not found' });
      return;
    }

    // Execute both submissions (parallel)
    const [resultA, resultB] = await Promise.all([
      executeSubmission(subA.id, subA.code, subA.language, challenge.test_cases_s3_key, job.challengeId),
      executeSubmission(subB.id, subB.code, subB.language, challenge.test_cases_s3_key, job.challengeId),
    ]);

    // Determine winner
    let winnerId: string;
    let winReason: string;

    const scoreA = computeScore(resultA);
    const scoreB = computeScore(resultB);

    if (resultA.timedOut && !resultB.timedOut) {
      winnerId = subB.id;
      winReason = `${subB.id} wins - opponent timed out`;
    } else if (!resultA.timedOut && resultB.timedOut) {
      winnerId = subA.id;
      winReason = `${subA.id} wins - opponent timed out`;
    } else if (resultA.timedOut && resultB.timedOut) {
      // Both timed out - higher test cases wins, then coin flip
      if (resultA.testCasesPassed > resultB.testCasesPassed) {
        winnerId = subA.id;
        winReason = `Won with ${resultA.testCasesPassed} test cases passed (both timed out)`;
      } else if (resultB.testCasesPassed > resultA.testCasesPassed) {
        winnerId = subB.id;
        winReason = `Won with ${resultB.testCasesPassed} test cases passed (both timed out)`;
      } else {
        winnerId = Math.random() < 0.5 ? subA.id : subB.id;
        winReason = 'Coin flip (tie in all metrics)';
      }
    } else if (scoreA > scoreB) {
      winnerId = subA.id;
      winReason = `Higher score: ${scoreA.toFixed(1)}% vs ${scoreB.toFixed(1)}%`;
    } else if (scoreB > scoreA) {
      winnerId = subB.id;
      winReason = `Higher score: ${scoreB.toFixed(1)}% vs ${scoreA.toFixed(1)}%`;
    } else if (resultA.runtimeMs < resultB.runtimeMs) {
      winnerId = subA.id;
      winReason = `Faster by ${resultB.runtimeMs - resultA.runtimeMs}ms with ${scoreA.toFixed(1)}% pass rate`;
    } else if (resultB.runtimeMs < resultA.runtimeMs) {
      winnerId = subB.id;
      winReason = `Faster by ${resultA.runtimeMs - resultB.runtimeMs}ms with ${scoreB.toFixed(1)}% pass rate`;
    } else if (resultA.peakMemoryBytes < resultB.peakMemoryBytes) {
      winnerId = subA.id;
      winReason = `Lower memory usage with equal speed and score`;
    } else {
      winnerId = Math.random() < 0.5 ? subA.id : subB.id;
      winReason = 'Coin flip (tie in all metrics)';
    }

    // Update matchup
    await query(
      `UPDATE bracket_matchups SET winner_id = $1, status = 'complete', decided_at = NOW(), win_reason = $2 WHERE id = $3`,
      [winnerId, winReason, job.matchupId]
    );

    // Get aliases for event
    const [aliasAResult, aliasBResult] = await Promise.all([
      query<{ gladiator_alias: string }>('SELECT gladiator_alias FROM submissions WHERE id = $1', [subA.id]),
      query<{ gladiator_alias: string }>('SELECT gladiator_alias FROM submissions WHERE id = $1', [subB.id]),
    ]);

    const aliasA = aliasAResult.rows[0]?.gladiator_alias || 'Unknown';
    const aliasB = aliasBResult.rows[0]?.gladiator_alias || 'Unknown';
    const winnerAlias = winnerId === subA.id ? aliasA : aliasB;

    // Publish event
    await publishEvent(job.challengeId, 'MATCHUP_COMPLETE', {
      matchupId: job.matchupId,
      aliasA,
      aliasB,
      scoreA,
      scoreB,
      runtimeMsA: resultA.runtimeMs,
      runtimeMsB: resultB.runtimeMs,
      memoryA: resultA.peakMemoryBytes,
      memoryB: resultB.peakMemoryBytes,
      passRateA: resultA.testCasesTotal > 0 ? resultA.testCasesPassed / resultA.testCasesTotal : 0,
      passRateB: resultB.testCasesTotal > 0 ? resultB.testCasesPassed / resultB.testCasesTotal : 0,
      winnerAlias,
      winReason,
    });

    log.info({ message: 'Matchup complete', winnerId, winReason });
  } catch (err) {
    log.error({ message: 'Matchup processing error', error: String(err) });
  }
}
