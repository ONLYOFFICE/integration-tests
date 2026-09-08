import { TestUser } from '@core';

const PLUGIN_ROOT = '/plugins/com.onlyoffice.mattermost/api';

export interface FileInfo {
  id: string;
  name: string;
  postId: string;
}

export interface PostInfo {
  id: string;
  updateAt: number;
  userId: string;
  rootId: string;
}

interface RawFileInfo {
  id: string;
  name: string;
  post_id: string;
}

interface RawPost {
  id: string;
  update_at: number;
  create_at: number;
  user_id: string;
  root_id: string;
  message: string;
  file_ids?: string[];
}

export interface ThreadReply {
  userId: string;
  message: string;
}

interface RawPostList {
  order: string[];
  posts: Record<string, RawPost>;
}

export class MattermostApi {
  private readonly baseUrl: string;
  private token = '';
  private loginPromise: Promise<void> | null = null;
  private readonly userIdByUsername = new Map<string, string>();

  constructor(baseUrl: string, private readonly user: TestUser) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async login(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/v4/users/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login_id: this.user.username, password: this.user.password }),
    });

    this.token = response.headers.get('Token') ?? '';
    if (!response.ok || !this.token) {
      throw new Error(`Mattermost login failed: HTTP ${response.status} ${await response.text().catch(() => '')}`);
    }
  }

  private async ensureLoggedIn(): Promise<void> {
    if (!this.loginPromise) {
      this.loginPromise = this.login();
    }

    await this.loginPromise;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    await this.ensureLoggedIn();

    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${this.token}`,
    };

    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Mattermost API ${init.method ?? 'GET'} ${path}: ${response.status} ${body}`);
    }

    return response;
  }

  private toFileInfo(raw: RawFileInfo): FileInfo {
    return { id: raw.id, name: raw.name, postId: raw.post_id };
  }

  private toPostInfo(raw: RawPost): PostInfo {
    return { id: raw.id, updateAt: raw.update_at, userId: raw.user_id, rootId: raw.root_id };
  }

  async createChannel(teamId: string, name: string): Promise<string> {
    const response = await this.request('/api/v4/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team_id: teamId, name, display_name: name, type: 'O' }),
    });

    return ((await response.json()) as { id: string }).id;
  }

  async getUserId(username: string): Promise<string> {
    const cached = this.userIdByUsername.get(username);
    if (cached) {
      return cached;
    }

    const response = await this.request(`/api/v4/users/username/${username}`);
    const { id } = (await response.json()) as { id: string };

    this.userIdByUsername.set(username, id);
    return id;
  }

  async uploadFile(channelId: string, name: string, content: Buffer): Promise<FileInfo> {
    const form = new FormData();
    form.append('channel_id', channelId);
    form.append('files', new Blob([new Uint8Array(content)]), name);

    const response = await this.request('/api/v4/files', { method: 'POST', body: form });
    const { file_infos } = (await response.json()) as { file_infos: RawFileInfo[] };

    return this.toFileInfo(file_infos[0]);
  }

  async createPost(channelId: string, fileIds: string[], rootId?: string): Promise<PostInfo> {
    const response = await this.request('/api/v4/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_id: channelId, message: '', file_ids: fileIds, root_id: rootId }),
    });

    return this.toPostInfo((await response.json()) as RawPost);
  }

  async getFileInfo(fileId: string): Promise<FileInfo> {
    const response = await this.request(`/api/v4/files/${fileId}/info`);
    return this.toFileInfo((await response.json()) as RawFileInfo);
  }

  async getPost(postId: string): Promise<PostInfo> {
    const response = await this.request(`/api/v4/posts/${postId}`);
    return this.toPostInfo((await response.json()) as RawPost);
  }

  async downloadFile(fileId: string): Promise<Buffer> {
    const response = await this.request(`/api/v4/files/${fileId}`);
    return Buffer.from(await response.arrayBuffer());
  }

  async deletePost(postId: string): Promise<void> {
    await this.request(`/api/v4/posts/${postId}`, { method: 'DELETE' });
  }

  async getLatestFileInChannel(channelId: string): Promise<FileInfo> {
    const response = await this.request(`/api/v4/channels/${channelId}/posts?per_page=1`);
    const { order, posts } = (await response.json()) as RawPostList;

    const fileId = posts[order[0]]?.file_ids?.[0];
    if (!fileId) {
      throw new Error(`No file found in the most recent post of channel ${channelId}`);
    }

    return this.getFileInfo(fileId);
  }

  async getLatestReplyFile(rootId: string): Promise<FileInfo> {
    const response = await this.request(`/api/v4/posts/${rootId}/thread`);
    const { order, posts } = (await response.json()) as RawPostList;

    const replies = order.map((id) => posts[id]).filter((post) => post.id !== rootId && post.file_ids?.length);
    if (!replies.length) {
      throw new Error(`No reply with a file was posted to thread ${rootId}`);
    }

    const latest = replies.reduce((a, b) => (a.create_at > b.create_at ? a : b));
    return this.getFileInfo(latest.file_ids![0]);
  }

  async getThreadReplies(rootId: string): Promise<ThreadReply[]> {
    const response = await this.request(`/api/v4/posts/${rootId}/thread`);
    const { order, posts } = (await response.json()) as RawPostList;
    return order.filter((id) => id !== rootId).map((id) => ({ userId: posts[id].user_id, message: posts[id].message }));
  }

  async grantEditPermission(fileId: string, username: string): Promise<void> {
    const userId = await this.getUserId(username);
    await this.request(`${PLUGIN_ROOT}/permissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        {
          fileID: fileId,
          userID: userId,
          username,
          permissions: {
            edit: true,
            chat: true,
            comment: true,
            copy: true,
            download: true,
            print: true,
            review: true,
            protect: false,
          },
        },
      ]),
    });
  }
}
