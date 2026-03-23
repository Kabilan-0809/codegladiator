import React from 'react';
import { useQuery } from '@apollo/client';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth';
import { GET_CHALLENGES } from '../queries';

interface Challenge {
  id: string;
  slug: string;
  title: string;
  description: string;
  difficulty: string;
  submissionWindowClosesAt: string;
  ladderStarted: boolean;
  submissionCount: number;
}

function timeRemaining(closesAt: string): string {
  const diff = new Date(closesAt).getTime() - Date.now();
  if (diff <= 0) return 'Closed';
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return `${hours}h ${mins}m`;
}

function DifficultyBadge({ difficulty }: { difficulty: string }) {
  const cls = difficulty === 'easy' ? 'badge-easy' : difficulty === 'medium' ? 'badge-medium' : 'badge-hard';
  return <span className={cls}>{difficulty}</span>;
}

export default function HomePage() {
  const { alias } = useAuth();
  const { data, loading } = useQuery<{ challenges: Challenge[] }>(GET_CHALLENGES, {
    variables: { limit: 20, offset: 0 },
  });

  return (
    <div className="min-h-screen bg-arena-bg">
      {/* Header */}
      <header className="border-b border-arena-border bg-arena-surface/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-extrabold tracking-tight">
              <span className="text-arena-accent">⚔</span> CodeGladiator
            </h1>
            <span className="text-xs text-arena-muted font-mono bg-arena-bg px-2 py-1 rounded">ARENA</span>
          </div>
          {alias && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-arena-muted">You are:</span>
              <span className="font-mono font-bold text-arena-accent">{alias} ⚔</span>
            </div>
          )}
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-7xl mx-auto px-6 py-10">
        <div className="mb-8">
          <h2 className="text-3xl font-bold mb-2">Active Challenges</h2>
          <p className="text-arena-muted">Submit your solution and watch it fight in the arena</p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="animate-spin w-8 h-8 border-2 border-arena-accent border-t-transparent rounded-full" />
          </div>
        ) : (
          <div className="grid gap-4">
            {data?.challenges.map((challenge) => (
              <Link
                key={challenge.id}
                to={`/challenge/${challenge.slug}`}
                id={`challenge-${challenge.slug}`}
                className="card hover:border-arena-accent/50 transition-all duration-200 group cursor-pointer"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="text-xl font-bold group-hover:text-arena-accent transition-colors">
                        {challenge.title}
                      </h3>
                      <DifficultyBadge difficulty={challenge.difficulty} />
                      {challenge.ladderStarted && (
                        <span className="flex items-center gap-1.5 text-xs font-mono text-arena-teal">
                          <span className="live-dot" /> LIVE
                        </span>
                      )}
                    </div>
                    <p className="text-arena-muted text-sm line-clamp-2 mb-3">
                      {challenge.description}
                    </p>
                    <div className="flex items-center gap-6 text-xs text-arena-muted font-mono">
                      <span>⚔ {challenge.submissionCount} gladiators</span>
                      <span>⏱ {timeRemaining(challenge.submissionWindowClosesAt)}</span>
                    </div>
                  </div>
                  <div className="text-arena-muted group-hover:text-arena-accent transition-colors text-2xl ml-4">
                    →
                  </div>
                </div>
              </Link>
            ))}

            {data?.challenges.length === 0 && (
              <div className="text-center py-20 text-arena-muted">
                <p className="text-lg">No active challenges yet</p>
                <p className="text-sm mt-2">Check back soon for new battles</p>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
