import { FrameLocator, Page } from '@playwright/test';
import { FileRef, FileType, HostAdapter, LegacyFileType, loadConvertTemplate, loadTemplate, TestUser } from '@core';

import { MattermostApi } from './mattermost.api';

export interface MattermostOptions {
  baseUrl: string;
  admin: TestUser;
  secondUser: TestUser;
  readOnlyUser: TestUser;
  channelId: string;
  teamId: string;
}

const BOT_USERNAME = 'onlyoffice';
const PLUGIN_ROOT = '/plugins/com.onlyoffice.mattermost/api';
const CONVERT_TARGETS: Record<LegacyFileType, FileType> = { odt: 'docx', ods: 'xlsx', odp: 'pptx' };

const TIP_BUTTON = '.synch-tip-root .btn-div';

async function csrfHeader(page: Page): Promise<Record<string, string>> {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((cookie) => cookie.name === 'MMCSRF')?.value;
  return csrf ? { 'X-CSRF-Token': csrf } : {};
}

function editorFrame(page: Page): FrameLocator {
  return page.frameLocator('iframe[name="frameEditor"]');
}

async function stripTips(frame: FrameLocator): Promise<void> {
  await frame
    .locator('body')
    .evaluate((body) => body.querySelectorAll('.synch-tip-root').forEach((el) => el.remove()))
    .catch(() => {});
}

async function dismissTip(page: Page): Promise<void> {
  const frame = editorFrame(page);
  await frame.locator('#toolbar').waitFor({ state: 'visible', timeout: 90_000 });

  const loadmask = frame.locator('.asc-loadmask');
  const loadDeadline = Date.now() + 90_000;
  while (Date.now() < loadDeadline && (await loadmask.count()) > 0) {
    await page.waitForTimeout(200);
  }

  const tipButton = frame.locator(TIP_BUTTON).or(frame.getByText(/^Got\s*It$/i)).first();
  const tipDeadline = Date.now() + 5_000;
  while (Date.now() < tipDeadline) {
    if (await tipButton.isVisible().catch(() => false)) {
      await tipButton.click({ force: true }).catch(() => {});
      await page.waitForTimeout(300);
    } else {
      await page.waitForTimeout(250);
    }
  }

  await stripTips(frame);
}

const flushOnClose = new WeakSet<Page>();

function closeFlush(page: Page, type: FileType): void {
  if (flushOnClose.has(page)) {
    return;
  }

  flushOnClose.add(page);

  const originalClose = page.close.bind(page);
  page.close = async (options) => {
    const frame = editorFrame(page);
    await stripTips(frame);

    if (type === 'xlsx') {
      await page.keyboard.press('Enter').catch(() => {});
    }

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s').catch(() => {});

    const saving = frame.getByText(/Saving document/i);
    const sawSaving = await saving.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false);
    if (sawSaving) {
      await saving.waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => {});
    } else {
      await page.waitForTimeout(4_000);
    }

    await page.waitForTimeout(1_500);
    return originalClose(options);
  };
}

async function prepareEditor(page: Page, type: FileType): Promise<void> {
  await dismissTip(page);
  closeFlush(page, type);
}

export class MattermostAdapter implements HostAdapter {
  readonly name = 'mattermost';
  readonly baseUrl: string;
  readonly defaultUser: TestUser;
  readonly secondUser: TestUser;
  readonly readOnlyUser: TestUser;

  private readonly api: MattermostApi;
  private readonly channelId: string;
  private readonly teamId: string;

  constructor(options: MattermostOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.defaultUser = options.admin;
    this.secondUser = options.secondUser;
    this.readOnlyUser = options.readOnlyUser;
    this.channelId = options.channelId;
    this.teamId = options.teamId;
    this.api = new MattermostApi(this.baseUrl, options.admin);
  }

  async login(page: Page, user: TestUser): Promise<void> {
    await page.goto('/login');
    const viewInBrowser = page.getByText('View in Browser');
    await viewInBrowser.waitFor({ timeout: 10_000 }).catch(() => {});
    if (await viewInBrowser.isVisible().catch(() => false)) {
      await viewInBrowser.click();
    }

    await page.fill('#input_loginId', user.username);
    await page.fill('#input_password-input', user.password);
    await Promise.all([
      page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 30_000 }).catch(() => {}),
      page.click('#saveSetting'),
    ]);

    if (page.url().includes('/login')) {
      throw new Error(`[mattermost] Login failed for ${user.username} — still on the login page`);
    }
  }

  async createFile(name: string, type: FileType): Promise<FileRef> {
    const fileName = `${name}.${type}`;
    const file = await this.api.uploadFile(this.channelId, fileName, loadTemplate(type));
    await this.api.createPost(this.channelId, [file.id]);
    await this.api.grantEditPermission(file.id, this.secondUser.username);
    return { id: file.id, name: fileName, type };
  }

  async openInEditor(page: Page, file: FileRef): Promise<void> {
    await page.goto(`${PLUGIN_ROOT}/editor?file=${file.id}&lang=en&dark=false`);
    await prepareEditor(page, file.type);
  }

  async createFileViaPlugin(page: Page, type: FileType): Promise<FileRef> {
    const name = `autotest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const channelId = await this.api.createChannel(this.teamId, name);
    const response = await page.request.post(`${PLUGIN_ROOT}/create`, {
      headers: await csrfHeader(page),
      data: { channel_id: channelId, file_name: name, file_type: type },
    });

    if (!response.ok()) {
      throw new Error(`[mattermost] createFileViaPlugin failed: HTTP ${response.status()} ${await response.text()}`);
    }

    const file = await this.api.getLatestFileInChannel(channelId);
    await page.goto(`${PLUGIN_ROOT}/editor?file=${file.id}&lang=en&dark=false`);
    await prepareEditor(page, type);
    return { id: file.id, name: file.name, type };
  }

  async downloadFile(file: FileRef): Promise<Buffer> {
    return this.api.downloadFile(file.id);
  }

  async getModifiedAt(file: FileRef): Promise<Date> {
    const info = await this.api.getFileInfo(file.id);
    const post = await this.api.getPost(info.postId);
    return new Date(post.updateAt);
  }

  async waitForSave(file: FileRef, since: Date, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.getModifiedAt(file)) > since) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }

    throw new Error(`File ${file.name} was not saved to Mattermost within ${timeoutMs} ms`);
  }

  async deleteFile(file: FileRef): Promise<void> {
    const info = await this.api.getFileInfo(file.id);
    await this.api.deletePost(info.postId);
  }

  async restrictToReadOnly(_file: FileRef): Promise<void> {}

  async convertLegacyFile(page: Page, sourceType: LegacyFileType): Promise<FileRef> {
    const targetType = CONVERT_TARGETS[sourceType];
    const baseName = `autotest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const source = await this.api.uploadFile(this.channelId, `${baseName}.${sourceType}`, loadConvertTemplate(sourceType));
    const post = await this.api.createPost(this.channelId, [source.id]);

    let lastError = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await page.request.post(`${PLUGIN_ROOT}/convert`, {
        headers: await csrfHeader(page),
        data: { file_id: source.id },
        timeout: 60_000,
      });

      const body = (await response.json().catch(() => ({}))) as { error?: number };
      if (response.ok() && !body.error) {
        const converted = await this.api.getLatestReplyFile(post.id);
        return { id: converted.id, name: converted.name, type: targetType };
      }

      lastError = `HTTP ${response.status()} ${JSON.stringify(body)}`;
      await page.waitForTimeout(2_000 * (attempt + 1));
    }

    throw new Error(`[mattermost] Convert failed for ${source.name}: ${lastError}`);
  }

  async getBotReply(file: FileRef): Promise<string | undefined> {
    const info = await this.api.getFileInfo(file.id);
    const botId = await this.api.getUserId(BOT_USERNAME);
    const replies = await this.api.getThreadReplies(info.postId);
    return replies.find((reply) => reply.userId === botId)?.message;
  }
}
