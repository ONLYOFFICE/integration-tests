import { TestUser } from '@core';

export interface AttachmentInfo {
  id: string;
  name: string;
  downloadUrl: string;
  modifiedAt: Date;
}

/** Shape of a Confluence "content" object (page or attachment) as returned with ?expand=version */
interface RawContent {
  id: string;
  title: string;
  version: { when: string };
  _links: { download: string };
}

/**
 * Confluence REST API v1 client. Basic Auth is disabled by default on this Confluence
 * version ("Basic Authentication has been disabled on this instance"), so — same as
 * tests/setup/confluence.ts — authentication is a session cookie obtained via the same
 * REST login the browser SPA uses.
 */
export class ConfluenceApi {
  private readonly baseUrl: string;
  private cookie = '';
  private loginPromise: Promise<void> | null = null;

  constructor(baseUrl: string, private readonly user: TestUser) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async login(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/rest/tsv/1.0/authenticate?os_authType=none`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' },
      body: JSON.stringify({
        username: this.user.username,
        password: this.user.password,
        rememberMe: false,
        targetUrl: '',
        captchaId: '',
      }),
    });
    const setCookie = response.headers.getSetCookie();
    if (setCookie.length) {
      this.cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
    }
    if (!response.ok) {
      throw new Error(`Confluence login failed: HTTP ${response.status} ${await response.text().catch(() => '')}`);
    }
  }

  /** Logs in on first use; later calls reuse the same session cookie */
  private async ensureLoggedIn(): Promise<void> {
    if (!this.loginPromise) {
      this.loginPromise = this.login();
    }
    await this.loginPromise;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    await this.ensureLoggedIn();
    const method = init.method ?? 'GET';
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined), Cookie: this.cookie };
    if (method !== 'GET') {
      // Required by Atlassian's XSRF filter on REST calls that aren't plain GETs,
      // regardless of content type (JSON included) — same as tests/setup/confluence.ts
      headers['X-Atlassian-Token'] = 'no-check';
    }
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Confluence API ${method} ${path}: ${response.status} ${body}`);
    }
    return response;
  }

  private toAttachmentInfo(raw: RawContent): AttachmentInfo {
    return {
      id: raw.id,
      name: raw.title,
      downloadUrl: raw._links.download,
      modifiedAt: new Date(raw.version.when),
    };
  }

  private async spaceExists(key: string): Promise<boolean> {
    await this.ensureLoggedIn();
    const response = await fetch(`${this.baseUrl}/rest/api/space/${key}`, { headers: { Cookie: this.cookie } });
    return response.ok;
  }

  /**
   * Creates the space used for test content, if it doesn't already exist. Playwright workers
   * each build their own ConfluenceApi instance, so concurrent workers can race to create the
   * same space — if the create call fails, re-check for the "someone else already made it" case
   * before giving up.
   */
  async ensureSpace(key: string, name: string): Promise<void> {
    if (await this.spaceExists(key)) {
      return;
    }
    try {
      await this.request('/rest/api/space', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key,
          name,
          description: { plain: { value: 'Created by the integration tests', representation: 'plain' } },
        }),
      });
    } catch (error) {
      if (await this.spaceExists(key)) {
        return;
      }
      throw error;
    }
  }

  /** Creates a blank page that hosts the attachment (Confluence has no bare "file" content type) */
  async createPage(spaceKey: string, title: string): Promise<string> {
    const response = await this.request('/rest/api/content', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'page',
        title,
        space: { key: spaceKey },
        body: { storage: { value: '<p>Created by the integration tests</p>', representation: 'storage' } },
      }),
    });
    return ((await response.json()) as { id: string }).id;
  }

  async uploadAttachment(pageId: string, name: string, content: Buffer): Promise<AttachmentInfo> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(content)]), name);
    const response = await this.request(`/rest/api/content/${pageId}/child/attachment`, {
      method: 'POST',
      body: form,
    });
    const { results } = (await response.json()) as { results: RawContent[] };
    return this.toAttachmentInfo(results[0]);
  }

  async getAttachment(id: string): Promise<AttachmentInfo> {
    const response = await this.request(`/rest/api/content/${id}?expand=version`);
    return this.toAttachmentInfo((await response.json()) as RawContent);
  }

  async downloadAttachment(downloadUrl: string): Promise<Buffer> {
    const response = await this.request(downloadUrl);
    return Buffer.from(await response.arrayBuffer());
  }

  /** Trashes a page or attachment (both are "content" in the Confluence REST API) */
  async deleteContent(id: string): Promise<void> {
    await this.request(`/rest/api/content/${id}`, { method: 'DELETE' });
  }

  /**
   * Restricts the "update" operation on a page to editorUsername only, while explicitly keeping
   * viewerUsername able to read it. Once any restriction is set, "read" stops being the space's
   * default open access and becomes an allow-list itself — Confluence also rejects an "update"
   * restriction whose user isn't also present in "read" — so both users need a "read" entry, and
   * only editorUsername gets an "update" entry. Attachments have no restrictions of their own;
   * they defer to their parent page's, so this also covers the file attached to it.
   */
  async restrictUpdateTo(pageId: string, editorUsername: string, viewerUsername: string): Promise<void> {
    await this.request(`/rest/api/content/${pageId}/restriction`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        {
          operation: 'read',
          restrictions: {
            user: [{ type: 'known', username: editorUsername }, { type: 'known', username: viewerUsername }],
            group: [],
          },
        },
        {
          operation: 'update',
          restrictions: { user: [{ type: 'known', username: editorUsername }], group: [] },
        },
      ]),
    });
  }
}
