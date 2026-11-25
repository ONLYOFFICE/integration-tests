import { TestUser } from '@core';

/** Web application context path every Nuxeo URL lives under */
export const NUXEO_CONTEXT = '/nuxeo';
/**
 * The workspace every test document is created in — set up (with its permissions for
 * secondUser/readOnlyUser) by tests/setup/nuxeo.ts on every stack startup, so the adapter can
 * take it as a given. Exported for that setup to create exactly this path.
 */
export const WORKSPACE_PATH = '/default-domain/workspaces/integration-tests';

export interface NuxeoDocument {
  uid: string;
  /** The document's name: the last segment of its path */
  name: string;
  title: string;
  /** dc:modified, ISO-8601 */
  modified: string;
  lastContributor?: string;
  /** major.minor, from the uid schema */
  version: string;
  /** file:content's filename, if the document carries a blob */
  fileName?: string;
  mimeType?: string;
  digest?: string;
  /** Only present when the document is locked */
  lockOwner?: string;
}

interface RawDocument {
  uid: string;
  path: string;
  title: string;
  lockOwner?: string;
  /** Only present when the request asked for schemas via the `properties` header */
  properties?: {
    'dc:modified'?: string;
    'dc:lastContributor'?: string;
    'uid:major_version'?: number;
    'uid:minor_version'?: number;
    'file:content'?: { name: string; 'mime-type'?: string; digest?: string } | null;
  };
}

/**
 * Schemas to include in document responses (Nuxeo returns none by default), and the lock (both
 * spellings of the header: the older X-NXfetch.document and its newer alias)
 */
const DOCUMENT_HEADERS = { properties: 'dublincore,file,uid', 'fetch-document': 'lock', 'X-NXfetch.document': 'lock' };

/**
 * The plugin's ConvertOperation answer — the Document Server Convert API response it relays. The
 * operation fires one *async* convert request per call and does not wait: only once DS reports
 * `endConvert` does the plugin swap the converted blob into the document, so callers poll.
 */
export interface ConvertResponse {
  endConvert?: boolean;
  percent?: number;
  error?: number;
  fileUrl?: string;
}

/** Nuxeo REST API (/api/v1) + Automation client, Basic auth as the given user */
export class NuxeoApi {
  private readonly baseUrl: string;

  constructor(baseUrl: string, private readonly user: TestUser) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private get authHeader(): Record<string, string> {
    const token = Buffer.from(`${this.user.username}:${this.user.password}`).toString('base64');
    return { Authorization: `Basic ${token}` };
  }

  /** Performs a request against /nuxeo/api/v1; `path` is relative to it */
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${NUXEO_CONTEXT}/api/v1${path}`, {
      ...init,
      headers: { ...this.authHeader, ...(init.headers as Record<string, string> | undefined) },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Nuxeo API ${init.method ?? 'GET'} ${path}: ${response.status} ${body}`);
    }
    return response;
  }

  private json(path: string, method: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return this.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  /**
   * Runs an Automation operation. Nuxeo wraps primitive results as
   * `{"entity-type":"string","value":"..."}` — that inner value is what's returned here (parsed
   * again if it is itself JSON, as the plugin's ConvertOperation serializes its response into a
   * string); anything else (documents, void) comes back as-is.
   */
  async operation(id: string, params: Record<string, unknown>, inputUid?: string): Promise<any> {
    const response = await this.json(`/automation/${id}`, 'POST', {
      ...(inputUid ? { input: `doc:${inputUid}` } : {}),
      params,
    });
    const text = await response.text();
    if (!text) {
      return undefined;
    }
    let payload: any;
    try {
      payload = JSON.parse(text);
    } catch {
      return text;
    }
    if (payload && typeof payload === 'object' && typeof payload.value === 'string') {
      try {
        return JSON.parse(payload.value);
      } catch {
        return payload.value;
      }
    }
    return payload;
  }

  private toDocument(raw: RawDocument): NuxeoDocument {
    const blob = raw.properties?.['file:content'];
    return {
      uid: raw.uid,
      name: raw.path.split('/').pop()!,
      title: raw.title,
      modified: raw.properties?.['dc:modified'] ?? '',
      lastContributor: raw.properties?.['dc:lastContributor'],
      version: `${raw.properties?.['uid:major_version'] ?? 0}.${raw.properties?.['uid:minor_version'] ?? 0}`,
      fileName: blob?.name,
      mimeType: blob?.['mime-type'],
      digest: blob?.digest,
      lockOwner: raw.lockOwner,
    };
  }

  /**
   * Creates a `File` document in WORKSPACE_PATH with `content` as its main blob, through the batch
   * upload API: open a batch, upload the bytes as its file 0, then reference that batch entry from
   * the new document's file:content. `title` defaults to the file name.
   */
  async uploadDocument(name: string, content: Buffer, options: { title?: string } = {}): Promise<NuxeoDocument> {
    const response = await this.json(
      `/path${WORKSPACE_PATH}`,
      'POST',
      {
        'entity-type': 'document',
        name: name.replace(/[^\w.-]/g, '-'),
        type: 'File',
        properties: {
          'dc:title': options.title ?? name,
          'file:content': await this.uploadBlob(name, content),
        },
      },
      DOCUMENT_HEADERS,
    );
    return this.toDocument((await response.json()) as RawDocument);
  }

  /** Uploads the bytes into a new batch — the returned reference is what a blob property is set to */
  private async uploadBlob(name: string, content: Buffer): Promise<{ 'upload-batch': string; 'upload-fileId': string }> {
    const { batchId } = (await (await this.request('/upload/', { method: 'POST' })).json()) as { batchId: string };
    await this.request(`/upload/${batchId}/0`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        // Nuxeo URL-decodes the header, which can carry only ASCII as it is
        'X-File-Name': encodeURIComponent(name),
        'X-File-Type': 'application/octet-stream',
      },
      body: new Uint8Array(content),
    });
    return { 'upload-batch': batchId, 'upload-fileId': '0' };
  }

  /** Adds a file to the document's attachments (files:files), next to its main file */
  async attachFile(uid: string, name: string, content: Buffer): Promise<void> {
    await this.json(`/id/${uid}`, 'PUT', {
      'entity-type': 'document',
      properties: { 'files:files': [{ file: await this.uploadBlob(name, content) }] },
    });
  }

  /** Checks in a minor version of the document; returns the version's uid */
  /** Checks the document in as a new minor version; returns the uid of that version */
  async createVersion(uid: string): Promise<string> {
    // Document.CreateVersion answers with the live document, not with the version it created
    await this.operation('Document.CreateVersion', { increment: 'Minor' }, uid);
    const versions = (await this.operation('Document.GetVersions', {}, uid)) as {
      entries: { uid: string; versionLabel: string }[];
    };
    const byLabel = (version: { versionLabel: string }) => version.versionLabel.split('.').map(Number);
    const [latest] = [...versions.entries].sort((a, b) => {
      const [aMajor, aMinor] = byLabel(a);
      const [bMajor, bMinor] = byLabel(b);
      return bMajor - aMajor || bMinor - aMinor;
    });
    return latest.uid;
  }

  async createEmptyFile(name: string): Promise<NuxeoDocument> {
    const response = await this.json(
      `/path${WORKSPACE_PATH}`,
      'POST',
      { 'entity-type': 'document', name, type: 'File', properties: { 'dc:title': name } },
      DOCUMENT_HEADERS,
    );
    return this.toDocument((await response.json()) as RawDocument);
  }

  /** Locks the document as this client's user — the way Nuxeo's own "Lock" action does, outside ONLYOFFICE */
  async lock(uid: string): Promise<void> {
    await this.operation('Document.Lock', {}, uid);
  }

  async unlock(uid: string): Promise<void> {
    await this.operation('Document.Unlock', {}, uid);
  }

  async getDocument(uid: string): Promise<NuxeoDocument> {
    const response = await this.request(`/id/${uid}`, { headers: DOCUMENT_HEADERS });
    return this.toDocument((await response.json()) as RawDocument);
  }

  async downloadBlob(uid: string): Promise<Buffer> {
    const response = await this.request(`/id/${uid}/@blob/file:content`);
    return Buffer.from(await response.arrayBuffer());
  }

  async deleteDocument(uid: string): Promise<void> {
    await this.request(`/id/${uid}`, { method: 'DELETE' });
  }

  /** Grants `username` the given Nuxeo permission (e.g. Read, ReadWrite, Everything) on the document */
  async addPermission(uid: string, username: string, permission: string): Promise<void> {
    await this.operation('Document.AddPermission', { username, permission }, uid);
  }

  /**
   * Stops the document from inheriting its parent's ACL — from then on only its own local ACEs
   * apply (Nuxeo grants the calling user Everything on it as part of blocking, so the admin
   * account this client runs as keeps its access).
   */
  async blockPermissionInheritance(uid: string): Promise<void> {
    await this.operation('Document.BlockPermissionInheritance', {}, uid);
  }

  /**
   * The plugin's own "Create new document" integration: the ONLYOFFICE.Create Automation
   * operation its Web UI dialog calls. `type` is the editor's document type — word / cell /
   * slide (/ pdf). Returns the new document's uid.
   */
  async createViaPlugin(title: string, type: 'word' | 'cell' | 'slide' | 'pdf'): Promise<string> {
    const uid = await this.operation('ONLYOFFICE.Create', { path: WORKSPACE_PATH, title, type, language: 'en' });
    if (typeof uid !== 'string' || !uid) {
      throw new Error(`ONLYOFFICE.Create returned no document id: ${JSON.stringify(uid)}`);
    }
    return uid;
  }

  /** One round of the plugin's "Convert" integration (ONLYOFFICE.Convert) — see ConvertResponse */
  async convert(uid: string): Promise<ConvertResponse> {
    const response = await this.operation('ONLYOFFICE.Convert', { id: uid, language: 'en' });
    return (response ?? {}) as ConvertResponse;
  }
}
