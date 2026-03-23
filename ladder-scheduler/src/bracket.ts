import { v4 as uuidv4 } from 'uuid';
import { query } from './db.js';
import { logger } from './logger.js';
import { publishEvent } from './events.js';

interface SubmissionWithScore {
  id: string;
  gladiator_alias: string;
  challenge_id: string;
  language: string;
  code: string;
  test_cases_passed: number;
  test_cases_total: number;
  runtime_ms: number;
  peak_memory_bytes: string;
  score: number;
}

function computeScoreAndRank(submissions: SubmissionWithScore[]): SubmissionWithScore[] {
  if (submissions.length === 0) return [];

  // Normalize runtime and memory rankings
  const runtimeSorted = [...submissions].sort((a, b) => a.runtime_ms - b.runtime_ms);
  const memorySorted = [...submissions].sort((a, b) => parseInt(String(a.peak_memory_bytes)) - parseInt(String(b.peak_memory_bytes)));

  return submissions.map((s) => {
    const passRate = s.test_cases_total > 0 ? s.test_cases_passed / s.test_cases_total : 0;
    const speedRank = 1 - (runtimeSorted.indexOf(s) / Math.max(1, submissions.length - 1));
    const memoryRank = 1 - (memorySorted.indexOf(s) / Math.max(1, submissions.length - 1));
    const score = passRate * 0.5 + speedRank * 0.3 + memoryRank * 0.2;
    return { ...s, score };
  });
}

function nextPowerOf2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

export async function bracketInit(): Promise<void> {
  logger.info({ message: 'Running BRACKET_INIT check' });

  // Find challenges ready for bracket
  const readyChallenges = await query<{
    id: string; slug: string; title: string;
  }>(
    `SELECT id, slug, title FROM challenges
     WHERE submission_window_closes_at < NOW()
     AND ladder_started = false
     AND (SELECT COUNT(*) FROM submissions WHERE challenge_id = challenges.id) >= 2`
  );

  for (const challenge of readyChallenges.rows) {
    logger.info({ message: 'Initializing bracket', challengeId: challenge.id, slug: challenge.slug });

    // Fetch submissions with completed execution results
    const subs = await query<SubmissionWithScore>(
      `SELECT s.id, s.gladiator_alias, s.challenge_id, s.language, s.code,
              er.test_cases_passed, er.test_cases_total, er.runtime_ms, er.peak_memory_bytes
       FROM submissions s
       JOIN execution_results er ON er.submission_id = s.id
       WHERE s.challenge_id = $1
       AND er.test_cases_total > 0
       AND er.timed_out = false`,
      [challenge.id]
    );

    if (subs.rows.length < 2) {
      logger.info({ message: 'Not enough valid submissions', count: subs.rows.length });
      continue;
    }

    // Score and rank submissions
    const ranked = computeScoreAndRank(subs.rows).sort((a, b) => b.score - a.score);

    // Pad to next power of 2 with byes
    const targetSize = nextPowerOf2(ranked.length);
    const padded: (SubmissionWithScore | null)[] = [...ranked];
    while (padded.length < targetSize) {
      padded.push(null); // bye
    }

    // Create round 1
    const roundId = uuidv4();
    await query(
      `INSERT INTO bracket_rounds (id, challenge_id, round_number, status) VALUES ($1, $2, 1, 'pending')`,
      [roundId, challenge.id]
    );

    const matchups: Array<{ aliasA: string; aliasB: string | null }> = [];

    // Pair submissions
    for (let i = 0; i < padded.length; i += 2) {
      const subA = padded[i];
      const subB = padded[i + 1] ?? null;

      const matchupId = uuidv4();

      if (subB === null && subA !== null) {
        // Bye: auto-advance
        await query(
          `INSERT INTO bracket_matchups (id, round_id, submission_a_id, submission_b_id, winner_id, status, decided_at, win_reason)
           VALUES ($1, $2, $3, NULL, $3, 'complete', NOW(), 'Bye - auto advance')`,
          [matchupId, roundId, subA.id]
        );
        matchups.push({ aliasA: subA.gladiator_alias, aliasB: null });
      } else if (subA !== null && subB !== null) {
        await query(
          `INSERT INTO bracket_matchups (id, round_id, submission_a_id, submission_b_id, status)
           VALUES ($1, $2, $3, $4, 'pending')`,
          [matchupId, roundId, subA.id, subB.id]
        );
        matchups.push({ aliasA: subA.gladiator_alias, aliasB: subB.gladiator_alias });
      }
    }

    // Set ladder_started
    await query('UPDATE challenges SET ladder_started = true WHERE id = $1', [challenge.id]);

    // Update round status
    await query("UPDATE bracket_rounds SET status = 'running' WHERE id = $1", [roundId]);

    // Publish event
    const totalRounds = Math.ceil(Math.log2(targetSize));
    await publishEvent(challenge.id, 'BRACKET_STARTED', {
      totalSubmissions: ranked.length,
      totalRounds,
      round1Matchups: matchups,
    });

    logger.info({
      message: 'Bracket created',
      challengeId: challenge.id,
      submissions: ranked.length,
      matchups: matchups.length,
      totalRounds,
    });
  }
}

export async function roundAdvance(): Promise<void> {
  logger.info({ message: 'Running ROUND_ADVANCE check' });

  // Find running rounds where all matchups are complete
  const completeRounds = await query<{
    id: string; challenge_id: string; round_number: number;
  }>(
    `SELECT br.id, br.challenge_id, br.round_number
     FROM bracket_rounds br
     WHERE br.status = 'running'
     AND NOT EXISTS (
       SELECT 1 FROM bracket_matchups bm
       WHERE bm.round_id = br.id AND bm.status != 'complete'
     )`
  );

  for (const round of completeRounds.rows) {
    // Collect winners
    const winners = await query<{ winner_id: string; gladiator_alias: string }>(
      `SELECT bm.winner_id, s.gladiator_alias
       FROM bracket_matchups bm
       JOIN submissions s ON s.id = bm.winner_id
       WHERE bm.round_id = $1 AND bm.winner_id IS NOT NULL`,
      [round.id]
    );

    // Mark round complete
    await query("UPDATE bracket_rounds SET status = 'complete' WHERE id = $1", [round.id]);

    if (winners.rows.length === 1) {
      // Champion!
      const champion = winners.rows[0]!;
      logger.info({ message: 'Champion crowned!', alias: champion.gladiator_alias, challengeId: round.challenge_id });

      await publishEvent(round.challenge_id, 'CHAMPION_CROWNED', {
        championAlias: champion.gladiator_alias,
        totalRounds: round.round_number,
        analysisPreview: 'Analysis being generated...',
      });

      // Trigger LLM analysis (done in analysis module)
      continue;
    }

    // Create next round
    const nextRoundNumber = round.round_number + 1;
    const nextRoundId = uuidv4();
    await query(
      `INSERT INTO bracket_rounds (id, challenge_id, round_number, status) VALUES ($1, $2, $3, 'running')`,
      [nextRoundId, round.challenge_id, nextRoundNumber]
    );

    // Pair winners
    for (let i = 0; i < winners.rows.length; i += 2) {
      const subA = winners.rows[i]!;
      const subB = winners.rows[i + 1];

      const matchupId = uuidv4();

      if (!subB) {
        // Bye
        await query(
          `INSERT INTO bracket_matchups (id, round_id, submission_a_id, winner_id, status, decided_at, win_reason)
           VALUES ($1, $2, $3, $3, 'complete', NOW(), 'Bye - auto advance')`,
          [matchupId, nextRoundId, subA.winner_id]
        );
      } else {
        await query(
          `INSERT INTO bracket_matchups (id, round_id, submission_a_id, submission_b_id, status)
           VALUES ($1, $2, $3, $4, 'pending')`,
          [matchupId, nextRoundId, subA.winner_id, subB.winner_id]
        );
      }
    }

    await publishEvent(round.challenge_id, 'ROUND_COMPLETE', {
      roundNumber: round.round_number,
      advancingAliases: winners.rows.map((w) => w.gladiator_alias),
    });

    logger.info({
      message: 'Round advanced',
      challengeId: round.challenge_id,
      fromRound: round.round_number,
      toRound: nextRoundNumber,
      advancingCount: winners.rows.length,
    });
  }
}
