import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

const SERVER_DIR = path.resolve(__dirname, '..', '..');

export interface SpawnedServer {
  baseUrl: string;
  dataDir: string;
  dbDir: string;
  output: () => string;
  stop: () => Promise<void>;
}

export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ttsu-${prefix}-`));
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

function startProcess(env: Record<string, string | undefined>): ChildProcess {
  return spawn(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', path.join('src', 'index.ts')],
    {
      cwd: SERVER_DIR,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

/**
 * Starts src/index.ts exactly as the container does (env-configured, real listen).
 * Used by the legacy characterization suite so it exercises the real entry point,
 * before and after any internal refactor.
 */
export async function spawnServer(env: Record<string, string | undefined>): Promise<SpawnedServer> {
  const port = await freePort();
  const dataDir = env.DATA_DIR ?? makeTempDir('data');
  const dbDir = env.DB_DIR ?? makeTempDir('db');
  const child = startProcess({ PORT: String(port), DATA_DIR: dataDir, DB_DIR: dbDir, ...env });

  let out = '';
  child.stdout!.on('data', (d) => (out += d.toString()));
  child.stderr!.on('data', (d) => (out += d.toString()));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 25_000);
    const check = () => {
      if (out.includes('running on port')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout!.on('data', check);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${code}):\n${out}`));
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    dataDir,
    dbDir,
    output: () => out,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill();
      }),
  };
}

/** Runs src/index.ts and waits for it to exit (for startup-failure tests). */
export async function runUntilExit(
  env: Record<string, string | undefined>,
): Promise<{ code: number | null; output: string }> {
  const child = startProcess(env);
  let out = '';
  child.stdout!.on('data', (d) => (out += d.toString()));
  child.stderr!.on('data', (d) => (out += d.toString()));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`process did not exit:\n${out}`));
    }, 25_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output: out });
    });
  });
}
