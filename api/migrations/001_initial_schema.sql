-- Phase 2: Database Schema Migration
-- Run this against PostgreSQL to create all tables

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Challenges table
CREATE TABLE IF NOT EXISTS challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  input_spec TEXT NOT NULL,
  output_spec TEXT NOT NULL,
  difficulty TEXT CHECK(difficulty IN ('easy','medium','hard')),
  test_cases_s3_key TEXT NOT NULL,
  submission_window_closes_at TIMESTAMPTZ NOT NULL,
  ladder_started BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Execution results table (created before submissions since submissions references it)
CREATE TABLE IF NOT EXISTS execution_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID,
  runtime_ms INTEGER,
  peak_memory_bytes BIGINT,
  test_cases_passed INTEGER,
  test_cases_total INTEGER,
  exit_code INTEGER,
  timed_out BOOLEAN DEFAULT FALSE,
  executed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Submissions table
CREATE TABLE IF NOT EXISTS submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id UUID REFERENCES challenges(id),
  jwt_fingerprint TEXT NOT NULL,
  gladiator_alias TEXT NOT NULL,
  language TEXT NOT NULL,
  code TEXT NOT NULL,
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  execution_result_id UUID REFERENCES execution_results(id)
);

-- Add foreign key from execution_results to submissions safely
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_execution_results_submission') THEN
        ALTER TABLE execution_results
          ADD CONSTRAINT fk_execution_results_submission
          FOREIGN KEY (submission_id) REFERENCES submissions(id);
    END IF;
END;
$$;

-- Bracket rounds table
CREATE TABLE IF NOT EXISTS bracket_rounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id UUID REFERENCES challenges(id),
  round_number INTEGER NOT NULL,
  status TEXT CHECK(status IN ('pending','running','complete')) DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Bracket matchups table
CREATE TABLE IF NOT EXISTS bracket_matchups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id UUID REFERENCES bracket_rounds(id),
  submission_a_id UUID REFERENCES submissions(id),
  submission_b_id UUID REFERENCES submissions(id),
  winner_id UUID REFERENCES submissions(id),
  status TEXT CHECK(status IN ('pending','running','complete')) DEFAULT 'pending',
  decided_at TIMESTAMPTZ,
  win_reason TEXT
);

-- Win analyses table
CREATE TABLE IF NOT EXISTS win_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id UUID REFERENCES challenges(id),
  winner_submission_id UUID REFERENCES submissions(id),
  runner_up_submission_id UUID REFERENCES submissions(id),
  analysis_markdown TEXT NOT NULL,
  generated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_submissions_challenge_id ON submissions(challenge_id);
CREATE INDEX IF NOT EXISTS idx_submissions_jwt_fingerprint ON submissions(jwt_fingerprint);
CREATE INDEX IF NOT EXISTS idx_bracket_matchups_round_id ON bracket_matchups(round_id);
CREATE INDEX IF NOT EXISTS idx_execution_results_submission_id ON execution_results(submission_id);
