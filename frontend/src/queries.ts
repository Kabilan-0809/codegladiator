import { gql } from '@apollo/client';

export const GET_CHALLENGES = gql`
  query GetChallenges($limit: Int, $offset: Int) {
    challenges(limit: $limit, offset: $offset) {
      id
      slug
      title
      description
      difficulty
      submissionWindowClosesAt
      ladderStarted
      submissionCount
    }
  }
`;

export const GET_CHALLENGE = gql`
  query GetChallenge($slug: String!) {
    challenge(slug: $slug) {
      id
      slug
      title
      description
      inputSpec
      outputSpec
      difficulty
      submissionWindowClosesAt
      ladderStarted
      submissionCount
      bracket {
        challengeId
        rounds {
          id
          roundNumber
          status
          matchups {
            id
            submissionA {
              id
              gladiatorAlias
              language
            }
            submissionB {
              id
              gladiatorAlias
              language
            }
            winner {
              id
              gladiatorAlias
            }
            status
            decidedAt
            winReason
          }
        }
        champion {
          id
          gladiatorAlias
          language
        }
        winAnalysis {
          id
          analysisMarkdown
          generatedAt
        }
      }
    }
  }
`;

export const GET_MY_SUBMISSIONS = gql`
  query GetMySubmissions($challengeId: ID!) {
    mySubmissions(challengeId: $challengeId) {
      id
      challengeId
      gladiatorAlias
      language
      submittedAt
      executionResult {
        runtimeMs
        peakMemoryBytes
        testCasesPassed
        testCasesTotal
        timedOut
        score
      }
    }
  }
`;

export const SUBMIT_CODE = gql`
  mutation SubmitCode($challengeId: ID!, $language: String!, $code: String!) {
    submitCode(challengeId: $challengeId, language: $language, code: $code) {
      id
      challengeId
      gladiatorAlias
      language
      submittedAt
    }
  }
`;

export const GET_LEADERBOARD = gql`
  query GetLeaderboard($challengeId: ID!) {
    leaderboard(challengeId: $challengeId) {
      id
      gladiatorAlias
      language
      executionResult {
        runtimeMs
        peakMemoryBytes
        testCasesPassed
        testCasesTotal
        timedOut
        score
      }
    }
  }
`;
