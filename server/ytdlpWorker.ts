// @ts-nocheck
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

/** @param {string} bin */
function findYtDlp() {
  const env = process.env.YT_DLP_BIN;
  if (env && fs.existsSync(env)) return env;
  return 'yt-dlp';
}

/** Netscape-format cookies.txt — needed on many VPS IPs where YouTube returns “confirm you’re not a bot”. */
function cookieArgs() {
  const p = process.env.YT_DLP_COOKIES || process.env.YTDLP_COOKIES;
  if (p && fs.existsSync(p)) return ['--cookies', p];
  return [];
}

/** Prefer ~/.deno/bin + ~/.local/bin so yt-dlp can find Deno for YouTube JS challenges (EJS). */
function spawnEnv() {
  const home = os.homedir();
  const extra = [path.join(home, '.deno', 'bin'), path.join(home, '.local', 'bin')].filter((d) => {
    try {
      return fs.existsSync(d);
    } catch {
      return false;
    }
  });
  const prefix = extra.join(path.delimiter);
  if (!prefix) return { ...process.env };
  return {
    ...process.env,
    PATH: `${prefix}${path.delimiter}${process.env.PATH || ''}`,
  };
}

/** @param {string} tail */
function classifyYtDlpStderr(tail) {
  const s = tail.slice(-22000);
  if (/n challenge solving failed|challenge solver script|EJS|No video formats found/i.test(s)) {
    return 'youtube_needs_ejs_or_update';
  }
  const has429 = /HTTP Error 429|429 Too Many Requests/i.test(s);
  const hasBot = /sign in to confirm|not a bot/i.test(s);
  if (has429) {
    return hasBot ? 'youtube_429_and_bot' : 'youtube_rate_limited';
  }
  if (hasBot) {
    return 'youtube_cookie_or_bot_block';
  }
  if (/Private video|members only|Video unavailable/i.test(s)) {
    return 'youtube_video_unavailable';
  }
  return 'yt_dlp_failed';
}

/**
 * @param {{ cacheDir: string, videoId: string, onLog?: (s: string) => void }} opts
 * @returns {Promise<{ ok: boolean, filePath?: string, ext?: string, durationSec?: number, error?: string }>}
 */
export async function downloadBestAudio(opts) {
  const { cacheDir, videoId, onLog } = opts;
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return { ok: false, error: 'invalid_video_id' };
  }
  await fs.promises.mkdir(cacheDir, { recursive: true });

  const pattern = path.join(cacheDir, `${videoId}.%(ext)s`);
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const bin = findYtDlp();
  const cookies = cookieArgs();

  const metaJson = await new Promise((resolve) => {
    const proc = spawn(bin, [...cookies, '-j', '--no-playlist', url], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: spawnEnv(),
    });
    let out = '';
    proc.stdout?.on('data', (d) => {
      out += d.toString();
    });
    proc.on('close', () => {
      try {
        const j = JSON.parse(out.split('\n')[0] || '{}');
        resolve(Number(j.duration) || null);
      } catch {
        resolve(null);
      }
    });
    proc.on('error', () => resolve(null));
  });

  const dl = await new Promise((resolve) => {
    const args = [...cookies, '-f', 'bestaudio/best', '--no-playlist', '-o', pattern, '--newline', url];
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv() });
    let stderr = '';
    proc.stderr?.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      onLog?.(s);
    });
    proc.stdout?.on('data', (d) => {
      onLog?.(d.toString());
    });
    proc.on('close', (code) => resolve({ ok: code === 0, stderr }));
    proc.on('error', (err) => resolve({ ok: false, stderr: stderr + String(err?.message || '') }));
  });

  if (!dl.ok) {
    const err = classifyYtDlpStderr(dl.stderr);
    // eslint-disable-next-line no-console
    console.error(`[ytdlp] download failed video=${videoId} class=${err}\n${dl.stderr.slice(-4000)}`);
    return {
      ok: false,
      error: err,
      durationSec: metaJson ?? undefined,
    };
  }

  const files = await fs.promises.readdir(cacheDir);
  const hit = files.find((f) => f.startsWith(`${videoId}.`) && !f.endsWith('.part'));
  if (!hit) {
    return { ok: false, error: 'output_missing', durationSec: metaJson ?? undefined };
  }
  const filePath = path.join(cacheDir, hit);
  const ext = path.extname(hit).slice(1) || 'bin';
  return { ok: true, filePath, ext, durationSec: metaJson ?? undefined };
}
