import { beforeEach, describe, expect, it, vi } from 'vitest';

const notices = vi.hoisted(() => [] as string[]);

vi.mock('obsidian', () => {
	class TFile {
		path: string;
		constructor(path: string) {
			this.path = path;
		}
	}
	class TFolder {
		path: string;
		children: { path: string }[] = [];
		constructor(path: string) {
			this.path = path;
		}
	}
	return {
		Notice: class {
			constructor(message: string) {
				notices.push(message);
			}
		},
		requestUrl: vi.fn(),
		TAbstractFile: class {},
		TFile,
		TFolder,
	};
});

import { pull } from '../helpers/pull';
import { googleDocMimeType } from '../helpers/drive';
import { TFile } from 'obsidian';

const createPlugin = () => {
	const adapter = {
		exists: vi.fn(async () => false),
		stat: vi.fn(
			async (
				_path: string,
			): Promise<{ type: 'file' | 'folder'; mtime?: number } | undefined> =>
				undefined,
		),
		readBinary: vi.fn(async () => new ArrayBuffer(2)),
		writeBinary: vi.fn(async () => undefined),
		trashLocal: vi.fn(async () => true),
		trashSystem: vi.fn(async () => true),
		remove: vi.fn(async () => undefined),
		list: vi.fn(async () => ({ files: [], folders: [] })),
		rmdir: vi.fn(async () => undefined),
	};
	const vault = {
		adapter,
		configDir: 'config',
		getAllLoadedFiles: vi.fn((): { path: string }[] => []),
		getAbstractFileByPath: vi.fn(
			(_path: string): TFile | null => null,
		),
		getFileByPath: vi.fn((_path: string): TFile | null => null),
		getFolderByPath: vi.fn((_path: string) => null),
		getConfig: vi.fn(() => 'local'),
	};
	return {
		accessToken: { token: 'access', expiresAt: Date.now() + 3_600_000 },
		app: { vault },
		settings: {
			lastSyncedAt: 0,
			changesToken: 'changes',
			preferCloudWhenNewer: true,
			backupOnConflict: true,
			driveIdToPath: {} as Record<string, string>,
			operations: {} as Record<string, 'create' | 'delete' | 'modify'>,
		},
		drive: {
			scanVaultTree: vi.fn(
				async (): Promise<
					{ file: Record<string, unknown>; path: string }[] | undefined
				> => [],
			),
			getChanges: vi.fn(
				async (): Promise<
					{
						removed: boolean;
						fileId: string;
						file?: { trashed?: boolean };
					}[]
				> => [],
			),
			deleteFilesMinimumOperations: vi.fn(async () => undefined),
			getFile: vi.fn(),
			exportFile: vi.fn(),
		},
		abortSync: vi.fn(),
		endSync: vi.fn(async () => true),
		createFolder: vi.fn(),
		modifyFile: vi.fn(),
		upsertFile: vi.fn(),
		renameFile: vi.fn(),
	};
};

describe('pull', () => {
	beforeEach(() => {
		notices.length = 0;
	});

	it('finishes a silent no-change pull without advancing the checkpoint itself', async () => {
		const plugin = createPlugin();

		await expect(pull(plugin as never, true)).resolves.toBe(true);

		expect(plugin.endSync).not.toHaveBeenCalled();
		expect(plugin.abortSync).not.toHaveBeenCalled();
	});

	it('aborts when Drive files cannot be listed', async () => {
		const plugin = createPlugin();
		plugin.drive.scanVaultTree.mockResolvedValueOnce(undefined);

		await expect(pull(plugin as never, true)).resolves.toBe(false);

		expect(plugin.abortSync).toHaveBeenCalledOnce();
	});

	it('reconciles creates, deletes, and renames made while Obsidian was closed', async () => {
		const plugin = createPlugin();
		plugin.settings.driveIdToPath = {
			'old-id': 'old.md',
			'stable-id': 'stable.md',
		};
		plugin.app.vault.getAllLoadedFiles.mockReturnValue([
			{ path: '/' },
			{ path: 'renamed.md' },
			{ path: 'stable.md' },
		]);

		await expect(pull(plugin as never, true)).resolves.toBe(true);

		expect(plugin.settings.operations).toEqual({
			'old.md': 'delete',
			'renamed.md': 'create',
		});
	});

	it('cleans stale operations while preserving config operations', async () => {
		const plugin = createPlugin();
		plugin.settings.driveIdToPath = {
			'stable-id': 'stable.md',
			'missing-id': 'missing.md',
		};
		plugin.settings.operations = {
			'ghost.md': 'create',
			'stable.md': 'delete',
			'missing.md': 'modify',
			'config/plugins/example/data.json': 'modify',
		};
		plugin.app.vault.getAllLoadedFiles.mockReturnValue([
			{ path: '/' },
			{ path: 'stable.md' },
		]);

		await expect(pull(plugin as never, true)).resolves.toBe(true);

		expect(plugin.settings.operations).toEqual({
			'stable.md': 'modify',
			'missing.md': 'delete',
			'config/plugins/example/data.json': 'modify',
		});
	});

	it('uses the preserved ID mapping to trash a remotely deleted config file', async () => {
		const plugin = createPlugin();
		const path = 'config/plugins/example/data.json';
		plugin.settings.driveIdToPath['drive-id'] = path;
		plugin.drive.getChanges.mockResolvedValueOnce([
			{ removed: true, fileId: 'drive-id' },
		]);
		plugin.app.vault.adapter.stat.mockResolvedValueOnce({ type: 'file' });

		await expect(pull(plugin as never, true)).resolves.toBe(true);

		expect(plugin.app.vault.adapter.trashLocal).toHaveBeenCalledWith(path);
		expect(plugin.settings.driveIdToPath).not.toHaveProperty('drive-id');
	});

	it('pulls folders and files while applying regular and config deletions', async () => {
		const plugin = createPlugin();
		const deletedFile = new TFile();
		Object.assign(deletedFile, { path: 'deleted.md' });
		const configPath = 'config/plugins/example/data.json';
		plugin.settings.driveIdToPath = {
			'deleted-id': deletedFile.path,
			'config-id': configPath,
		};
		plugin.app.vault.getAbstractFileByPath.mockImplementation(
			(path: string) => (path === deletedFile.path ? deletedFile : null),
		);
		plugin.app.vault.getAllLoadedFiles.mockReturnValue([
			{ path: deletedFile.path },
		]);
		plugin.app.vault.adapter.stat.mockImplementation(async (path: string) =>
			path === configPath ? { type: 'file' as const } : undefined,
		);
		plugin.drive.scanVaultTree.mockResolvedValueOnce([
			{
				file: {
					id: 'folder-id',
					mimeType: 'application/vnd.google-apps.folder',
					properties: { path: 'remote' },
					modifiedTime: '2025-01-01T00:00:00.000Z',
				},
				path: 'remote',
			},
			{
				file: {
					id: 'note-id',
					mimeType: 'text/markdown',
					properties: { path: 'remote/note.md' },
					modifiedTime: '2025-01-01T00:00:00.000Z',
				},
				path: 'remote/note.md',
			},
		]);
		plugin.drive.getChanges.mockResolvedValueOnce([
			{ removed: true, fileId: 'deleted-id' },
			{ removed: true, fileId: 'config-id' },
		]);
		plugin.drive.getFile.mockReturnValue({
			arrayBuffer: vi.fn(async () => new ArrayBuffer(4)),
		});

		await expect(pull(plugin as never, true)).resolves.toBe(true);

		expect(plugin.drive.deleteFilesMinimumOperations).toHaveBeenCalledWith([
			deletedFile,
		]);
		expect(plugin.createFolder).toHaveBeenCalledWith('remote');
		expect(plugin.upsertFile).toHaveBeenCalledWith(
			'remote/note.md',
			expect.any(ArrayBuffer),
			'2025-01-01T00:00:00.000Z',
		);
		expect(plugin.app.vault.adapter.trashLocal).toHaveBeenCalledWith(
			configPath,
		);
		expect(plugin.settings.driveIdToPath).toEqual({
			'folder-id': 'remote',
			'note-id': 'remote/note.md',
		});
	});

	it('pulls externally created files without properties and creates missing parent folders', async () => {
		const plugin = createPlugin();
		plugin.settings.lastSyncedAt = Date.parse('2026-11-15T00:00:00.000Z');
		plugin.drive.scanVaultTree.mockResolvedValueOnce([
			{
				file: {
					id: 'gemini-note-id',
					name: '2026-11-14.md',
					mimeType: 'text/markdown',
					modifiedTime: '2026-11-14T10:00:00.000Z',
				},
				path: 'Daily/2026-11-14.md',
			},
		]);
		plugin.drive.getFile.mockReturnValue({
			arrayBuffer: vi.fn(async () => new ArrayBuffer(8)),
		});

		await expect(pull(plugin as never, true)).resolves.toBe(true);

		expect(plugin.createFolder).toHaveBeenCalledWith('Daily');
		expect(plugin.upsertFile).toHaveBeenCalledWith(
			'Daily/2026-11-14.md',
			expect.any(ArrayBuffer),
			'2026-11-14T10:00:00.000Z',
		);
		expect(plugin.settings.driveIdToPath).toEqual({
			'gemini-note-id': 'Daily/2026-11-14.md',
		});
	});

	it('exports Google Docs as markdown instead of calling getFile', async () => {
		const plugin = createPlugin();
		const mdBuffer = new TextEncoder().encode('# Gemini Summary').buffer;
		plugin.drive.scanVaultTree.mockResolvedValueOnce([
			{
				file: {
					id: 'gdoc-id',
					name: '物理筆記',
					mimeType: googleDocMimeType,
					modifiedTime: '2026-11-14T12:00:00.000Z',
				},
				path: '物理筆記.md',
			},
		]);
		plugin.drive.exportFile.mockReturnValue({
			arrayBuffer: vi.fn(async () => mdBuffer),
		});

		await expect(pull(plugin as never, true)).resolves.toBe(true);

		expect(plugin.drive.getFile).not.toHaveBeenCalled();
		expect(plugin.drive.exportFile).toHaveBeenCalledWith(
			'gdoc-id',
			'text/markdown',
		);
		expect(plugin.upsertFile).toHaveBeenCalledWith(
			'物理筆記.md',
			mdBuffer,
			'2026-11-14T12:00:00.000Z',
		);
	});

	it('overwrites local modify when cloud is newer, backs up local file, and clears operations', async () => {
		const plugin = createPlugin();
		const localFile = new TFile();
		Object.assign(localFile, {
			path: 'note.md',
			stat: { mtime: Date.parse('2026-11-14T08:00:00.000Z') },
		});
		const localBuffer = new TextEncoder().encode('local draft').buffer;
		const cloudBuffer = new TextEncoder().encode('cloud refined').buffer;

		plugin.settings.driveIdToPath = { 'note-id': 'note.md' };
		plugin.settings.operations = { 'note.md': 'modify' };
		plugin.settings.lastSyncedAt = Date.parse('2026-11-14T07:00:00.000Z');
		plugin.app.vault.getAllLoadedFiles.mockReturnValue([{ path: 'note.md' }]);
		plugin.app.vault.getFileByPath.mockReturnValue(localFile);
		plugin.app.vault.adapter.readBinary.mockResolvedValueOnce(localBuffer);
		plugin.drive.scanVaultTree.mockResolvedValueOnce([
			{
				file: {
					id: 'note-id',
					name: 'note.md',
					mimeType: 'text/markdown',
					modifiedTime: '2026-11-14T10:00:00.000Z',
				},
				path: 'note.md',
			},
		]);
		plugin.drive.getFile.mockReturnValue({
			arrayBuffer: vi.fn(async () => cloudBuffer),
		});

		await expect(pull(plugin as never, true)).resolves.toBe(true);

		expect(plugin.app.vault.adapter.writeBinary).toHaveBeenCalledWith(
			expect.stringMatching(/^note\.conflict-\d+\.md$/),
			localBuffer,
		);
		expect(plugin.modifyFile).toHaveBeenCalledWith(
			localFile,
			cloudBuffer,
			'2026-11-14T10:00:00.000Z',
		);
		expect(plugin.settings.operations).not.toHaveProperty('note.md');
	});

	it('forces cloud overwrite when forceCloud is true even if local is newer', async () => {
		const plugin = createPlugin();
		const localFile = new TFile();
		Object.assign(localFile, {
			path: 'note.md',
			stat: { mtime: Date.parse('2026-11-14T12:00:00.000Z') },
		});
		const cloudBuffer = new TextEncoder().encode('cloud version').buffer;

		plugin.settings.driveIdToPath = { 'note-id': 'note.md' };
		plugin.settings.operations = { 'note.md': 'modify' };
		plugin.settings.backupOnConflict = false;
		plugin.app.vault.getAllLoadedFiles.mockReturnValue([{ path: 'note.md' }]);
		plugin.app.vault.getFileByPath.mockReturnValue(localFile);
		plugin.drive.scanVaultTree.mockResolvedValueOnce([
			{
				file: {
					id: 'note-id',
					name: 'note.md',
					mimeType: 'text/markdown',
					modifiedTime: '2026-11-14T10:00:00.000Z',
				},
				path: 'note.md',
			},
		]);
		plugin.drive.getFile.mockReturnValue({
			arrayBuffer: vi.fn(async () => cloudBuffer),
		});

		await expect(pull(plugin as never, true, true)).resolves.toBe(true);

		expect(plugin.app.vault.adapter.writeBinary).not.toHaveBeenCalled();
		expect(plugin.modifyFile).toHaveBeenCalledWith(
			localFile,
			cloudBuffer,
			'2026-11-14T10:00:00.000Z',
		);
		expect(plugin.settings.operations).not.toHaveProperty('note.md');
	});

	it('syncs Drive renames/moves and trashed files', async () => {
		const plugin = createPlugin();
		const movedFile = new TFile();
		Object.assign(movedFile, { path: 'old.md' });
		const trashedFile = new TFile();
		Object.assign(trashedFile, { path: 'trashed.md' });

		plugin.settings.driveIdToPath = {
			'moved-id': 'old.md',
			'trashed-id': 'trashed.md',
		};
		plugin.app.vault.getAllLoadedFiles.mockReturnValue([
			{ path: 'old.md' },
			{ path: 'trashed.md' },
		]);
		plugin.app.vault.getAbstractFileByPath.mockImplementation(
			(path: string) => {
				if (path === 'old.md') return movedFile;
				if (path === 'trashed.md') return trashedFile;
				return null;
			},
		);
		plugin.renameFile.mockImplementation(
			async (file: TFile, newPath: string) => {
				file.path = newPath;
			},
		);
		plugin.app.vault.getFileByPath.mockImplementation((path: string) =>
			path === 'Moved/new.md' && movedFile.path === 'Moved/new.md'
				? movedFile
				: null,
		);
		plugin.drive.scanVaultTree.mockResolvedValueOnce([
			{
				file: {
					id: 'moved-id',
					name: 'new.md',
					mimeType: 'text/markdown',
					modifiedTime: '2026-11-14T11:00:00.000Z',
				},
				path: 'Moved/new.md',
			},
		]);
		plugin.drive.getChanges.mockResolvedValueOnce([
			{
				removed: false,
				fileId: 'trashed-id',
				file: { trashed: true },
			},
		]);
		plugin.drive.getFile.mockReturnValue({
			arrayBuffer: vi.fn(async () => new ArrayBuffer(4)),
		});

		await expect(pull(plugin as never, true)).resolves.toBe(true);

		expect(plugin.createFolder).toHaveBeenCalledWith('Moved');
		expect(plugin.renameFile).toHaveBeenCalledWith(
			movedFile,
			'Moved/new.md',
		);
		expect(plugin.drive.deleteFilesMinimumOperations).toHaveBeenCalledWith([
			trashedFile,
		]);
		expect(plugin.settings.driveIdToPath).toEqual({
			'moved-id': 'Moved/new.md',
		});
	});
});
