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
  title: string;
  /** dc:modified, ISO-8601 */
  modified: string;
  /** file:content's filename, if the document carries a blob */
  fileName?: string;
}

interface RawDocument {
  uid: string;
  title: string;
  /** Only present when the request asked for schemas via the `properties` header */
  properties?: {
    'dc:modified'?: string;
    'file:content'?: { name: string } | null;
  };
}

/** Schemas to include in document responses (Nuxeo returns none by default) */
const DOCUMENT_SCHEMAS = { properties: 'dublincore,file' };

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
    return {
      uid: raw.uid,
      title: raw.title,
      modified: raw.properties?.['dc:modified'] ?? '',
      fileName: raw.properties?.['file:content']?.name,
    };
  }

  /**
   * Creates a `File` document in WORKSPACE_PATH with `content` as its main blob, through the batch
   * upload API: open a batch, upload the bytes as its file 0, then reference that batch entry from
   * the new document's file:content.
   */
  async uploadDocument(name: string, content: Buffer): Promise<NuxeoDocument> {
    const { batchId } = (await (await this.request('/upload/', { method: 'POST' })).json()) as { batchId: string };
    await this.request(`/upload/${batchId}/0`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': name,
        'X-File-Type': 'application/octet-stream',
      },
      body: new Uint8Array(content),
    });
    const response = await this.json(
      `/path${WORKSPACE_PATH}`,
      'POST',
      {
        'entity-type': 'document',
        name,
        type: 'File',
        properties: {
          'dc:title': name,
          'file:content': { 'upload-batch': batchId, 'upload-fileId': '0' },
        },
      },
      DOCUMENT_SCHEMAS,
    );
    return this.toDocument((await response.json()) as RawDocument);
  }

  async getDocument(uid: string): Promise<NuxeoDocument> {
    const response = await this.request(`/id/${uid}`, { headers: DOCUMENT_SCHEMAS });
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
  async createViaPlugin(title: string, type: 'word' | 'cell' | 'slide'): Promise<string> {
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
