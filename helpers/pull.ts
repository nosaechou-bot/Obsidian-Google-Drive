import type ObsidianGoogleDrive from '../main';
import { Notice, TFile, TFolder } from 'obsidian';
import {
	batchAsync,
	FileMetadata,
	folderMimeType,
	foldersToBatches,
	getSyncMessage,
	googleDocMimeType,
	VaultTreeEntry,
} from './drive';
import { refreshAccessToken } from './requests';

export const getConflictBackupPath = (path: string, timestamp = Date.now()) => {
	const dotIndex = path.lastIndexOf('.');
	const slashIndex = path.lastIndexOf('/');
	if (dotIndex > slashIndex && dotIndex > 0) {
		return `${path.slice(0, dotIndex)}.conflict-${timestamp}${path.slice(dotIndex)}`;
	}
	return `${path}.conflict-${timestamp}`;
};

const isRemovedChange = (change: {
	removed: boolean;
	file?: Partial<FileMetadata>;
}) => Boolean(change.removed || change.file?.trashed);

export const pull = async (
	t: ObsidianGoogleDrive,
	silenceNotices = false,
	forceCloud = false,
) => {
	let syncNotice = undefined;

	if (!silenceNotices) {
		if (t.syncing) return;
		syncNotice = await t.startSync();
	}
	try {
		const { vault } = t.app;
		const adapter = vault.adapter;

		if (!t.accessToken.token) {
			if (!(await refreshAccessToken(t))) {
				new Notice(
					'Failed to refresh access token. Please re-authenticate.',
				);
				t.abortSync(syncNotice);
				return false;
			}
		}

		const treeEntries = await t.drive.scanVaultTree(true, forceCloud);
		if (!treeEntries) {
			new Notice('An error occurred fetching Google Drive files.');
			t.abortSync(syncNotice);
			return false;
		}

		const recentlyModified: VaultTreeEntry[] = treeEntries.filter(
			({ file, path }) => {
				if (forceCloud) return true;
				const prevPath = t.settings.driveIdToPath[file.id];
				if (!prevPath || prevPath !== path) return true;
				const mtime = file.modifiedTime
					? new Date(file.modifiedTime).getTime()
					: 0;
				return mtime > t.settings.lastSyncedAt;
			},
		);

		const renamedEntries: VaultTreeEntry[] = treeEntries.filter(
			({ file, path }) => {
				const oldPath = t.settings.driveIdToPath[file.id];
				return Boolean(oldPath && oldPath !== path);
			},
		);
		const renamedOldPaths = new Set(
			renamedEntries
				.map(({ file }) => t.settings.driveIdToPath[file.id])
				.filter((path): path is string => Boolean(path)),
		);

		const cloudSet = new Set(
			Object.values(t.settings.driveIdToPath).filter(
				(path) =>
					!path.startsWith(vault.configDir + '/') &&
					path !== vault.configDir,
			),
		);

		const localSet = new Set(
			vault
				.getAllLoadedFiles()
				.map((file) => file.path)
				.filter((path) => path !== '/'),
		);

		cloudSet.forEach((path) => {
			if (!localSet.has(path) && !renamedOldPaths.has(path)) {
				t.settings.operations[path] = 'delete';
			}
		});

		for (const path in t.settings.operations) {
			if (
				path === vault.configDir ||
				path.startsWith(vault.configDir + '/')
			) {
				continue;
			}

			const operation = t.settings.operations[path];
			const existsLocally = localSet.has(path);

			if (operation === 'delete' && existsLocally) {
				t.settings.operations[path] = 'modify';
			} else if (operation === 'create' && !existsLocally) {
				delete t.settings.operations[path];
			} else if (operation === 'modify' && !existsLocally) {
				t.settings.operations[path] = 'delete';
			}
		}

		recentlyModified.forEach(({ path }) => cloudSet.add(path));

		localSet.forEach((path) => {
			if (!cloudSet.has(path)) {
				t.settings.operations[path] = 'create';
			}
		});

		const changes = await t.drive.getChanges(t.settings.changesToken);
		if (!changes) {
			new Notice('An error occurred fetching Google Drive changes.');
			t.abortSync(syncNotice);
			return false;
		}
		const removedPaths = Object.fromEntries(
			changes
				.filter(isRemovedChange)
				.map(({ fileId }) => [
					fileId,
					t.settings.driveIdToPath[fileId],
				]),
		);

		const deletions = changes
			.filter(isRemovedChange)
			.map(({ fileId }) => {
				const path = t.settings.driveIdToPath[fileId];
				if (!path) return;
				delete t.settings.driveIdToPath[fileId];

				const file = vault.getAbstractFileByPath(path);

				if (!file && t.settings.operations[path] === 'delete') {
					delete t.settings.operations[path];
					return;
				}
				return file;
			});

		if (
			!recentlyModified.length &&
			!deletions.length &&
			!renamedEntries.length
		) {
			if (silenceNotices) return true;
			const ended = await t.endSync(syncNotice);
			if (ended) new Notice("You're up to date!");
			return ended;
		}

		const oldIdToPath = { ...t.settings.driveIdToPath };

		const pathToId = Object.fromEntries(
			Object.entries(t.settings.driveIdToPath).map(([id, path]) => [
				path,
				id,
			]),
		);

		const updateMap = () => {
			renamedEntries.forEach(({ file }) => {
				const oldPath = oldIdToPath[file.id];
				if (oldPath && pathToId[oldPath] === file.id) {
					delete pathToId[oldPath];
				}
			});

			recentlyModified.forEach(({ file, path }) => {
				pathToId[path] = file.id;
			});

			t.settings.driveIdToPath = Object.fromEntries(
				Object.entries(pathToId).map(([path, id]) => [id, path]),
			);
		};

		updateMap();

		const deleteFiles = async () => {
			const deletedFiles = deletions
				.filter((file) => file instanceof TFile)
				.filter((file: TFile) => {
					if (t.settings.operations[file.path] === 'modify') {
						if (!pathToId[file.path]) {
							t.settings.operations[file.path] = 'create';
						}
						return;
					}
					return true;
				});

			const deletionPaths = deletions.map((file) => file?.path);

			const deletedFolders = deletions
				.filter((folder) => folder instanceof TFolder)
				.filter((folder: TFolder) => {
					if (pathToId[folder.path]) return;
					if (
						folder.children.find(
							({ path }) => !deletionPaths.includes(path),
						)
					) {
						return true;
					}
					t.settings.operations[folder.path] = 'create';
					return;
				});

			await t.drive.deleteFilesMinimumOperations([
				...deletedFolders,
				...deletedFiles,
			]);
		};

		await deleteFiles();

		const renameRemoteMovedFiles = async () => {
			const sortedRenames = [...renamedEntries].sort(
				(a, b) => a.path.split('/').length - b.path.split('/').length,
			);
			for (const { file, path: newPath } of sortedRenames) {
				const oldPath = oldIdToPath[file.id];
				if (!oldPath || oldPath === newPath) continue;
				const oldOp = t.settings.operations[oldPath];
				delete t.settings.operations[oldPath];

				if (
					!forceCloud &&
					(oldOp === 'modify' || oldOp === 'delete')
				) {
					t.settings.operations[newPath] = oldOp;
					continue;
				}

				const existingLocal = vault.getAbstractFileByPath(oldPath);
				if (!existingLocal) continue;

				const parentDir = newPath.includes('/')
					? newPath.slice(0, newPath.lastIndexOf('/'))
					: '';
				if (parentDir) {
					const parts = parentDir.split('/');
					let cur = '';
					for (const part of parts) {
						cur = cur ? `${cur}/${part}` : part;
						if (
							!vault.getFolderByPath(cur) &&
							!(await adapter.exists(cur))
						) {
							await t.createFolder(cur);
						}
					}
				}

				await t.renameFile(existingLocal, newPath);
			}
		};

		await renameRemoteMovedFiles();

		syncNotice?.setMessage('Syncing (33%)');

		const upsertFiles = async () => {
			const newFolders = recentlyModified.filter(
				({ file }) => file.mimeType === folderMimeType,
			);
			const newNotes = recentlyModified.filter(
				({ file }) => file.mimeType !== folderMimeType,
			);

			const folderPaths = new Set<string>(
				newFolders.map(({ path }) => path),
			);
			for (const { path } of newNotes) {
				const parts = path.split('/').slice(0, -1);
				let cur = '';
				for (const part of parts) {
					cur = cur ? `${cur}/${part}` : part;
					folderPaths.add(cur);
				}
			}

			if (folderPaths.size) {
				const batches = foldersToBatches([...folderPaths]);

				for (const batch of batches) {
					await Promise.all(
						batch.map(async (folder) => {
							delete t.settings.operations[folder];
							if (
								vault.getFolderByPath(folder) ||
								(await adapter.exists(folder))
							) {
								return;
							}
							return t.createFolder(folder);
						}),
					);
				}
			}

			let completed = 0;

			await batchAsync(
				newNotes.map(({ file, path }: VaultTreeEntry) => async () => {
					const localFile =
						vault.getFileByPath(path) ||
						(await adapter.exists(path));
					const operation = t.settings.operations[path];

					completed++;

					if (
						localFile &&
						(operation === 'modify' || operation === 'create')
					) {
						const fileMtime =
							localFile instanceof TFile
								? (
										localFile as TFile & {
											stat?: { mtime?: number };
										}
									).stat?.mtime
								: undefined;
						const localMtime =
							fileMtime !== undefined
								? fileMtime
								: ((await adapter.stat(path))?.mtime ?? 0);
						const cloudMtime = file.modifiedTime
							? new Date(file.modifiedTime).getTime()
							: 0;
						const preferCloud =
							t.settings.preferCloudWhenNewer ?? true;
						const cloudWins =
							forceCloud ||
							(preferCloud && cloudMtime > localMtime);

						if (!cloudWins) {
							if (operation === 'create') {
								t.settings.operations[path] = 'modify';
							}
							return;
						}

						if (
							(t.settings.backupOnConflict ?? true) &&
							typeof adapter.readBinary === 'function' &&
							typeof adapter.writeBinary === 'function'
						) {
							const localContent = await adapter.readBinary(path);
							const backupPath = getConflictBackupPath(path);
							await adapter.writeBinary(backupPath, localContent);
						}

						delete t.settings.operations[path];
					}

					const response =
						file.mimeType === googleDocMimeType
							? t.drive.exportFile(file.id, 'text/markdown')
							: t.drive.getFile(file.id);
					const content = await response.arrayBuffer();

					syncNotice?.setMessage(
						getSyncMessage(33, 100, completed, newNotes.length),
					);

					if (localFile instanceof TFile) {
						return t.modifyFile(
							localFile,
							content,
							file.modifiedTime,
						);
					}

					return t.upsertFile(path, content, file.modifiedTime);
				}),
			);
		};

		await upsertFiles();

		const deleteConfigs = async () => {
			const configDeletions = await Promise.all(
				changes
					.filter(isRemovedChange)
					.map(async ({ fileId }) => {
						const path = removedPaths[fileId];
						if (!path || vault.getAbstractFileByPath(path)) return;
						const stat = await adapter.stat(path);
						if (!stat) return;
						return { path, type: stat.type };
					}),
			);

			let configDeletionsFiltered = configDeletions.filter(Boolean) as {
				path: string;
				type: 'file' | 'folder';
			}[];

			const trashMethod = (
				vault as unknown as {
					getConfig: (key: 'trashOption') => 'local' | 'system';
				}
			).getConfig('trashOption');

			if (trashMethod === 'local' || trashMethod === 'system') {
				const deletionMethod =
					trashMethod === 'local'
						? adapter.trashLocal.bind(adapter)
						: adapter.trashSystem.bind(adapter);

				const folders = configDeletionsFiltered.filter(
					(file) => file.type === 'folder',
				);

				if (folders.length) {
					const maxDepth = Math.max(
						...folders.map(({ path }) => path.split('/').length),
					);

					for (let depth = 1; depth <= maxDepth; depth++) {
						const foldersToDelete = configDeletionsFiltered.filter(
							(file) =>
								file.type === 'folder' &&
								file.path.split('/').length === depth,
						);
						await Promise.all(
							foldersToDelete.map(({ path }) =>
								deletionMethod(path),
							),
						);
						foldersToDelete.forEach(
							(folder) =>
								(configDeletionsFiltered =
									configDeletionsFiltered.filter(
										({ path }) =>
											!path.startsWith(
												folder.path + '/',
											) && path !== folder.path,
									)),
						);
					}
				}

				await Promise.all(
					configDeletionsFiltered.map(({ path }) =>
						deletionMethod(path),
					),
				);
				return;
			}

			const deletedFiles = configDeletionsFiltered.filter(
				(file) => file.type === 'file',
			);
			await Promise.all(
				deletedFiles.map(({ path }) => adapter.remove(path)),
			);

			const deletedFolders = configDeletionsFiltered.filter(
				(file) => file.type === 'folder',
			);
			const batches = foldersToBatches(
				deletedFolders.map(({ path }) => path),
			);
			batches.reverse();

			for (const batch of batches) {
				await Promise.all(
					batch.map(async (folder) => {
						const list = await adapter.list(folder);
						if (list.files.length + list.folders.length) return;
						void adapter.rmdir(folder, false);
					}),
				);
			}
		};

		await deleteConfigs();

		if (silenceNotices) return true;

		const ended = await t.endSync(syncNotice);
		if (ended) new Notice('Files have been synced from Google Drive!');
		return ended;
	} catch (error) {
		t.abortSync(syncNotice);
		new Notice('Sync failed unexpectedly. Please try again.');
		console.error('Google Drive pull failed', error);
		return false;
	}
};
