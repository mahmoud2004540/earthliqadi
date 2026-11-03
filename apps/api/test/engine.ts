import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_BINARY = resolve(
  __dirname,
  '../../../services/matching-engine/target/debug/engine-server',
);

/** Runs the real Rust engine-server against the test database. */
export class EngineProcess {
  private child: ChildProcess | null = null;
  readonly logs: string[] = [];
  exitCode: number | null = null;

  static binary(): string {
    const path = process.env.ENGINE_BINARY ?? DEFAULT_BINARY;
    if (!existsSync(path)) {
      throw new Error(
        `Matching engine binary not found at ${path}. Build it with: cargo build --manifest-path services/matching-engine/Cargo.toml`,
      );
    }
    return path;
  }

  /** Starts the engine and resolves once it logs "engine ready" (or rejects if it exits). */
  start(timeoutMs = 20_000): Promise<void> {
    this.exitCode = null;
    const child = spawn(EngineProcess.binary(), [], {
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, ENGINE_POLL_MS: '20' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`engine did not become ready:\n${this.logs.join('\n')}`)),
        timeoutMs,
      );
      const onLine = (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          this.logs.push(line);
          if (line.includes('"engine ready"')) {
            clearTimeout(timer);
            resolvePromise();
          }
        }
      };
      child.stdout?.on('data', onLine);
      child.stderr?.on('data', onLine);
      child.on('exit', (code) => {
        this.exitCode = code;
        clearTimeout(timer);
        reject(new Error(`engine exited with code ${code}:\n${this.logs.join('\n')}`));
      });
    });
  }

  /** Waits for the process to exit by itself (used to assert refusal to start). */
  waitForExit(timeoutMs = 20_000): Promise<number | null> {
    return new Promise((resolvePromise, reject) => {
      if (this.exitCode !== null) return resolvePromise(this.exitCode);
      const timer = setTimeout(() => reject(new Error('engine did not exit')), timeoutMs);
      this.child?.on('exit', (code) => {
        clearTimeout(timer);
        resolvePromise(code);
      });
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolvePromise) => {
      child.on('exit', () => resolvePromise());
      child.kill('SIGKILL');
    });
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
