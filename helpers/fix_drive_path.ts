import { Notice } from 'obsidian';
import ObsidianGoogleDrive from '../main';

export const fixDrivePath = async (t: ObsidianGoogleDrive) => {
	const treeEntries = await t.drive.scanVaultTree();
	if (!treeEntries) {
		new Notice('An error occurred fetching Google Drive files.');
		return;
	}
	const idToPath = Object.fromEntries(
		treeEntries.map(({ file, path }) => [file.id, path]),
	);
	t.settings.driveIdToPath = idToPath;
	t.settings.operations = {};
	await t.saveSettings?.();
	new Notice(
		'Google Drive paths have been fixed. Please restart the plugin to apply changes.',
	);
};
