import { z } from 'zod';

const ALLOWED_LANGUAGES = ['python', 'javascript', 'go', 'rust', 'cpp'] as const;

export const ExecuteRequestSchema = z.object({
  submissionId: z
    .string()
    .regex(/^[a-zA-Z0-9-]+$/, 'submissionId must be alphanumeric with dashes only'),
  language: z.enum(ALLOWED_LANGUAGES),
  code: z.string().min(1).max(50000),
  testCasesS3Key: z.string().min(1),
  challengeId: z.string().uuid(),
});

export type ExecuteRequest = z.infer<typeof ExecuteRequestSchema>;

export const TestCaseSchema = z.object({
  input: z.string(),
  expected_output: z.string(),
});

export const TestCasesSchema = z.array(TestCaseSchema);

export type TestCase = z.infer<typeof TestCaseSchema>;

export interface ExecutionResult {
  submissionId: string;
  runtimeMs: number;
  peakMemoryBytes: number;
  testCasesPassed: number;
  testCasesTotal: number;
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export const LANGUAGE_CONFIG: Record<
  (typeof ALLOWED_LANGUAGES)[number],
  { image: string; ext: string; compileCmd?: string[]; runCmd: (file: string) => string[] }
> = {
  python: {
    image: 'python:3.12-alpine',
    ext: 'py',
    runCmd: (file) => ['python', file],
  },
  javascript: {
    image: 'node:20-alpine',
    ext: 'js',
    runCmd: (file) => ['node', file],
  },
  go: {
    image: 'golang:1.22-alpine',
    ext: 'go',
    runCmd: (file) => ['go', 'run', file],
  },
  rust: {
    image: 'rust:1.77-alpine',
    ext: 'rs',
    compileCmd: ['rustc', '-o', '/tmp/solution', '/code/solution.rs'],
    runCmd: () => ['/tmp/solution'],
  },
  cpp: {
    image: 'gcc:13-alpine',
    ext: 'cpp',
    compileCmd: ['g++', '-O2', '-o', '/tmp/solution', '/code/solution.cpp'],
    runCmd: () => ['/tmp/solution'],
  },
};
