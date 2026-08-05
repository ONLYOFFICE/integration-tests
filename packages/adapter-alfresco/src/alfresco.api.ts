import { TestUser } from '@core';

interface NodeEntry {
  id: string;
  name: string;
  modifiedAt: string;
}

/** Alfresco Content Services REST API v1 client */
export class AlfrescoApi {
  private readonly apiRoot: string;
  private readonly scriptRoot: string;

  constructor(baseUrl: string, private readonly user: TestUser) {
    const root = baseUrl.replace(/\/$/, '');
    this.apiRoot = `${root}/alfresco/api/-default-/public/alfresco/versions/1`;
    this.scriptRoot = `${root}/alfresco/s`;
  }

  private get authHeader(): Record<string, string> {
    const token = Buffer.from(`${this.user.username}:${this.user.password}`).toString('base64');
    return { Authorization: `Basic ${token}` };
  }

  private async request(apiPath: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(`${this.apiRoot}${apiPath}`, {
      ...init,
      headers: { ...this.authHeader, ...(init?.headers as Record<string, string> | undefined) },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Alfresco API ${init?.method ?? 'GET'} ${apiPath}: ${response.status} ${body}`);
    }
    return response;
  }

  /** GET request to a webscript (/alfresco/s/...) with JSON parsing */
  async getWebScript<T>(scriptPath: string): Promise<T> {
    const response = await fetch(`${this.scriptRoot}${scriptPath}`, { headers: this.authHeader });
    if (!response.ok) {
      throw new Error(`Alfresco webscript GET ${scriptPath}: ${response.status} ${await response.text().catch(() => '')}`);
    }
    return (await response.json()) as T;
  }

  /** POST JSON to a webscript (/alfresco/s/...) */
  async postWebScript(scriptPath: string, body: unknown): Promise<void> {
    const response = await fetch(`${this.scriptRoot}${scriptPath}`, {
      method: 'POST',
      headers: { ...this.authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Alfresco webscript POST ${scriptPath}: ${response.status} ${await response.text().catch(() => '')}`);
    }
  }

  /** Uploads a file; parentId '-my-' is the user's home folder (My Files in Share) */
  async uploadFile(name: string, content: Buffer, parentId = '-my-'): Promise<NodeEntry> {
    const form = new FormData();
    form.append('filedata', new Blob([new Uint8Array(content)]), name);
    form.append('name', name);
    const response = await this.request(`/nodes/${parentId}/children`, { method: 'POST', body: form });
    return (await response.json()).entry;
  }

  async getNode(id: string): Promise<NodeEntry> {
    const response = await this.request(`/nodes/${id}`);
    return (await response.json()).entry;
  }

  async downloadContent(id: string): Promise<Buffer> {
    const response = await this.request(`/nodes/${id}/content`);
    return Buffer.from(await response.arrayBuffer());
  }

  async deleteNode(id: string): Promise<void> {
    await this.request(`/nodes/${id}`, { method: 'DELETE' });
  }

  private async personExists(id: string): Promise<boolean> {
    const response = await fetch(`${this.apiRoot}/people/${id}`, { headers: this.authHeader });
    return response.ok;
  }

  /** Creates a person, if it doesn't already exist. Has no access to anything by default. */
  async ensurePerson(user: TestUser): Promise<void> {
    if (await this.personExists(user.username)) {
      return;
    }
    await this.request('/people', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: user.username,
        firstName: user.username,
        lastName: 'Autotest',
        email: `${user.username}@example.com`,
        password: user.password,
        enabled: true,
      }),
    });
  }

  /**
   * Adds a person to GROUP_ALFRESCO_ADMINISTRATORS — administrators bypass per-node ACLs in
   * Alfresco, so this is the simplest way to give a second test account access to content
   * created by the admin user (home folders are private by default).
   */
  async addToAdminGroup(user: TestUser): Promise<void> {
    await this.request('/groups/GROUP_ALFRESCO_ADMINISTRATORS/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: user.username, memberType: 'PERSON' }),
    }).catch(() => {
      // already a member — Alfresco returns 409 for a duplicate membership
    });
  }

  /** Grants an authority (person or group) a permission on a node, without touching inheritance */
  async setNodePermission(nodeId: string, authorityId: string, permissionName: string): Promise<void> {
    await this.request(`/nodes/${nodeId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        permissions: {
          locallySet: [{ authorityId, name: permissionName, accessStatus: 'ALLOWED' }],
        },
      }),
    });
  }
}
