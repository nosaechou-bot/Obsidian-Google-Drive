import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestUrl = vi.hoisted(() => vi.fn());

vi.mock('obsidian', () => ({
	Notice: class {},
	requestUrl,
	TAbstractFile: class {},
	TFolder: class {},
}));

import {
	getDriveClient,
	googleDocMimeType,
	splitPath,
	unSplitPath,
} from '../helpers/drive';

const createPlugin = () =>
	({
		accessToken: {
			token: 'access-token',
			expiresAt: Date.now() + 3_600_000,
		},
		app: { vault: { getName: () => 'Test vault' } },
		settings: { refreshToken: 'refresh-token', rootFolderId: '' },
		saveSettings: vi.fn(async () => undefined),
	}) as never;

describe('Drive path properties', () => {
	it('round-trips paths longer than a Drive property value', () => {
		const path = `${'folder/'.repeat(20)}note.md`;

		expect(unSplitPath(splitPath(path))).toBe(path);
		expect(
			Object.values(splitPath(path)).every((part) => part.length <= 100),
		).toBe(true);
	});

	it('splits Unicode paths by UTF-8 byte length', () => {
		const path = `${'资料/😀/'.repeat(20)}笔记.md`;
		const properties = splitPath(path);
		const encoder = new TextEncoder();

		expect(unSplitPath(properties)).toBe(path);
		expect(Object.keys(properties).length).toBeGreaterThan(1);
		expect(
			Object.values(properties).every(
				(part) => encoder.encode(part).length <= 100,
			),
		).toBe(true);
	});

	it('returns an empty string when properties are undefined', () => {
		expect(unSplitPath(undefined)).toBe('');
	});
});

describe('Drive batch deletion', () => {
	beforeEach(() => {
		requestUrl.mockReset();
		requestUrl.mockImplementation(
			async ({ body }: { body?: string | ArrayBuffer }) => {
				const requestBody = typeof body === 'string' ? body : '';
				const requestCount =
					requestBody.match(/^DELETE /gm)?.length ?? 0;
				return {
					status: 200,
					headers: {},
					arrayBuffer: new ArrayBuffer(0),
					json: {},
					text: Array.from(
						{ length: requestCount },
						() => 'HTTP/1.1 204 No Content',
					).join('\r\n'),
				};
			},
		);
	});

	it('sends raw multipart/mixed requests instead of FormData', async () => {
		const drive = getDriveClient(createPlugin());

		await expect(drive.batchDelete(['file-1', 'file-2'])).resolves.toBe(
			true,
		);

		const request = requestUrl.mock.calls[0]?.[0] as {
			body: string;
			headers: Record<string, string>;
		};
		const boundary = request.headers['Content-Type']?.split('boundary=')[1];

		expect(boundary).toBeTruthy();
		expect(request.body).toContain(`--${boundary}`);
		expect(request.body).toContain('Content-Type: application/http');
		expect(request.body).toContain(
			'DELETE /drive/v3/files/file-1 HTTP/1.1',
		);
		expect(request.body).not.toContain('Content-Disposition: form-data');
		expect(request.body).toMatch(new RegExp(`--${boundary}--\\r\\n$`));
	});

	it('splits more than 100 deletions into multiple requests', async () => {
		const drive = getDriveClient(createPlugin());
		const ids = Array.from({ length: 101 }, (_, index) => `file-${index}`);

		await expect(drive.batchDelete(ids)).resolves.toBe(true);

		const firstRequest = requestUrl.mock.calls[0]?.[0] as
			| { body?: unknown }
			| undefined;
		const secondRequest = requestUrl.mock.calls[1]?.[0] as
			| { body?: unknown }
			| undefined;
		const firstBody =
			typeof firstRequest?.body === 'string' ? firstRequest.body : '';
		const secondBody =
			typeof secondRequest?.body === 'string' ? secondRequest.body : '';

		expect(requestUrl).toHaveBeenCalledTimes(2);
		expect(firstBody.match(/^DELETE /gm)).toHaveLength(100);
		expect(secondBody.match(/^DELETE /gm)).toHaveLength(1);
	});

	it('fails when any nested deletion fails', async () => {
		requestUrl.mockResolvedValueOnce({
			status: 200,
			headers: {},
			arrayBuffer: new ArrayBuffer(0),
			json: {},
			text: ['HTTP/1.1 204 No Content', 'HTTP/1.1 404 Not Found'].join(
				'\r\n',
			),
		});
		const drive = getDriveClient(createPlugin());

		await expect(
			drive.batchDelete(['file-1', 'missing-file']),
		).resolves.toBeUndefined();
	});
});

describe('Drive root folder persistence', () => {
	it('validates a persisted root once and then reuses it', async () => {
		requestUrl.mockResolvedValue({
			status: 200,
			headers: {},
			arrayBuffer: new ArrayBuffer(0),
			text: '',
			json: {
				files: [
					{
						id: 'root-id',
						mimeType: 'application/vnd.google-apps.folder',
						trashed: false,
						properties: {
							obsidian: 'vault',
							vault: 'Test vault',
						},
					},
				],
			},
		});
		const plugin = {
			accessToken: {
				token: 'access-token',
				expiresAt: Date.now() + 3_600_000,
			},
			app: { vault: { getName: () => 'Test vault' } },
			settings: {
				refreshToken: 'refresh-token',
			},
			saveSettings: vi.fn(async () => undefined),
		};
		const drive = getDriveClient(plugin as never);

		await expect(drive.getRootFolderId(true)).resolves.toBe('root-id');
		await expect(drive.getRootFolderId()).resolves.toBe('root-id');

		expect(requestUrl).toHaveBeenCalledOnce();
		expect(plugin.saveSettings).toHaveBeenCalledOnce();
	});
});

describe('Drive export, changes, and tree scanning', () => {
	beforeEach(() => {
		requestUrl.mockReset();
	});

	it('exports Google Docs as text/markdown', async () => {
		requestUrl.mockResolvedValueOnce({
			status: 200,
			headers: {},
			arrayBuffer: new TextEncoder().encode('# Doc').buffer,
			json: {},
			text: '# Doc',
		});
		const drive = getDriveClient(createPlugin());

		const res = await drive.exportFile('doc-1');

		await expect(res.text()).resolves.toBe('# Doc');
		expect(requestUrl).toHaveBeenCalledWith(
			expect.objectContaining({
				url: 'https://www.googleapis.com/drive/v3/files/doc-1/export?mimeType=text%2Fmarkdown',
				method: 'GET',
			}),
		);
	});

	it('requests file trashed, parents, and properties fields in getChanges', async () => {
		requestUrl.mockResolvedValueOnce({
			status: 200,
			headers: {},
			arrayBuffer: new ArrayBuffer(0),
			text: '',
			json: {
				changes: [
					{
						removed: false,
						fileId: 'trashed-id',
						file: { id: 'trashed-id', trashed: true },
					},
				],
			},
		});
		const drive = getDriveClient(createPlugin());

		const changes = await drive.getChanges('token-1');

		expect(changes).toHaveLength(1);
		const call = requestUrl.mock.calls[0]?.[0] as { url: string };
		expect(decodeURIComponent(call.url)).toContain(
			'changes(removed,fileId,time,file(id,trashed,parents,properties))',
		);
	});

	it('scans nested folders, normalizes Google Docs to .md, and self-heals properties', async () => {
		const plugin = {
			accessToken: {
				token: 'access-token',
				expiresAt: Date.now() + 3_600_000,
			},
			app: { vault: { getName: () => 'Test vault' } },
			settings: {
				refreshToken: 'refresh-token',
				rootFolderId: 'root-id',
			},
			saveSettings: vi.fn(async () => undefined),
		};

		requestUrl.mockImplementation(
			async ({ url, method }: { url: string; method?: string }) => {
				if (method === 'PATCH') {
					return {
						status: 200,
						headers: {},
						arrayBuffer: new ArrayBuffer(0),
						text: '',
						json: { id: url.split('/').pop() },
					};
				}
				const decodedUrl = decodeURIComponent(url);
				if (decodedUrl.includes("'root-id' in parents")) {
					return {
						status: 200,
						headers: {},
						arrayBuffer: new ArrayBuffer(0),
						text: '',
						json: {
							files: [
								{
									id: 'daily-folder',
									name: 'Daily',
									mimeType:
										'application/vnd.google-apps.folder',
									parents: ['root-id'],
									modifiedTime: '2026-11-14T00:00:00.000Z',
									trashed: false,
								},
								{
									id: 'gdoc-1',
									name: '物理筆記',
									mimeType: googleDocMimeType,
									parents: ['root-id'],
									modifiedTime: '2026-11-14T00:00:00.000Z',
									trashed: false,
								},
							],
						},
					};
				}
				if (decodedUrl.includes("'daily-folder' in parents")) {
					return {
						status: 200,
						headers: {},
						arrayBuffer: new ArrayBuffer(0),
						text: '',
						json: {
							files: [
								{
									id: 'daily-note',
									name: '2026-11-14.md',
									mimeType: 'text/markdown',
									parents: ['daily-folder'],
									properties: {
										vault: 'Test vault',
										path: 'Old/2026-11-14.md',
										path2: 'extra-chunk',
									},
									modifiedTime: '2026-11-14T01:00:00.000Z',
									trashed: false,
								},
							],
						},
					};
				}
				return {
					status: 200,
					headers: {},
					arrayBuffer: new ArrayBuffer(0),
					text: '',
					json: { files: [] },
				};
			},
		);

		const drive = getDriveClient(plugin as never);
		const entries = await drive.scanVaultTree();

		expect(entries?.map((e) => ({ id: e.file.id, path: e.path }))).toEqual([
			{ id: 'daily-folder', path: 'Daily' },
			{ id: 'gdoc-1', path: '物理筆記.md' },
			{ id: 'daily-note', path: 'Daily/2026-11-14.md' },
		]);

		const patchCalls = requestUrl.mock.calls
			.map((c) => c[0] as { url: string; method?: string; body?: string })
			.filter((c) => c.method === 'PATCH');

		expect(patchCalls).toHaveLength(3);
		const dailyNotePatch = patchCalls.find((c) =>
			c.url.endsWith('/daily-note'),
		);
		expect(JSON.parse(dailyNotePatch?.body ?? '{}')).toEqual({
			properties: {
				vault: 'Test vault',
				path: 'Daily/2026-11-14.md',
				path2: null,
			},
		});
	});
});
