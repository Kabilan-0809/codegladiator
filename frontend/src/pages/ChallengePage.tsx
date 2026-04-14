import React, { useState, useRef, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation } from '@apollo/client';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { python } from '@codemirror/lang-python';
import { javascript } from '@codemirror/lang-javascript';
import { cpp } from '@codemirror/lang-cpp';
import { oneDark } from '@codemirror/theme-one-dark';
import { marked } from 'marked';
import { useAuth } from '../auth';
import { useWebSocket, type BattleEvent } from '../useWebSocket';
import { GET_CHALLENGE, GET_MY_SUBMISSIONS, SUBMIT_CODE } from '../queries';
import BracketView from '../components/BracketView';

interface Challenge {
  id: string;
  slug: string;
  title: string;
  description: string;
  inputSpec: string;
  outputSpec: string;
  difficulty: string;
  submissionWindowClosesAt: string;
  ladderStarted: boolean;
  submissionCount: number;
  bracket: {
    challengeId: string;
    rounds: Array<{
      id: string;
      roundNumber: number;
      status: string;
      matchups: Array<{
        id: string;
        submissionA: { id: string; gladiatorAlias: string; language: string };
        submissionB: { id: string; gladiatorAlias: string; language: string } | null;
        winner: { id: string; gladiatorAlias: string } | null;
        status: string;
        decidedAt: string | null;
        winReason: string | null;
      }>;
    }>;
    champion: { id: string; gladiatorAlias: string; language: string } | null;
    winAnalysis: { id: string; analysisMarkdown: string; generatedAt: string } | null;
  } | null;
}

interface Submission {
  id: string;
  gladiatorAlias: string;
  language: string;
  submittedAt: string;
  executionResult: {
    runtimeMs: number;
    peakMemoryBytes: number;
    testCasesPassed: number;
    testCasesTotal: number;
    timedOut: boolean;
    score: number;
  } | null;
}

const LANGUAGES = [
  { value: 'python', label: 'Python' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'go', label: 'Go' },
  { value: 'rust', label: 'Rust' },
  { value: 'cpp', label: 'C++' },
];

const LANGUAGE_EXTENSIONS: Record<string, () => ReturnType<typeof python>> = {
  python: python,
  javascript: javascript,
  cpp: cpp,
  go: javascript, // fallback
  rust: cpp, // fallback
};

const STARTER_CODE: Record<string, string> = {
  python: '# Your solution here\nimport sys\n\ndef solve():\n    n = int(input())\n    nums = list(map(int, input().split()))\n    print(sum(nums))\n\nsolve()\n',
  javascript: '// Your solution here\nconst readline = require("readline");\nconst rl = readline.createInterface({ input: process.stdin });\nconst lines = [];\nrl.on("line", (line) => lines.push(line));\nrl.on("close", () => {\n  const n = parseInt(lines[0]);\n  const nums = lines[1].split(" ").map(Number);\n  console.log(nums.reduce((a, b) => a + b, 0));\n});\n',
  go: 'package main\n\nimport "fmt"\n\nfunc main() {\n    var n int\n    fmt.Scan(&n)\n    sum := 0\n    for i := 0; i < n; i++ {\n        var x int\n        fmt.Scan(&x)\n        sum += x\n    }\n    fmt.Println(sum)\n}\n',
  rust: 'use std::io;\n\nfn main() {\n    let mut input = String::new();\n    io::stdin().read_line(&mut input).unwrap();\n    let n: usize = input.trim().parse().unwrap();\n    input.clear();\n    io::stdin().read_line(&mut input).unwrap();\n    let sum: i64 = input.trim().split_whitespace()\n        .map(|x| x.parse::<i64>().unwrap())\n        .sum();\n    println!("{}", sum);\n}\n',
  cpp: '#include <iostream>\nusing namespace std;\n\nint main() {\n    int n;\n    cin >> n;\n    long long sum = 0;\n    for (int i = 0; i < n; i++) {\n        int x;\n        cin >> x;\n        sum += x;\n    }\n    cout << sum << endl;\n    return 0;\n}\n',
};

function EventCard({ event }: { event: BattleEvent }) {
  switch (event.type) {
    case 'MATCHUP_COMPLETE':
      return (
        <div className="animate-fade-in-up winner-banner mb-3">
          <div className="flex items-center justify-between mb-2">
            <span className="font-mono font-bold text-white">{event.aliasA as string}</span>
            <span className="text-arena-muted text-xs">VS</span>
            <span className="font-mono font-bold text-white">{event.aliasB as string}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs font-mono mb-2">
            <div className="text-center">
              <span className="text-arena-muted">Score:</span> <span className={event.winnerAlias === event.aliasA ? 'text-arena-accent' : 'text-arena-red'}>{(event.scoreA as number)?.toFixed(1)}%</span>
            </div>
            <div className="text-center">
              <span className="text-arena-muted">Score:</span> <span className={event.winnerAlias === event.aliasB ? 'text-arena-accent' : 'text-arena-red'}>{(event.scoreB as number)?.toFixed(1)}%</span>
            </div>
          </div>
          <div className="text-center text-sm">
            <span className="text-arena-accent font-bold">⚔ {event.winnerAlias as string} wins</span>
            <span className="text-arena-muted ml-2 text-xs">— {event.winReason as string}</span>
          </div>
        </div>
      );

    case 'ROUND_COMPLETE':
      return (
        <div className="animate-slide-in bg-arena-teal/10 border border-arena-teal/30 rounded-lg p-3 mb-3">
          <p className="text-arena-teal font-bold text-sm">
            🏟 Round {event.roundNumber as number} complete — {(event.advancingAliases as string[])?.length} gladiators advance
          </p>
          <div className="flex flex-wrap gap-1 mt-1">
            {(event.advancingAliases as string[])?.map((alias) => (
              <span key={alias} className="text-xs font-mono bg-arena-teal/20 px-1.5 py-0.5 rounded">{alias}</span>
            ))}
          </div>
        </div>
      );

    case 'CHAMPION_CROWNED':
      return (
        <div className="animate-fade-in-up champion-banner mb-3">
          <p className="text-3xl mb-2">👑</p>
          <p className="text-2xl font-extrabold text-arena-accent">{event.championAlias as string}</p>
          <p className="text-arena-muted mt-1">is the Champion!</p>
        </div>
      );

    case 'EXECUTION_COMPLETE':
      return (
        <div className="animate-slide-in bg-arena-bg/50 border border-arena-border rounded p-2 mb-2 text-xs">
          <span className="font-mono text-arena-accent">{event.gladiatorAlias as string}</span>
          <span className="text-arena-muted">'s solution scored </span>
          <span className="font-bold">{(event.score as number)?.toFixed(1)}</span>
        </div>
      );

    case 'BRACKET_STARTED':
      return (
        <div className="animate-fade-in-up bg-arena-accent/10 border border-arena-accent/30 rounded-lg p-3 mb-3">
          <p className="text-arena-accent font-bold">⚔ Battle has begun!</p>
          <p className="text-xs text-arena-muted mt-1">
            {event.totalSubmissions as number} gladiators • {event.totalRounds as number} rounds
          </p>
        </div>
      );

    default:
      return null;
  }
}

export default function ChallengePage() {
  const { slug } = useParams<{ slug: string }>();
  const { alias } = useAuth();
  const [language, setLanguage] = useState('python');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  const { data, loading, refetch } = useQuery<{ challenge: Challenge }>(GET_CHALLENGE, {
    variables: { slug },
    skip: !slug,
  });

  const { data: mySubsData } = useQuery<{ mySubmissions: Submission[] }>(GET_MY_SUBMISSIONS, {
    variables: { challengeId: data?.challenge?.id },
    skip: !data?.challenge?.id,
  });

  const [submitCode] = useMutation(SUBMIT_CODE);
  const wsState = useWebSocket(data?.challenge?.id);

  const challenge = data?.challenge;
  const hasSubmission = (mySubsData?.mySubmissions?.length ?? 0) > 0;
  const windowClosed = challenge ? new Date(challenge.submissionWindowClosesAt) < new Date() : false;

  // Initialize CodeMirror
  useEffect(() => {
    if (!editorRef.current || viewRef.current) return;

    const langExt = LANGUAGE_EXTENSIONS[language] || python;
    const state = EditorState.create({
      doc: STARTER_CODE[language] || '',
      extensions: [basicSetup, langExt(), oneDark],
    });

    viewRef.current = new EditorView({
      state,
      parent: editorRef.current,
    });

    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, []);

  // Update language extensions
  useEffect(() => {
    if (!viewRef.current) return;
    const langExt = LANGUAGE_EXTENSIONS[language] || python;

    const state = EditorState.create({
      doc: STARTER_CODE[language] || '',
      extensions: [basicSetup, langExt(), oneDark],
    });

    viewRef.current.setState(state);
  }, [language]);

  const handleSubmit = async () => {
    if (!challenge || !viewRef.current) return;
    const code = viewRef.current.state.doc.toString();

    setSubmitting(true);
    try {
      await submitCode({
        variables: {
          challengeId: challenge.id,
          language,
          code,
        },
      });
      setSubmitted(true);
      refetch();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Submission failed');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-arena-bg flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-2 border-arena-accent border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!challenge) {
    return (
      <div className="min-h-screen bg-arena-bg flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-2xl font-bold mb-2">Challenge not found</h2>
          <Link to="/" className="text-arena-accent hover:underline">← Back to arena</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-arena-bg">
      {/* Header */}
      <header className="border-b border-arena-border bg-arena-surface/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-screen-2xl mx-auto px-6 py-3 flex justify-between items-center">
          <div className="flex items-center gap-4">
            <Link to="/" className="text-arena-muted hover:text-white transition-colors">← Arena</Link>
            <h1 className="text-lg font-bold">{challenge.title}</h1>
            <span className={`badge-${challenge.difficulty}`}>{challenge.difficulty}</span>
            {wsState.connected ? (
              <span className="flex items-center gap-1.5 text-xs font-mono text-arena-teal">
                <span className="live-dot" /> LIVE
              </span>
            ) : (
              <span className="text-xs font-mono text-arena-muted">○ Reconnecting...</span>
            )}
          </div>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-arena-muted">👁 {wsState.viewerCount} watching</span>
            {alias && <span className="font-mono text-arena-accent">{alias} ⚔</span>}
          </div>
        </div>
      </header>

      {/* Split Panel */}
      <div className="max-w-screen-2xl mx-auto px-6 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left Panel - Code */}
          <div className="space-y-4">
            <div className="card">
              <h2 className="text-xl font-bold mb-3">{challenge.title}</h2>
              <p className="text-gray-300 text-sm mb-4 leading-relaxed">{challenge.description}</p>
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div className="bg-arena-bg rounded-lg p-3">
                  <h4 className="text-xs text-arena-muted font-mono mb-1">INPUT</h4>
                  <p className="text-sm font-mono text-gray-300">{challenge.inputSpec}</p>
                </div>
                <div className="bg-arena-bg rounded-lg p-3">
                  <h4 className="text-xs text-arena-muted font-mono mb-1">OUTPUT</h4>
                  <p className="text-sm font-mono text-gray-300">{challenge.outputSpec}</p>
                </div>
              </div>
            </div>

            {/* Code Editor */}
            <div className="card p-0 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2 border-b border-arena-border">
                <select
                  id="language-selector"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  disabled={hasSubmission || windowClosed}
                  className="bg-arena-bg border border-arena-border rounded px-3 py-1.5 text-sm font-mono
                           text-white focus:outline-none focus:border-arena-accent"
                >
                  {LANGUAGES.map((l) => (
                    <option key={l.value} value={l.value}>{l.label}</option>
                  ))}
                </select>
                <span className="text-xs text-arena-muted font-mono">⚔ {challenge.submissionCount} gladiators</span>
              </div>
              <div ref={editorRef} className="h-80 bg-arena-bg" id="code-editor" />
            </div>

            {/* Submit Button */}
            {hasSubmission || submitted ? (
              <div className="bg-arena-accent/10 border border-arena-accent/30 rounded-lg p-4 text-center">
                <p className="font-mono text-arena-accent font-bold">✓ Your solution is in the arena</p>
                {mySubsData?.mySubmissions?.[0]?.executionResult && (
                  <p className="text-sm text-arena-muted mt-1">
                    Score: {mySubsData.mySubmissions[0].executionResult.score?.toFixed(1)}% •
                    Runtime: {mySubsData.mySubmissions[0].executionResult.runtimeMs}ms •
                    Tests: {mySubsData.mySubmissions[0].executionResult.testCasesPassed}/{mySubsData.mySubmissions[0].executionResult.testCasesTotal}
                  </p>
                )}
              </div>
            ) : windowClosed ? (
              <div className="btn-disabled text-center">
                Submissions closed — battle in progress
              </div>
            ) : (
              <button
                id="submit-button"
                onClick={handleSubmit}
                disabled={submitting}
                className={submitting ? 'btn-disabled w-full' : 'btn-primary w-full'}
              >
                {submitting ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="animate-spin w-4 h-4 border-2 border-black border-t-transparent rounded-full" />
                    Testing your solution...
                  </span>
                ) : (
                  '⚔ Enter the Arena'
                )}
              </button>
            )}
          </div>

          {/* Right Panel - Live Feed */}
          <div className="space-y-4">
            <div className="card">
              <h3 className="font-bold text-sm text-arena-muted mb-3 flex items-center gap-2">
                <span className="live-dot" /> LIVE BATTLE FEED
              </h3>
              <div className="space-y-0 max-h-96 overflow-y-auto">
                {wsState.events.length === 0 ? (
                  <p className="text-arena-muted text-sm text-center py-8">
                    Waiting for battle to begin...
                  </p>
                ) : (
                  wsState.events.map((event, i) => (
                    <EventCard key={`${event.type}-${i}`} event={event} />
                  ))
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Bracket Visualization */}
        {challenge.bracket && (
          <div className="mt-8">
            <div className="card">
              <h3 className="font-bold text-lg mb-4 flex items-center gap-2">
                🏆 Tournament Bracket
              </h3>
              <BracketView bracket={challenge.bracket} />
            </div>
          </div>
        )}

        {/* Champion Analysis */}
        {challenge.bracket?.winAnalysis && (
          <div className="mt-8 animate-fade-in-up">
            <div className="champion-banner">
              <h3 className="text-2xl font-extrabold text-arena-accent mb-4">
                ⚔ Champion's Review — {challenge.bracket.champion?.gladiatorAlias}
              </h3>
              <div
                className="analysis-content prose prose-invert max-w-none"
                dangerouslySetInnerHTML={{
                  __html: marked(challenge.bracket.winAnalysis.analysisMarkdown) as string,
                }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
