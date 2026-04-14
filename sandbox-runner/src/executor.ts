import Dockerode from 'dockerode';
import { Readable } from 'stream';
import { logger } from './logger.js';
import {
  type ExecuteRequest,
  type ExecutionResult,
  type TestCase,
  LANGUAGE_CONFIG,
} from './schemas.js';

const docker = new Dockerode({ socketPath: '/var/run/docker.sock' });

const TIMEOUT_MS = 10_000;
const MEMORY_LIMIT = 134_217_728; // 128MB
const NANO_CPUS = 500_000_000; // 0.5 CPU
const PIDS_LIMIT = 64;

// collectStream removed as it was unused

async function runSingleTestCase(
  image: string,
  code: string,
  ext: string,
  language: ExecuteRequest['language'],
  testCase: TestCase,
  _submissionId: string
): Promise<{ passed: boolean; stdout: string; stderr: string; runtimeMs: number; peakMemoryBytes: number; exitCode: number; timedOut: boolean }> {
  const langConfig = LANGUAGE_CONFIG[language];
  const fileName = `/code/solution.${ext}`;

  // Build the command: for compiled languages, chain compile + run
  let cmd: string[];
  if (langConfig.compileCmd) {
    cmd = ['sh', '-c', `${langConfig.compileCmd.join(' ')} && echo '${testCase.input}' | ${langConfig.runCmd(fileName).join(' ')}`];
  } else {
    cmd = ['sh', '-c', `echo '${testCase.input.replace(/'/g, "'\\''")}' | ${langConfig.runCmd(fileName).join(' ')}`];
  }

  const container = await docker.createContainer({
    Image: image,
    Cmd: cmd,
    HostConfig: {
      Memory: MEMORY_LIMIT,
      NanoCpus: NANO_CPUS,
      PidsLimit: PIDS_LIMIT,
      NetworkMode: 'none',
      AutoRemove: true,
    },
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    WorkingDir: '/code',
  });

  // Write code to container
  const codeBuffer = Buffer.from(code);
  const tarHeader = createTarEntry(`solution.${ext}`, codeBuffer);
  await container.putArchive(tarHeader, { path: '/code' });

  const startTime = Date.now();
  await container.start();

  let peakMemoryBytes = 0;
  // Start monitoring memory in background
  (async () => {
    try {
      const statsStream = await container.stats({ stream: true }) as unknown as NodeJS.ReadableStream;
      const reader = new Readable().wrap(statsStream);
      reader.on('data', (chunk: Buffer) => {
        try {
          const stats = JSON.parse(chunk.toString());
          if (stats.memory_stats?.usage) {
            peakMemoryBytes = Math.max(peakMemoryBytes, stats.memory_stats.usage);
          }
        } catch {
          // ignore parse errors in stat stream
        }
      });
    } catch {
      // Stats may fail if container exits quickly
    }
  })();

  // Race between container completion and timeout
  const timedOut = await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(async () => {
      try {
        await container.kill();
      } catch {
        // Container may have already exited
      }
      resolve(true);
    }, TIMEOUT_MS);

    container.wait().then(() => {
      clearTimeout(timeout);
      resolve(false);
    }).catch(() => {
      clearTimeout(timeout);
      resolve(false);
    });
  });

  const runtimeMs = Date.now() - startTime;

  if (timedOut) {
    return { passed: false, stdout: '', stderr: 'Execution timed out', runtimeMs, peakMemoryBytes, exitCode: -1, timedOut: true };
  }

  // Get logs
  const logs = await container.logs({ stdout: true, stderr: true, follow: false });

  // Demux stdout/stderr from Docker stream
  const stdout = demuxDockerStream(logs, 1);
  const stderr = demuxDockerStream(logs, 2);

  const inspection = await container.inspect().catch(() => null);
  const exitCode = inspection?.State?.ExitCode ?? -1;

  const actualOutput = stdout.trim();
  const expectedOutput = testCase.expected_output.trim();
  const passed = actualOutput === expectedOutput;

  return { passed, stdout: actualOutput, stderr, runtimeMs, peakMemoryBytes, exitCode, timedOut: false };
}

function demuxDockerStream(buffer: Buffer, targetStream: number): string {
  const results: string[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) break;
    const streamType = buffer[offset];
    const size = buffer.readUInt32BE(offset + 4);
    offset += 8;
    if (offset + size > buffer.length) break;
    if (streamType === targetStream) {
      results.push(buffer.subarray(offset, offset + size).toString('utf-8'));
    }
    offset += size;
  }
  return results.join('');
}

function createTarEntry(filename: string, content: Buffer): Buffer {
  // Create a minimal tar archive with a single file
  const header = Buffer.alloc(512);

  // Filename
  header.write(filename, 0, 100, 'utf-8');
  // File mode (0644)
  header.write('0000644\0', 100, 8, 'utf-8');
  // uid
  header.write('0000000\0', 108, 8, 'utf-8');
  // gid
  header.write('0000000\0', 116, 8, 'utf-8');
  // File size in octal
  header.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf-8');
  // Modified time
  header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12, 'utf-8');
  // Checksum placeholder (spaces)
  header.write('        ', 148, 8, 'utf-8');
  // Type flag (0 = normal file)
  header.write('0', 156, 1, 'utf-8');

  // Calculate checksum
  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += header[i]!;
  }
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf-8');

  // Pad content to 512-byte boundary
  const paddedSize = Math.ceil(content.length / 512) * 512;
  const paddedContent = Buffer.alloc(paddedSize);
  content.copy(paddedContent);

  // End-of-archive marker (two 512-byte zero blocks)
  const endMarker = Buffer.alloc(1024);

  return Buffer.concat([header, paddedContent, endMarker]);
}

export async function executeSubmission(
  request: ExecuteRequest,
  testCases: TestCase[]
): Promise<ExecutionResult> {
  const langConfig = LANGUAGE_CONFIG[request.language];
  const { image, ext } = langConfig;

  logger.info({
    message: 'Starting execution',
    submissionId: request.submissionId,
    language: request.language,
    testCaseCount: testCases.length,
  });

  // Ensure image exists
  try {
    await docker.getImage(image).inspect();
  } catch {
    logger.info({ message: 'Pulling Docker image', image });
    await new Promise<void>((resolve, reject) => {
      docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err2: Error | null) => {
          if (err2) return reject(err2);
          resolve();
        });
      });
    });
  }

  let totalPassed = 0;
  let totalRuntimeMs = 0;
  let maxMemory = 0;
  let lastExitCode = 0;
  let lastStdout = '';
  let lastStderr = '';
  let wasTimedOut = false;

  for (const testCase of testCases) {
    const result = await runSingleTestCase(
      image,
      request.code,
      ext,
      request.language,
      testCase,
      request.submissionId
    );

    if (result.timedOut) {
      wasTimedOut = true;
      totalRuntimeMs += result.runtimeMs;
      break;
    }

    if (result.passed) totalPassed++;
    totalRuntimeMs += result.runtimeMs;
    maxMemory = Math.max(maxMemory, result.peakMemoryBytes);
    lastExitCode = result.exitCode;
    lastStdout = result.stdout;
    lastStderr = result.stderr;
  }

  const execResult: ExecutionResult = {
    submissionId: request.submissionId,
    runtimeMs: totalRuntimeMs,
    peakMemoryBytes: maxMemory,
    testCasesPassed: totalPassed,
    testCasesTotal: testCases.length,
    exitCode: lastExitCode,
    timedOut: wasTimedOut,
    stdout: lastStdout,
    stderr: lastStderr,
  };

  logger.info({
    message: 'Execution complete',
    submissionId: request.submissionId,
    language: request.language,
    exitCode: execResult.exitCode,
    timedOut: execResult.timedOut,
    testCasesPassed: execResult.testCasesPassed,
    testCasesTotal: execResult.testCasesTotal,
    runtimeMs: execResult.runtimeMs,
  });

  return execResult;
}
