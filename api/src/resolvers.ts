import { v4 as uuidv4 } from 'uuid';
import { query } from './db.js';
import { logger } from './logger.js';
import { type AuthContext } from './auth.js';
import { createClient } from '@supabase/supabase-js';
import { redis } from './redis.js';

const ALLOWED_LANGUAGES = ['python', 'javascript', 'go', 'rust', 'cpp'];
const LANGUAGE_EXT: Record<string, string> = {
  python: 'py', javascript: 'js', go: 'go', rust: 'rs', cpp: 'cpp',
};

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

const S3_BUCKET = process.env.S3_BUCKET || 'codegladiator-submissions';
const EXECUTION_QUEUE_NAME = 'execution-queue';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-me-admin-header-secret';

function computeScore(passed: number, total: number, _runtimeMs: number, _memoryBytes: number): number {
  if (total === 0) return 0;
  return (passed / total) * 100;
}

interface ChallengeRow {
  id: string;
  slug: string;
  title: string;
  description: string;
  input_spec: string;
  output_spec: string;
  difficulty: string;
  test_cases_s3_key: string;
  submission_window_closes_at: string;
  ladder_started: boolean;
  created_at: string;
}

interface SubmissionRow {
  id: string;
  challenge_id: string;
  jwt_fingerprint: string;
  gladiator_alias: string;
  language: string;
  code: string;
  submitted_at: string;
  execution_result_id: string | null;
}

interface ExecutionResultRow {
  id: string;
  submission_id: string;
  runtime_ms: number;
  peak_memory_bytes: string;
  test_cases_passed: number;
  test_cases_total: number;
  exit_code: number;
  timed_out: boolean;
  executed_at: string;
}

interface RoundRow {
  id: string;
  challenge_id: string;
  round_number: number;
  status: string;
  created_at: string;
}

interface MatchupRow {
  id: string;
  round_id: string;
  submission_a_id: string;
  submission_b_id: string | null;
  winner_id: string | null;
  status: string;
  decided_at: string | null;
  win_reason: string | null;
}

interface WinAnalysisRow {
  id: string;
  challenge_id: string;
  winner_submission_id: string;
  runner_up_submission_id: string;
  analysis_markdown: string;
  generated_at: string;
}

interface GraphQLContext {
  auth: AuthContext;
  requestId: string;
  adminSecret?: string;
}

function mapChallenge(row: ChallengeRow) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    inputSpec: row.input_spec,
    outputSpec: row.output_spec,
    difficulty: row.difficulty,
    submissionWindowClosesAt: row.submission_window_closes_at,
    ladderStarted: row.ladder_started,
  };
}

function mapSubmission(row: SubmissionRow) {
  return {
    id: row.id,
    challengeId: row.challenge_id,
    gladiatorAlias: row.gladiator_alias,
    language: row.language,
    submittedAt: row.submitted_at,
    executionResultId: row.execution_result_id,
  };
}

export const resolvers = {
  Query: {
    challenge: async (_: unknown, { slug }: { slug: string }) => {
      const result = await query<ChallengeRow>(
        'SELECT * FROM challenges WHERE slug = $1',
        [slug]
      );
      return result.rows[0] ? mapChallenge(result.rows[0]) : null;
    },

    challenges: async (_: unknown, { limit = 20, offset = 0 }: { limit?: number; offset?: number }) => {
      const result = await query<ChallengeRow>(
        'SELECT * FROM challenges ORDER BY created_at DESC LIMIT $1 OFFSET $2',
        [limit, offset]
      );
      return result.rows.map(mapChallenge);
    },

    mySubmissions: async (_: unknown, { challengeId }: { challengeId: string }, context: GraphQLContext) => {
      const result = await query<SubmissionRow>(
        'SELECT * FROM submissions WHERE challenge_id = $1 AND jwt_fingerprint = $2 ORDER BY submitted_at DESC',
        [challengeId, context.auth.fingerprint]
      );
      return result.rows.map(mapSubmission);
    },

    bracket: async (_: unknown, { challengeId }: { challengeId: string }) => {
      const rounds = await query<RoundRow>(
        'SELECT * FROM bracket_rounds WHERE challenge_id = $1 ORDER BY round_number',
        [challengeId]
      );

      if (rounds.rows.length === 0) return null;

      return { challengeId, rounds: rounds.rows };
    },

    leaderboard: async (_: unknown, { challengeId }: { challengeId: string }) => {
      const result = await query<SubmissionRow & { runtime_ms: number; peak_memory_bytes: string; test_cases_passed: number; test_cases_total: number }>(
        `SELECT s.*, er.runtime_ms, er.peak_memory_bytes, er.test_cases_passed, er.test_cases_total
         FROM submissions s
         LEFT JOIN execution_results er ON er.submission_id = s.id
         WHERE s.challenge_id = $1 AND er.id IS NOT NULL
         ORDER BY er.test_cases_passed DESC, er.runtime_ms ASC`,
        [challengeId]
      );
      return result.rows.map(mapSubmission);
    },
  },

  Mutation: {
    submitCode: async (
      _: unknown,
      { challengeId, language, code }: { challengeId: string; language: string; code: string },
      context: GraphQLContext
    ) => {
      const log = logger.child({ requestId: context.requestId });

      // Validate language
      if (!ALLOWED_LANGUAGES.includes(language)) {
        throw new Error(`Invalid language: ${language}. Allowed: ${ALLOWED_LANGUAGES.join(', ')}`);
      }

      // Validate code length
      if (code.length > 50000) {
        throw new Error('Code exceeds maximum length of 50000 characters');
      }

      // Check challenge exists and window is open
      const challengeResult = await query<ChallengeRow>(
        'SELECT * FROM challenges WHERE id = $1',
        [challengeId]
      );
      const challenge = challengeResult.rows[0];
      if (!challenge) {
        throw new Error('Challenge not found');
      }

      if (new Date(challenge.submission_window_closes_at) < new Date()) {
        throw new Error('Submission window has closed');
      }

      // Check for duplicate submission
      const existing = await query(
        'SELECT id FROM submissions WHERE challenge_id = $1 AND jwt_fingerprint = $2',
        [challengeId, context.auth.fingerprint]
      );
      if (existing.rows.length > 0) {
        throw new Error('You have already submitted to this challenge');
      }

      // Store submission
      const submissionId = uuidv4();
      await query(
        `INSERT INTO submissions (id, challenge_id, jwt_fingerprint, gladiator_alias, language, code)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [submissionId, challengeId, context.auth.fingerprint, context.auth.user.alias, language, code]
      );

      // Upload code to Supabase Storage
      const ext = LANGUAGE_EXT[language] || 'txt';
      const s3Key = `submissions/${challengeId}/${submissionId}.${ext}`;
      try {
        const { error } = await supabase.storage
          .from(S3_BUCKET)
          .upload(s3Key, code, { contentType: 'text/plain' });

        if (error) throw error;
      } catch (err) {
        log.error({ message: 'Failed to upload to Supabase Storage', error: String(err) });
      }

      // Send execution job to Redis queue
      try {
        await redis.lpush(EXECUTION_QUEUE_NAME, JSON.stringify({
          submissionId,
          language,
          code,
          testCasesS3Key: challenge.test_cases_s3_key,
          challengeId,
        }));
        log.info({ message: 'Execution job queued to Redis', submissionId });
      } catch (err) {
        log.error({ message: 'Failed to queue execution job to Redis', error: String(err) });
      }

      return {
        id: submissionId,
        challengeId,
        gladiatorAlias: context.auth.user.alias,
        language,
        submittedAt: new Date().toISOString(),
        executionResultId: null,
      };
    },

    createChallenge: async (
      _: unknown,
      { input }: { input: Record<string, string> },
      context: GraphQLContext
    ) => {
      // Admin check
      if (context.adminSecret !== ADMIN_SECRET) {
        throw new Error('Unauthorized: admin access required');
      }

      const result = await query<ChallengeRow>(
        `INSERT INTO challenges (slug, title, description, input_spec, output_spec, difficulty, test_cases_s3_key, submission_window_closes_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [input.slug, input.title, input.description, input.inputSpec, input.outputSpec, input.difficulty, input.testCasesS3Key, input.submissionWindowClosesAt]
      );

      return mapChallenge(result.rows[0]!);
    },
  },

  Challenge: {
    submissionCount: async (parent: { id: string }) => {
      const result = await query<{ count: string }>(
        'SELECT COUNT(*) as count FROM submissions WHERE challenge_id = $1',
        [parent.id]
      );
      return parseInt(result.rows[0]?.count || '0', 10);
    },

    bracket: async (parent: { id: string }) => {
      const rounds = await query<RoundRow>(
        'SELECT * FROM bracket_rounds WHERE challenge_id = $1 ORDER BY round_number',
        [parent.id]
      );
      if (rounds.rows.length === 0) return null;
      return { challengeId: parent.id, rounds: rounds.rows };
    },
  },

  Bracket: {
    rounds: async (parent: { rounds?: RoundRow[]; challengeId: string }) => {
      const rows = parent.rounds || (await query<RoundRow>(
        'SELECT * FROM bracket_rounds WHERE challenge_id = $1 ORDER BY round_number',
        [parent.challengeId]
      )).rows;

      return rows.map((r) => ({
        id: r.id,
        roundNumber: r.round_number,
        status: r.status,
      }));
    },

    champion: async (parent: { challengeId: string }) => {
      // Find the final round's single winner
      const result = await query<MatchupRow>(
        `SELECT bm.* FROM bracket_matchups bm
         JOIN bracket_rounds br ON bm.round_id = br.id
         WHERE br.challenge_id = $1
         ORDER BY br.round_number DESC, bm.decided_at DESC
         LIMIT 1`,
        [parent.challengeId]
      );

      const lastMatchup = result.rows[0];
      if (!lastMatchup?.winner_id) return null;

      const sub = await query<SubmissionRow>(
        'SELECT * FROM submissions WHERE id = $1',
        [lastMatchup.winner_id]
      );
      return sub.rows[0] ? mapSubmission(sub.rows[0]) : null;
    },

    winAnalysis: async (parent: { challengeId: string }) => {
      const result = await query<WinAnalysisRow>(
        'SELECT * FROM win_analyses WHERE challenge_id = $1 ORDER BY generated_at DESC LIMIT 1',
        [parent.challengeId]
      );
      if (result.rows.length === 0) return null;
      const r = result.rows[0]!;
      return {
        id: r.id,
        analysisMarkdown: r.analysis_markdown,
        generatedAt: r.generated_at,
      };
    },
  },

  Round: {
    matchups: async (parent: { id: string }) => {
      const result = await query<MatchupRow>(
        'SELECT * FROM bracket_matchups WHERE round_id = $1',
        [parent.id]
      );
      return result.rows.map((m) => ({
        id: m.id,
        submissionAId: m.submission_a_id,
        submissionBId: m.submission_b_id,
        winnerId: m.winner_id,
        status: m.status,
        decidedAt: m.decided_at,
        winReason: m.win_reason,
      }));
    },
  },

  Matchup: {
    submissionA: async (parent: { submissionAId: string }) => {
      const result = await query<SubmissionRow>(
        'SELECT * FROM submissions WHERE id = $1',
        [parent.submissionAId]
      );
      return result.rows[0] ? mapSubmission(result.rows[0]) : null;
    },

    submissionB: async (parent: { submissionBId: string | null }) => {
      if (!parent.submissionBId) return null;
      const result = await query<SubmissionRow>(
        'SELECT * FROM submissions WHERE id = $1',
        [parent.submissionBId]
      );
      return result.rows[0] ? mapSubmission(result.rows[0]) : null;
    },

    winner: async (parent: { winnerId: string | null }) => {
      if (!parent.winnerId) return null;
      const result = await query<SubmissionRow>(
        'SELECT * FROM submissions WHERE id = $1',
        [parent.winnerId]
      );
      return result.rows[0] ? mapSubmission(result.rows[0]) : null;
    },
  },

  Submission: {
    executionResult: async (parent: { id: string; executionResultId?: string | null }) => {
      const result = await query<ExecutionResultRow>(
        'SELECT * FROM execution_results WHERE submission_id = $1',
        [parent.id]
      );
      if (result.rows.length === 0) return null;
      const r = result.rows[0]!;
      const score = r.test_cases_total > 0
        ? computeScore(r.test_cases_passed, r.test_cases_total, r.runtime_ms, parseInt(String(r.peak_memory_bytes), 10))
        : 0;
      return {
        runtimeMs: r.runtime_ms,
        peakMemoryBytes: parseInt(String(r.peak_memory_bytes), 10),
        testCasesPassed: r.test_cases_passed,
        testCasesTotal: r.test_cases_total,
        timedOut: r.timed_out,
        score,
      };
    },
  },
};
