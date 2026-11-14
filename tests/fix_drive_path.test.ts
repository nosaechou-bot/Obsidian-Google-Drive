import { beforeEach, describe, expect, it, vi } from 'vitest';

const notice = vi.hoisted(() => vi.fn());

vi.mock('obsidian', () => ({
	Notice: notice,
	requestUrl: vi.fn(),
	TAbstractFile: class {},
	TFolder: class {},
}));

import { fixDrivePath } from '../helpers/fix_drive_path';

describe('fixDrivePath', () => {
	beforeEach(() => {
		notice.mockReset();
	});

	it('rebuilds the Drive ID mapping and clears pending operations', async () => {
		const scanVaultTree = vi.fn(async () => [
			{
				file: { id: 'short-path-id' },
				path: 'folder/note.md',
			},
			{
				file: { id: 'split-path-id' },
				path: 'long/folder/nested/note.md',
			},
		]);
		const saveSettings = vi.fn(async () => undefined);
		const plugin = {
			drive: { scanVaultTree },
			saveSettings,
			settings: {
				driveIdToPath: { stale: 'old/path.md' },
				operations: { 'pending.md': 'create' },
			},
		};

		await fixDrivePath(plugin as never);

		expect(scanVaultTree).toHaveBeenCalledOnce();
		expect(plugin.settings.driveIdToPath).toEqual({
			'short-path-id': 'folder/note.md',
			'split-path-id': 'long/folder/nested/note.md',
		});
		expect(plugin.settings.operations).toEqual({});
		expect(saveSettings).toHaveBeenCalledOnce();
		expect(notice).toHaveBeenCalledWith(
			'Google Drive paths have been fixed. Please restart the plugin to apply changes.',
		);
	});

	it('preserves existing state when Drive files cannot be fetched', async () => {
		const driveIdToPath = { existing: 'note.md' };
		const operations = { 'pending.md': 'modify' };
		const plugin = {
			drive: { scanVaultTree: vi.fn(async () => undefined) },
			settings: { driveIdToPath, operations },
		};

		await fixDrivePath(plugin as never);

		expect(plugin.settings.driveIdToPath).toBe(driveIdToPath);
		expect(plugin.settings.operations).toBe(operations);
		expect(notice).toHaveBeenCalledWith(
			'An error occurred fetching Google Drive files.',
		);
	});
});
