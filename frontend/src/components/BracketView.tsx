import React from 'react';

interface MatchupData {
  id: string;
  submissionA: { id: string; gladiatorAlias: string; language: string };
  submissionB: { id: string; gladiatorAlias: string; language: string } | null;
  winner: { id: string; gladiatorAlias: string } | null;
  status: string;
  decidedAt: string | null;
  winReason: string | null;
}

interface RoundData {
  id: string;
  roundNumber: number;
  status: string;
  matchups: MatchupData[];
}

interface BracketData {
  challengeId: string;
  rounds: RoundData[];
  champion: { id: string; gladiatorAlias: string; language: string } | null;
  winAnalysis: { id: string; analysisMarkdown: string; generatedAt: string } | null;
}

const MATCHUP_WIDTH = 200;
const MATCHUP_HEIGHT = 70;
const MATCHUP_GAP_X = 80;
const MATCHUP_GAP_Y = 20;

function MatchupBox({ matchup, x, y }: { matchup: MatchupData; x: number; y: number }) {
  const isComplete = matchup.status === 'complete';
  const isPending = matchup.status === 'pending';
  const isRunning = matchup.status === 'running';

  const winnerIsA = matchup.winner?.id === matchup.submissionA.id;
  const winnerIsB = matchup.winner?.id === matchup.submissionB?.id;

  return (
    <g transform={`translate(${x}, ${y})`}>
      {/* Box background */}
      <rect
        width={MATCHUP_WIDTH}
        height={MATCHUP_HEIGHT}
        rx={8}
        ry={8}
        fill={isComplete ? '#1a1a22' : '#0f0f13'}
        stroke={isRunning ? '#14b8a6' : isComplete ? '#2a2a35' : '#2a2a35'}
        strokeWidth={isRunning ? 2 : 1}
        className={isRunning ? 'animate-pulse' : ''}
      />

      {/* Divider */}
      <line x1={0} y1={MATCHUP_HEIGHT / 2} x2={MATCHUP_WIDTH} y2={MATCHUP_HEIGHT / 2} stroke="#2a2a35" strokeWidth={1} />

      {/* Submission A */}
      <text
        x={10}
        y={MATCHUP_HEIGHT / 2 - 10}
        fill={isComplete && winnerIsA ? '#f59e0b' : '#d1d5db'}
        fontSize={12}
        fontFamily="JetBrains Mono, monospace"
        fontWeight={winnerIsA ? 'bold' : 'normal'}
      >
        {winnerIsA && '👑 '}{matchup.submissionA.gladiatorAlias}
      </text>

      {/* Submission B */}
      <text
        x={10}
        y={MATCHUP_HEIGHT / 2 + 22}
        fill={isComplete && winnerIsB ? '#f59e0b' : matchup.submissionB ? '#d1d5db' : '#6b7280'}
        fontSize={12}
        fontFamily="JetBrains Mono, monospace"
        fontWeight={winnerIsB ? 'bold' : 'normal'}
      >
        {winnerIsB && '👑 '}{matchup.submissionB?.gladiatorAlias || (isPending ? 'vs ?' : 'BYE')}
      </text>

      {/* Status indicator */}
      {isRunning && (
        <circle cx={MATCHUP_WIDTH - 15} cy={MATCHUP_HEIGHT / 2} r={4} fill="#14b8a6" className="animate-pulse" />
      )}
    </g>
  );
}

export default function BracketView({ bracket }: { bracket: BracketData }) {
  if (!bracket.rounds || bracket.rounds.length === 0) {
    return <p className="text-arena-muted text-center py-4">No bracket data yet</p>;
  }

  const totalRounds = bracket.rounds.length;
  const maxMatchups = Math.max(...bracket.rounds.map((r) => r.matchups.length));
  const svgWidth = totalRounds * (MATCHUP_WIDTH + MATCHUP_GAP_X) + 50;
  const svgHeight = maxMatchups * (MATCHUP_HEIGHT + MATCHUP_GAP_Y) + 50;

  return (
    <div className="overflow-x-auto">
      <svg
        width={svgWidth}
        height={svgHeight}
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        className="min-w-full"
      >
        {/* Round headers */}
        {bracket.rounds.map((round, ri) => {
          const x = ri * (MATCHUP_WIDTH + MATCHUP_GAP_X) + 20;
          return (
            <text
              key={`header-${round.id}`}
              x={x + MATCHUP_WIDTH / 2}
              y={20}
              fill="#6b7280"
              fontSize={11}
              fontFamily="JetBrains Mono, monospace"
              textAnchor="middle"
            >
              Round {round.roundNumber}
            </text>
          );
        })}

        {/* Matchups and connectors */}
        {bracket.rounds.map((round, ri) => {
          const matchupCount = round.matchups.length;
          const totalHeight = matchupCount * (MATCHUP_HEIGHT + MATCHUP_GAP_Y);
          const startY = (svgHeight - totalHeight) / 2;
          const x = ri * (MATCHUP_WIDTH + MATCHUP_GAP_X) + 20;

          return round.matchups.map((matchup, mi) => {
            const y = startY + mi * (MATCHUP_HEIGHT + MATCHUP_GAP_Y);

            // Draw connector to next round
            const connectorElements: React.ReactElement[] = [];
            if (ri < totalRounds - 1) {
              const nextX = (ri + 1) * (MATCHUP_WIDTH + MATCHUP_GAP_X) + 20;
              const nextRound = bracket.rounds[ri + 1];
              if (nextRound) {
                const nextMatchupCount = nextRound.matchups.length;
                const nextTotalHeight = nextMatchupCount * (MATCHUP_HEIGHT + MATCHUP_GAP_Y);
                const nextStartY = (svgHeight - nextTotalHeight) / 2;
                const nextMi = Math.floor(mi / 2);
                const nextY = nextStartY + nextMi * (MATCHUP_HEIGHT + MATCHUP_GAP_Y);

                connectorElements.push(
                  <line
                    key={`connector-${matchup.id}`}
                    x1={x + MATCHUP_WIDTH}
                    y1={y + MATCHUP_HEIGHT / 2}
                    x2={nextX}
                    y2={nextY + MATCHUP_HEIGHT / 2}
                    stroke="#2a2a35"
                    strokeWidth={1}
                  />
                );
              }
            }

            return (
              <g key={matchup.id}>
                {connectorElements}
                <MatchupBox matchup={matchup} x={x} y={y} />
              </g>
            );
          });
        })}
      </svg>
    </div>
  );
}
