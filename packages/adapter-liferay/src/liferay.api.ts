import { TestUser } from '@core';

interface DocumentEntry {
  id: number;
  contentUrl: string;
  dateModified: string;
}

interface DocumentPermission {
  roleName: string;
  actionIds: string[];
}

/**
 * The document permissions REST API (grantDocumentPermission below) grants by role, not by
 * user, so scoping a grant to a single user requires a dedicated role with just that one
 * member. Fixed, well-known names let each be looked up (and reused across a run) instead of
 * tracked by id — created lazily the first time a scenario actually needs it.
 */
const READONLY_ROLE_NAME = 'onlyoffice-autotest-readonly';
/**
 * secondUser's role: every file createFile() uploads grants this role (and so secondUser, its
 * only member) edit rights alongside the Owner's — new documents otherwise come out editable
 * only by the admin account that created them, which would leave every co-editing scenario
 * (secondUser opening a file it doesn't own) stuck in read-only mode.
 */
const EDITOR_ROLE_NAME = 'onlyoffice-autotest-editor';

/** Liferay Headless Delivery / Headless Admin User REST API client */
export class LiferayApi {
  private readonly baseUrl: string;
  private accountPromise: Promise<{ companyId: number; guestSiteId: number }> | null = null;
  private sessionCookiesPromise: Promise<Map<string, string>> | null = null;
  private readonly roleIdPromises = new Map<string, Promise<number>>();

  constructor(baseUrl: string, private readonly user: TestUser) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private get authHeader(): Record<string, string> {
    const token = Buffer.from(`${this.user.username}:${this.user.password}`).toString('base64');
    return { Authorization: `Basic ${token}` };
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.authHeader, ...(init?.headers as Record<string, string> | undefined) },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Liferay API ${init?.method ?? 'GET'} ${path}: ${response.status} ${body}`);
    }
    return response;
  }

  /**
   * companyId and the Guest site's numeric group id — looked up (rather than hardcoded) since
   * they're assigned at company-creation time and aren't guaranteed to be the same across every
   * LIFERAY_IMAGE. Cached for the lifetime of this client: neither changes once the stack is up.
   */
  private account(): Promise<{ companyId: number; guestSiteId: number }> {
    if (!this.accountPromise) {
      this.accountPromise = Promise.all([
        // my-user-account (Headless Admin User) carries siteBriefs but no companyId; the classic
        // JSONWS get-current-user carries companyId but no siteBriefs — hence both calls.
        this.request('/o/headless-admin-user/v1.0/my-user-account').then(
          (response) =>
            response.json() as Promise<{ siteBriefs: { id: number; externalReferenceCode: string }[] }>,
        ),
        this.request('/api/jsonws/user/get-current-user').then(
          (response) => response.json() as Promise<{ companyId: string }>,
        ),
      ]).then(([{ siteBriefs }, { companyId }]) => {
        // "L_GUEST" is Liferay's stable external reference code for the default Guest site,
        // constant across installations regardless of the site's numeric id.
        const guest = siteBriefs.find((site) => site.externalReferenceCode === 'L_GUEST');
        if (!guest) {
          throw new Error('Could not find the Guest site in my-user-account siteBriefs');
        }
        return { companyId: Number(companyId), guestSiteId: guest.id };
      });
    }
    return this.accountPromise;
  }

  /** Uploads a document into the Guest site's root Documents and Media folder */
  async uploadDocument(fileName: string, content: Buffer): Promise<DocumentEntry> {
    const { guestSiteId } = await this.account();
    const form = new FormData();
    form.append('document', new Blob([JSON.stringify({ title: fileName })], { type: 'application/json' }));
    form.append('file', new Blob([new Uint8Array(content)]), fileName);
    const response = await this.request(`/o/headless-delivery/v1.0/sites/${guestSiteId}/documents`, {
      method: 'POST',
      body: form,
    });
    return (await response.json()) as DocumentEntry;
  }

  async getDocument(id: string): Promise<DocumentEntry> {
    const response = await this.request(`/o/headless-delivery/v1.0/documents/${id}`);
    return (await response.json()) as DocumentEntry;
  }

  /**
   * A portal session, authenticated via the classic login form — separate from `request()`'s
   * Basic Auth, which the classic document-content servlet behind `contentUrl` (unlike the
   * /o/headless-* REST endpoints) silently ignores, serving the request as an anonymous guest
   * (observed as a 404, not 401/403). Cached for the lifetime of this client, same idea as the
   * setup script's admin-login cookie jar (see tests/setup/liferay.ts's createSession).
   */
  private sessionCookies(): Promise<Map<string, string>> {
    if (!this.sessionCookiesPromise) {
      this.sessionCookiesPromise = (async () => {
        const cookies = new Map<string, string>();
        const req = async (path: string, init: RequestInit = {}): Promise<Response> => {
          const cookieHeader = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
          const response = await fetch(`${this.baseUrl}${path}`, {
            ...init,
            redirect: 'manual',
            headers: { ...(init.headers as Record<string, string> | undefined), Cookie: cookieHeader },
          });
          for (const setCookie of response.headers.getSetCookie()) {
            const [pair] = setCookie.split(';');
            const eq = pair.indexOf('=');
            cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
          }
          return response;
        };
        const follow = async (path: string, init?: RequestInit): Promise<Response> => {
          let response = await req(path, init);
          while (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (!location) {
              return response;
            }
            response = await req(location.replace(this.baseUrl, ''));
          }
          return response;
        };

        const loginPage = await (await follow('/c/portal/login')).text();
        const loginFormTag = loginPage.match(/<form[^>]*_com_liferay_login_web_portlet_LoginPortlet_loginForm[^>]*>/)?.[0];
        const loginAction = loginFormTag?.match(/action="([^"]*)"/)?.[1]?.replace(/&amp;/g, '&');
        if (!loginAction) {
          throw new Error('[liferay] Could not find the login form action on the login page');
        }
        await follow(loginAction.replace(this.baseUrl, ''), {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            _com_liferay_login_web_portlet_LoginPortlet_saveLastPath: 'false',
            _com_liferay_login_web_portlet_LoginPortlet_redirect: '',
            _com_liferay_login_web_portlet_LoginPortlet_doActionAfterLogin: 'false',
            _com_liferay_login_web_portlet_LoginPortlet_login: this.user.username,
            _com_liferay_login_web_portlet_LoginPortlet_password: this.user.password,
          }),
        });
        return cookies;
      })();
    }
    return this.sessionCookiesPromise;
  }

  /** contentUrl is already relative to the portal root (e.g. /documents/{siteId}/0/{name}/{uuid}?...) */
  async downloadDocument(id: string): Promise<Buffer> {
    const { contentUrl } = await this.getDocument(id);
    const cookies = await this.sessionCookies();
    const cookieHeader = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    const response = await fetch(`${this.baseUrl}${contentUrl}`, { headers: { Cookie: cookieHeader } });
    if (!response.ok) {
      throw new Error(`Liferay document download ${contentUrl}: ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async deleteDocument(id: string): Promise<void> {
    await this.request(`/o/headless-delivery/v1.0/documents/${id}`, { method: 'DELETE' });
  }

  /**
   * Drives the plugin's "Convert" integration: the same /o/onlyoffice-docs/convert endpoint its
   * own ConvertPortlet polls from convert.jsp (fileEntryId/version/time in, {endConvert,percent}
   * out — conversion runs async on Document Server's side). Unlike the /o/headless-* REST calls
   * this class otherwise makes, this endpoint doesn't accept Basic Auth (observed as a silent
   * 200 with an empty body, rather than 401) — it needs a real portal session, hence
   * sessionCookies() (already used by downloadDocument for the same reason). On completion the
   * plugin creates a new DLFileEntry (same folder, title = baseName + "." + convertedType) rather
   * than replacing the source in place, so the caller looks up the result by that title afterwards.
   */
  async convertDocument(fileEntryId: number, timeoutMs = 60_000): Promise<void> {
    const cookies = await this.sessionCookies();
    const cookieHeader = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    // Newly uploaded documents are always at version "1.0" — the version the plugin's own
    // ConvertPortlet would have read off the file it was invoked on.
    const body = JSON.stringify({ fileEntryId, version: '1.0', time: String(Date.now()) });

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const response = await fetch(`${this.baseUrl}/o/onlyoffice-docs/convert`, {
        method: 'POST',
        headers: { Cookie: cookieHeader, 'Content-Type': 'application/json', Accept: 'application/json' },
        body,
      });
      const data = (await response.json()) as { endConvert?: boolean; error?: string };
      if (data.error) {
        throw new Error(`Liferay convert of document ${fileEntryId}: ${data.error}`);
      }
      if (data.endConvert) {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(`Liferay convert of document ${fileEntryId} did not finish within ${timeoutMs} ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  /**
   * Looks up the document convertDocument's conversion produced — it reports completion
   * ({endConvert: true}) but not the new file's id, only a transient Document Server download
   * URL, so the result has to be found by the title the plugin itself derives (baseName +
   * "." + convertedType). Polled since the new DLFileEntry can appear a beat after endConvert.
   */
  async findDocumentByTitle(title: string, timeoutMs = 30_000): Promise<DocumentEntry> {
    const { guestSiteId } = await this.account();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const response = await this.request(
        `/o/headless-delivery/v1.0/sites/${guestSiteId}/documents?filter=${encodeURIComponent(`title eq '${title}'`)}`,
      );
      const { items } = (await response.json()) as { items: DocumentEntry[] };
      if (items.length > 0) {
        return items[0];
      }
      if (Date.now() > deadline) {
        throw new Error(`Liferay document "${title}" did not appear within ${timeoutMs} ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  /**
   * Creates `roleName` (a plain Regular role — permission scope, not a login credential) if it
   * doesn't exist yet and makes `memberEmail` its only member. Looked up by name via the classic
   * JSONWS role service, since headless-admin-user's `filter` query param on GET /roles doesn't
   * actually filter (it echoes the full list) — Role#getRole doesn't have that problem. Cached
   * per role name for this client's lifetime, so each role is created/looked-up at most once.
   */
  private ensureRoleWithMember(roleName: string, memberEmail: string): Promise<number> {
    let roleId = this.roleIdPromises.get(roleName);
    if (!roleId) {
      roleId = (async () => {
        const { companyId } = await this.account();
        // JSONWS maps a genuine "no such role" to a 404 (not a 200 with an empty body), so this
        // can't go through request(), which throws on any non-2xx status.
        const lookup = await fetch(
          `${this.baseUrl}/api/jsonws/role/get-role?companyId=${companyId}&name=${encodeURIComponent(roleName)}`,
          { headers: this.authHeader },
        );
        const found = (lookup.ok ? await lookup.json() : {}) as { roleId?: string };

        const id = found.roleId
          ? Number(found.roleId)
          : ((await this.request('/o/headless-admin-user/v1.0/roles', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: roleName, roleType: 'regular' }),
            }).then((response) => response.json())) as { id: number }).id;

        const { id: userId } = (await this.request(
          `/o/headless-admin-user/v1.0/user-accounts/by-email-address/${encodeURIComponent(memberEmail)}`,
        ).then((response) => response.json())) as { id: number };
        // Idempotent: re-associating an existing member is a no-op, so no need to check first
        await this.request(`/o/headless-admin-user/v1.0/roles/${id}/association/user-account/${userId}`, {
          method: 'POST',
        });

        return id;
      })();
      this.roleIdPromises.set(roleName, roleId);
    }
    return roleId;
  }

  /**
   * Grants `roleName` the given actions on this one document, without touching any of the
   * document's other role grants (fetched and re-sent as-is) — notably the Owner role's own
   * UPDATE, which is what keeps the file editable by its creator at all.
   */
  private async grantDocumentPermission(fileEntryId: string, roleName: string, actionIds: string[]): Promise<void> {
    const { items } = (await this.request(`/o/headless-delivery/v1.0/documents/${fileEntryId}/permissions`).then(
      (response) => response.json(),
    )) as { items: DocumentPermission[] };
    const permissions: DocumentPermission[] = [...items.filter((item) => item.roleName !== roleName), { roleName, actionIds }];
    await this.request(`/o/headless-delivery/v1.0/documents/${fileEntryId}/permissions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(permissions),
    });
  }

  /** Grants readOnlyUser VIEW+DOWNLOAD (but not UPDATE) on this one document */
  async setReadOnlyFor(fileEntryId: string, readOnlyUserEmail: string): Promise<void> {
    await this.ensureRoleWithMember(READONLY_ROLE_NAME, readOnlyUserEmail);
    await this.grantDocumentPermission(fileEntryId, READONLY_ROLE_NAME, ['VIEW', 'DOWNLOAD']);
  }

  /**
   * Grants secondUser UPDATE+VIEW+DOWNLOAD on this one document — every document createFile()
   * uploads is otherwise only editable by the admin account that created it (see EDITOR_ROLE_NAME).
   */
  async grantEditAccessFor(fileEntryId: string, secondUserEmail: string): Promise<void> {
    await this.ensureRoleWithMember(EDITOR_ROLE_NAME, secondUserEmail);
    await this.grantDocumentPermission(fileEntryId, EDITOR_ROLE_NAME, ['VIEW', 'DOWNLOAD', 'UPDATE']);
  }
}
