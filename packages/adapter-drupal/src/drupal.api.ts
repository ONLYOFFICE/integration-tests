import { TestUser } from '@core';

export interface DrupalMediaType {
  bundle: string;
  sourceField: string;
}

/**
 * The standard install profile's "Document" media type and its file field — the media type the
 * module's editor opens. JSON:API names its resource media--document.
 */
export const DOCUMENT: DrupalMediaType = { bundle: 'document', sourceField: 'field_media_document' };
/** The media type the onlyoffice_form submodule installs */
export const PDF_FORM: DrupalMediaType = { bundle: 'onlyoffice_pdf_form', sourceField: 'field_media_pdf_file' };
/** The content type with an ONLYOFFICE form field that tests/setup/drupal.ts adds */
export const FORM_NODE_TYPE = 'oit_form_page';
export const FORM_FIELD = 'field_oit_form';
const JSON_API = 'application/vnd.api+json';

export interface DrupalNode {
  uuid: string;
  nid: number;
}

export interface DrupalMedia {
  uuid: string;
  /** The numeric id the module's editor route (/admin/media/{mid}/onlyoffice-editor) takes */
  mid: number;
  name: string;
  /** ISO-8601 */
  changed: string;
  published: boolean;
  /** UUID of the media's current file entity */
  fileId?: string;
  /** Root-relative URL of the media's current file (a public file is served by Apache directly) */
  fileUrl?: string;
  /** Account name of the user the current revision was made by */
  revisionUser?: string;
}

interface JsonApiResource {
  id: string;
  type: string;
  attributes: Record<string, any>;
  relationships?: Record<string, { data: { id: string; type: string } | null }>;
}

/** Drupal's JSON:API (/jsonapi), Basic auth as the given user — tests/setup/drupal.ts enables both */
export class DrupalApi {
  private readonly baseUrl: string;

  constructor(baseUrl: string, private readonly user: TestUser) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private get authHeader(): Record<string, string> {
    const token = Buffer.from(`${this.user.username}:${this.user.password}`).toString('base64');
    return { Authorization: `Basic ${token}` };
  }

  /** Performs a request against /jsonapi; `path` is relative to it */
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${this.baseUrl}/jsonapi${path}`, {
      ...init,
      headers: { Accept: JSON_API, ...this.authHeader, ...(init.headers as Record<string, string> | undefined) },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Drupal JSON:API ${init.method ?? 'GET'} ${path}: ${response.status} ${body}`);
    }
    return response;
  }

  /**
   * Creates a Document media with `content` as its file: JSON:API's file upload endpoint for the
   * media type's source field makes the (temporary) file entity, and the media referencing it
   * makes it permanent.
   */
  async createMedia(fileName: string, content: Buffer, published = true, type = DOCUMENT): Promise<DrupalMedia> {
    const upload = await this.request(`/media/${type.bundle}/${type.sourceField}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `file; filename="${fileName}"`,
      },
      body: new Uint8Array(content),
    });
    const file = ((await upload.json()) as { data: JsonApiResource }).data;

    const response = await this.request(`/media/${type.bundle}`, {
      method: 'POST',
      headers: { 'Content-Type': JSON_API },
      body: JSON.stringify({
        data: {
          type: `media--${type.bundle}`,
          attributes: { name: fileName, status: published },
          relationships: { [type.sourceField]: { data: { type: 'file--file', id: file.id } } },
        },
      }),
    });
    return this.toMedia(((await response.json()) as { data: JsonApiResource }).data);
  }

  /** A published page showing the form media `formMid` in its ONLYOFFICE form field */
  async createNode(title: string, formMid: number): Promise<DrupalNode> {
    const response = await this.request(`/node/${FORM_NODE_TYPE}`, {
      method: 'POST',
      headers: { 'Content-Type': JSON_API },
      body: JSON.stringify({
        data: {
          type: `node--${FORM_NODE_TYPE}`,
          attributes: { title, status: true, [FORM_FIELD]: { target_id: formMid } },
        },
      }),
    });
    const node = ((await response.json()) as { data: JsonApiResource }).data;
    return { uuid: node.id, nid: node.attributes.drupal_internal__nid };
  }

  async deleteNode(uuid: string): Promise<void> {
    await this.request(`/node/${FORM_NODE_TYPE}/${uuid}`, { method: 'DELETE' });
  }

  /**
   * The media with its current file: saving in the editor creates a new file entity and a new
   * media revision, so the file is always looked up through the media rather than remembered.
   */
  async getMedia(uuid: string, type = DOCUMENT): Promise<DrupalMedia> {
    const response = await this.request(`/media/${type.bundle}/${uuid}?include=${type.sourceField},revision_user`);
    const body = (await response.json()) as { data: JsonApiResource; included?: JsonApiResource[] };
    const included = (relationship: string) => {
      const target = body.data.relationships?.[relationship]?.data;
      return body.included?.find((resource) => resource.id === target?.id);
    };
    return this.toMedia(body.data, included(type.sourceField), included('revision_user'));
  }

  /** Media with this exact name, unpublished ones included (the API client is an administrator) */
  async findMedia(name: string, type = DOCUMENT): Promise<DrupalMedia[]> {
    const response = await this.request(
      `/media/${type.bundle}?filter[name]=${encodeURIComponent(name)}&include=${type.sourceField}`,
    );
    const body = (await response.json()) as { data: JsonApiResource[]; included?: JsonApiResource[] };
    return body.data.map((media) => {
      const fileId = media.relationships?.[type.sourceField]?.data?.id;
      return this.toMedia(media, body.included?.find((resource) => resource.id === fileId));
    });
  }

  async setPublished(uuid: string, published: boolean): Promise<void> {
    await this.request(`/media/${DOCUMENT.bundle}/${uuid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': JSON_API },
      body: JSON.stringify({ data: { type: `media--${DOCUMENT.bundle}`, id: uuid, attributes: { status: published } } }),
    });
  }

  /** Whether the file entity still exists — saving in the editor must keep the previous file */
  async fileExists(fileId: string): Promise<boolean> {
    try {
      await this.request(`/file/file/${fileId}`);
      return true;
    } catch {
      return false;
    }
  }

  /** The numeric user id — the one Document Server's callbacks carry in `users` */
  async userId(username: string): Promise<string> {
    const response = await this.request(`/user/user?filter[name]=${encodeURIComponent(username)}`);
    const [user] = ((await response.json()) as { data: JsonApiResource[] }).data;
    if (!user) {
      throw new Error(`Drupal user ${username} not found`);
    }
    return String(user.attributes.drupal_internal__uid);
  }

  async downloadFile(uuid: string, type = DOCUMENT): Promise<Buffer> {
    const { fileUrl } = await this.getMedia(uuid, type);
    if (!fileUrl) {
      throw new Error(`Drupal media ${uuid} has no file`);
    }
    const response = await fetch(`${this.baseUrl}${fileUrl}`, { headers: this.authHeader });
    if (!response.ok) {
      throw new Error(`Drupal file download ${fileUrl}: ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async deleteMedia(uuid: string, type = DOCUMENT): Promise<void> {
    await this.request(`/media/${type.bundle}/${uuid}`, { method: 'DELETE' });
  }

  private toMedia(media: JsonApiResource, file?: JsonApiResource, revisionUser?: JsonApiResource): DrupalMedia {
    return {
      uuid: media.id,
      mid: media.attributes.drupal_internal__mid,
      name: media.attributes.name,
      changed: media.attributes.changed,
      published: media.attributes.status,
      fileId: file?.id,
      fileUrl: file?.attributes.uri?.url,
      revisionUser: revisionUser?.attributes.name,
    };
  }
}
