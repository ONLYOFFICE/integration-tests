import { FileType, TestUser } from '@core';

export interface AttachmentInfo {
  id: string;
  name: string;
  downloadUrl: string;
  createdAt: Date;
}

/** Shape of a Jira "attachment" object as returned on an issue's ?fields=attachment */
interface RawAttachment {
  id: string;
  filename: string;
  created: string;
  content: string;
}

/**
 * Jira REST API v2 client. Basic Auth is disabled by default on this Jira version (same as
 * Confluence), but — unlike Confluence — /rest/auth/1/session works fine, so authentication is
 * a session cookie obtained from that endpoint rather than a browser-SPA-specific login action.
 */
export class JiraApi {
  private readonly baseUrl: string;
  // Keyed by cookie name rather than replaced wholesale — a response only re-sends Set-Cookie
  // for the cookies it's actually changing, so overwriting the whole header on every response
  // would drop JSESSIONID as soon as one such response came back, silently de-authenticating.
  private readonly cookies = new Map<string, string>();
  private loginPromise: Promise<void> | null = null;

  constructor(baseUrl: string, private readonly user: TestUser) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async login(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/rest/auth/1/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.user.username, password: this.user.password }),
    });
    this.storeCookies(response);
    if (!response.ok) {
      throw new Error(`Jira login failed: HTTP ${response.status} ${await response.text().catch(() => '')}`);
    }
  }

  private async ensureLoggedIn(): Promise<void> {
    if (!this.loginPromise) {
      this.loginPromise = this.login();
    }
    await this.loginPromise;
  }

  private storeCookies(response: Response): void {
    for (const setCookie of response.headers.getSetCookie()) {
      const [nameValue] = setCookie.split(';');
      const eq = nameValue.indexOf('=');
      this.cookies.set(nameValue.slice(0, eq), nameValue.slice(eq + 1));
    }
  }

  private cookieHeader(): string {
    return Array.from(this.cookies, ([name, value]) => `${name}=${value}`).join('; ');
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    await this.ensureLoggedIn();
    const method = init.method ?? 'GET';
    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string> | undefined),
      Cookie: this.cookieHeader(),
    };
    if (method !== 'GET') {
      // Required by Atlassian's XSRF filter on REST calls that aren't plain GETs
      headers['X-Atlassian-Token'] = 'no-check';
    }
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    this.storeCookies(response);
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Jira API ${method} ${path}: ${response.status} ${body}`);
    }
    return response;
  }

  private toAttachmentInfo(raw: RawAttachment): AttachmentInfo {
    return { id: raw.id, name: raw.filename, downloadUrl: raw.content, createdAt: new Date(raw.created) };
  }

  /**
   * Creates a Task issue in the given project, hosting the file as its attachment. The project
   * itself — along with the permission scheme that makes restrictToReadOnly work — is created
   * once during global setup (see tests/setup/jira.ts's ensureTestProject), not here: setting
   * it up lazily from the adapter meant doing a websudo elevation while a worker's browser
   * session was concurrently authenticating as the same admin user, which intermittently 401'd.
   */
  async createIssue(projectKey: string, summary: string): Promise<string> {
    const response = await this.request('/rest/api/2/issue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { project: { key: projectKey }, summary, issuetype: { name: 'Task' } } }),
    });
    return ((await response.json()) as { id: string }).id;
  }

  async uploadAttachment(issueId: string, name: string, content: Buffer): Promise<AttachmentInfo> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(content)]), name);
    const response = await this.request(`/rest/api/2/issue/${issueId}/attachments`, { method: 'POST', body: form });
    const [attachment] = (await response.json()) as RawAttachment[];
    return this.toAttachmentInfo(attachment);
  }

  async getAttachment(id: string): Promise<AttachmentInfo> {
    const response = await this.request(`/rest/api/2/attachment/${id}`);
    return this.toAttachmentInfo((await response.json()) as RawAttachment);
  }

  /**
   * The most recently created attachment on the issue. Unlike Confluence, Jira has no in-place
   * attachment versioning — every editor save creates a brand-new attachment (the old one is
   * left behind), so "the current version of the file" always means the latest one by creation
   * date, never a fixed attachment id.
   */
  async getLatestAttachment(issueId: string): Promise<AttachmentInfo> {
    const response = await this.request(`/rest/api/2/issue/${issueId}?fields=attachment`);
    const { fields } = (await response.json()) as { fields: { attachment: RawAttachment[] } };
    if (!fields.attachment.length) {
      throw new Error(`Jira issue ${issueId} has no attachments`);
    }
    const latest = fields.attachment.reduce((a, b) => (new Date(a.created) > new Date(b.created) ? a : b));
    return this.toAttachmentInfo(latest);
  }

  async downloadAttachment(downloadUrl: string): Promise<Buffer> {
    await this.ensureLoggedIn();
    const response = await fetch(downloadUrl, { headers: { Cookie: this.cookieHeader() } });
    if (!response.ok) {
      throw new Error(`Jira attachment download ${downloadUrl}: HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  /** Deleting the issue cascades to its attachments — no need to delete them separately */
  async deleteIssue(issueId: string): Promise<void> {
    await this.request(`/rest/api/2/issue/${issueId}`, { method: 'DELETE' });
  }

  /**
   * Drives the plugin's "OnlyOfficeConversion" webwork action — the same one its conversion
   * dialog (js/onlyoffice-conversion.js) submits. There's no JSON API for this: the action's
   * default view renders an HTML fragment carrying a CSRF token (atl_token) that the actual
   * conversion POST must echo back, then the POST itself is polled every second (endConvert
   * flips to true once Document Server's Convert API finishes) exactly as the dialog's own
   * conversionRequest() polling loop does.
   */
  async convertAttachment(
    issueId: string,
    attachmentId: string,
    fileName: string,
    targetFileType: FileType,
  ): Promise<AttachmentInfo> {
    const dialogHtml = await (
      await this.request(`/OnlyOfficeConversion!default.jspa?id=${issueId}&attachmentId=${attachmentId}`)
    ).text();
    const atlToken = /name="atl_token" value="([^"]*)"/.exec(dialogHtml)?.[1];
    if (!atlToken) {
      throw new Error(`Could not find atl_token in Jira's conversion dialog for attachment ${attachmentId}`);
    }

    const body = new URLSearchParams({
      atl_token: atlToken,
      id: issueId,
      attachmentId,
      actionType: 'conversion',
      fileName,
      targetFileType,
    });

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const response = await this.request('/OnlyOfficeConversion.jspa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const result = (await response.json()) as {
        convertResponse: { error?: string; endConvert: boolean };
        createdFile?: { fileName: string; fileUrl: string };
      };
      if (result.convertResponse.error) {
        throw new Error(`Jira conversion of attachment ${attachmentId} failed: ${result.convertResponse.error}`);
      }
      if (result.convertResponse.endConvert) {
        const newAttachmentId = new URL(result.createdFile!.fileUrl, this.baseUrl).searchParams.get('attachmentId')!;
        return this.getAttachment(newAttachmentId);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(`Jira conversion of attachment ${attachmentId} did not finish within 60s`);
  }
}
