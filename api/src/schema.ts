export const typeDefs = `#graphql
  type Challenge {
    id: ID!
    slug: String!
    title: String!
    description: String!
    inputSpec: String!
    outputSpec: String!
    difficulty: String!
    submissionWindowClosesAt: String!
    ladderStarted: Boolean!
    submissionCount: Int!
    bracket: Bracket
  }

  type Submission {
    id: ID!
    challengeId: ID!
    gladiatorAlias: String!
    language: String!
    submittedAt: String!
    executionResult: ExecutionResult
  }

  type ExecutionResult {
    runtimeMs: Int
    peakMemoryBytes: Int
    testCasesPassed: Int
    testCasesTotal: Int
    timedOut: Boolean!
    score: Float
  }

  type Bracket {
    challengeId: ID!
    rounds: [Round!]!
    champion: Submission
    winAnalysis: WinAnalysis
  }

  type Round {
    id: ID!
    roundNumber: Int!
    status: String!
    matchups: [Matchup!]!
  }

  type Matchup {
    id: ID!
    submissionA: Submission!
    submissionB: Submission
    winner: Submission
    status: String!
    decidedAt: String
    winReason: String
  }

  type WinAnalysis {
    id: ID!
    analysisMarkdown: String!
    generatedAt: String!
  }

  type AuthPayload {
    token: String!
    gladiatorAlias: String!
    isNewUser: Boolean!
  }

  input CreateChallengeInput {
    slug: String!
    title: String!
    description: String!
    inputSpec: String!
    outputSpec: String!
    difficulty: String!
    testCasesS3Key: String!
    submissionWindowClosesAt: String!
  }

  type Query {
    challenge(slug: String!): Challenge
    challenges(limit: Int, offset: Int): [Challenge!]!
    mySubmissions(challengeId: ID!): [Submission!]!
    bracket(challengeId: ID!): Bracket
    leaderboard(challengeId: ID!): [Submission!]!
  }

  type Mutation {
    submitCode(challengeId: ID!, language: String!, code: String!): Submission!
    createChallenge(input: CreateChallengeInput!): Challenge!
  }
`;
