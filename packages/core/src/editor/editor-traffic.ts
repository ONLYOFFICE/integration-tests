import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BrowserContext, Page, TestInfo } from '@playwright/test';

/** Requests slower than this are logged with their timing */
const SLOW_REQUEST_MS = 5_000;

/** Socket.IO frames carry whole document changes; the start of one is enough to tell what it was */
const FRAME_PREVIEW = 300;

function preview(payload: string | Buffer): string {
  const text = typeof payload === 'string' ? payload : `<binary ${payload.length} bytes>`;
  return text.length > FRAME_PREVIEW ? `${text.slice(0, FRAME_PREVIEW)}… (${text.length} chars)` : text;
}

/**
 * What the pages of a test exchanged with Document Server over WebSocket, and what went wrong in
 * them (console errors and warnings, script errors, failed requests, crashes) — timestamped in
 * UTC like Document Server's own logs, so an editor that never loads or a submit that never
 * reaches the host can be followed from the browser's side into Document Server's.
 */
export class EditorTraffic {
  private readonly lines: string[] = [];

  watchContext(context: BrowserContext, label: string): void {
    context.pages().forEach((page) => this.watch(page, label));
    context.on('page', (page) => this.watch(page, label));
  }

  watch(page: Page, label: string): void {
    const log = (message: string) => this.lines.push(`${new Date().toISOString()} [${label}] ${message}`);

    page.on('websocket', (socket) => {
      log(`ws open ${socket.url()}`);
      socket.on('framesent', (frame) => log(`ws > ${preview(frame.payload)}`));
      socket.on('framereceived', (frame) => log(`ws < ${preview(frame.payload)}`));
      socket.on('socketerror', (error) => log(`ws error ${error}`));
      socket.on('close', () => log(`ws close ${socket.url()}`));
    });
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        log(`console.${message.type()} ${message.text()}`);
      }
    });
    page.on('pageerror', (error) => log(`pageerror ${(error.stack ?? error.message).split('\n').slice(0, 4).join(' | ')}`));
    page.on('requestfinished', (request) => {
      const timing = request.timing();
      if (timing.responseEnd < SLOW_REQUEST_MS) {
        return;
      }
      // Waiting: from sending the request to its first byte; loading: from there to its last
      const waiting = Math.round(timing.responseStart - timing.requestStart);
      const loading = Math.round(timing.responseEnd - timing.responseStart);
      log(`slow request ${Math.round(timing.responseEnd)}ms (waiting ${waiting}ms, loading ${loading}ms) ${request.method()} ${request.url()}`);
    });
    page.on('requestfailed', (request) => log(`request failed ${request.method()} ${request.url()} ${request.failure()?.errorText}`));
    page.on('crash', () => log('page crashed'));
    page.on('close', () => log('page closed'));
  }

  /** Written into the test's output directory too, where it stays for passed tests as well */
  async attachTo(testInfo: TestInfo): Promise<void> {
    if (!this.lines.length) {
      return;
    }
    const file = testInfo.outputPath('editor-traffic.txt');
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, this.lines.join('\n'));
    await testInfo.attach('editor-traffic', { path: file, contentType: 'text/plain' });
  }
}
