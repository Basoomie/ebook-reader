/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { BookCardProps } from '$lib/components/book-card/book-card-props';
import { ApiStorageHandler } from '$lib/data/storage/handler/api-handler';
import { BaseStorageHandler, type ExternalFile } from '$lib/data/storage/handler/base-handler';
import { unlockStorageData } from '$lib/data/storage/storage-source-manager';
import { StorageKey } from '$lib/data/storage/storage-types';
import { database, selfHostStorageSource$ } from '$lib/data/store';
import pLimit from 'p-limit';

interface ServerEntry {
  name: string;
  isDirectory: boolean;
  size: number;
  lastModified: number;
}

export class SelfHostStorageHandler extends ApiStorageHandler {
  private serverUrl = '';

  private authToken = '';

  private configLoaded = false;

  private rootInitialized = false;

  constructor(window: Window) {
    super(StorageKey.SELFHOST, window, '');
  }

  setInternalSettings(storageSourceName: string) {
    const newSource = storageSourceName || selfHostStorageSource$.getValue();

    if (newSource !== this.storageSourceName) {
      this.clearData();
    }

    this.storageSourceName = newSource;
  }

  clearData(clearAll = true) {
    super.clearData(clearAll);

    if (clearAll) {
      this.configLoaded = false;
      this.rootInitialized = false;
      this.serverUrl = '';
      this.authToken = '';
    }
  }

  async getBookList(): Promise<BookCardProps[]> {
    if (!this.dataListFetched) {
      database.listLoading$.next(true);

      try {
        await this.ensureTitle();

        const rootEntries = await this.serverList('');
        const titleDirs = rootEntries.filter((e) => e.isDirectory);

        const listLimiter = pLimit(3);
        const listTasks: Promise<void>[] = [];

        titleDirs.forEach((dir) =>
          listTasks.push(
            listLimiter(async () => {
              const title = BaseStorageHandler.desanitizeFilename(dir.name);

              this.titleToId.set(title, dir.name);

              const fileEntries = await this.serverList(dir.name);
              const files: ExternalFile[] = fileEntries
                .filter((e) => !e.isDirectory)
                .map((e) => ({ id: `${dir.name}/${e.name}`, name: e.name }));

              this.titleToFiles.set(title, files);
              this.populateBookCard(title, files);
            })
          )
        );

        await Promise.all(listTasks).catch((err) => {
          listLimiter.clearQueue();
          throw err;
        });

        this.dataListFetched = true;
      } catch (error) {
        this.clearData();
        throw error;
      }
    }

    return [...this.titleToBookCard.values()];
  }

  protected async ensureTitle(
    name = BaseStorageHandler.rootName,
    _parent = '',
    readOnly = false
  ): Promise<string> {
    if (name === BaseStorageHandler.rootName) {
      if (!this.rootInitialized) {
        await this.loadConfig();
        this.rootId = '';
        this.rootInitialized = true;
      }

      return this.rootId;
    }

    const cached = this.titleToId.get(name);

    if (cached !== undefined) return cached;

    const sanitized = BaseStorageHandler.sanitizeForFilename(name);

    if (!readOnly) {
      await this.serverMkdir(sanitized);
    }

    this.titleToId.set(name, sanitized);

    return sanitized;
  }

  protected async getExternalFiles(remoteTitleId: string): Promise<ExternalFile[]> {
    if (this.cacheStorageData && this.titleToFiles.has(this.currentContext.title)) {
      return this.titleToFiles.get(this.currentContext.title)!;
    }

    const entries = await this.serverList(remoteTitleId);
    const files: ExternalFile[] = entries
      .filter((e) => !e.isDirectory)
      .map((e) => ({ id: `${remoteTitleId}/${e.name}`, name: e.name }));

    this.titleToFiles.set(this.currentContext.title, files);

    return files;
  }

  protected async setRootFiles(): Promise<void> {
    if (this.cacheStorageData && this.rootFileListFetched) return;

    const entries = await this.serverList('');

    this.rootFiles.clear();

    for (const entry of entries) {
      if (!entry.isDirectory) {
        this.setRootFile(entry.name, { id: entry.name, name: entry.name });
      }
    }

    this.rootFileListFetched = true;
  }

  protected async retrieve(
    file: ExternalFile,
    typeToRetrieve: XMLHttpRequestResponseType,
    progressBase = 1
  ): Promise<any> {
    await this.loadConfig();

    const url = `${this.serverUrl}/file?path=${encodeURIComponent(file.id)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.authToken}` } });

    if (!res.ok) {
      if (res.status === 404) {
        throw new Error('Resource not found. Refresh your current tab and try again');
      }

      throw new Error(`Failed to retrieve ${file.name}: HTTP ${res.status}`);
    }

    BaseStorageHandler.reportProgress(progressBase);

    switch (typeToRetrieve) {
      case 'blob':
        return res.blob();
      case 'json':
        return res.json();
      case 'arraybuffer':
        return res.arrayBuffer();
      default:
        return res.text();
    }
  }

  protected async upload(
    folderId: string,
    name: string,
    files: ExternalFile[],
    externalFile: ExternalFile | undefined,
    data: Blob | string | undefined,
    rootFilePrefix?: string,
    progressBase = 0.8
  ): Promise<ExternalFile> {
    await this.loadConfig();

    const filePath = folderId ? `${folderId}/${name}` : name;

    // data === undefined means rename-only (updateLastRead): re-download content then re-upload
    let body: Blob | string;

    if (data === undefined) {
      if (!externalFile || externalFile.name === name) {
        this.updateAfterUpload(filePath, name, files, externalFile, {}, rootFilePrefix);
        return { id: filePath, name };
      }

      const downloadRes = await fetch(
        `${this.serverUrl}/file?path=${encodeURIComponent(externalFile.id)}`,
        { headers: { Authorization: `Bearer ${this.authToken}` } }
      );

      if (!downloadRes.ok) {
        this.updateAfterUpload(filePath, name, files, externalFile, {}, rootFilePrefix);
        return { id: filePath, name };
      }

      body = await downloadRes.blob();
    } else {
      body = data;
    }

    // Delete old file when the new name differs (e.g. progress timestamp changed)
    if (externalFile && externalFile.name !== name) {
      await this.serverDeleteFile(externalFile.id);
    }

    const uploadUrl = `${this.serverUrl}/file?path=${encodeURIComponent(filePath)}`;
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${this.authToken}` },
      body: body instanceof Blob ? body : new Blob([body])
    });

    if (res.status === 409) {
      // Server rejected: an existing progress file already has a newer timestamp
      return externalFile || { id: filePath, name };
    }

    if (!res.ok) {
      throw new Error(`Upload failed for ${filePath}: HTTP ${res.status}`);
    }

    BaseStorageHandler.reportProgress(progressBase);

    this.updateAfterUpload(filePath, name, files, externalFile, {}, rootFilePrefix);

    return { id: filePath, name };
  }

  protected async executeDelete(id: string): Promise<void> {
    await this.loadConfig();

    const url = `${this.serverUrl}/rmdir?path=${encodeURIComponent(id)}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.authToken}` }
    });

    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed to delete folder ${id}: HTTP ${res.status}`);
    }
  }

  private async loadConfig(): Promise<void> {
    if (this.configLoaded) return;

    const db = await database.db;
    const storageSource = await db.get('storageSource', this.storageSourceName);

    if (!storageSource) {
      throw new Error(`Self-hosted storage source "${this.storageSourceName}" not configured`);
    }

    const unlockResult = await unlockStorageData(
      storageSource,
      'Authentication required for self-hosted storage',
      this.askForStorageUnlock
        ? {
            action: `Enter the password for ${this.storageSourceName}`,
            encryptedData: storageSource.data,
            forwardSecret: true
          }
        : undefined
    );

    if (!unlockResult) {
      throw new Error('Unable to load self-hosted storage configuration');
    }

    this.serverUrl = unlockResult.clientId.replace(/\/+$/, '');
    this.authToken = unlockResult.clientSecret;
    this.configLoaded = true;
  }

  private async serverList(dirPath: string): Promise<ServerEntry[]> {
    await this.loadConfig();

    const url = `${this.serverUrl}/list?path=${encodeURIComponent(dirPath)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.authToken}` } });

    if (!res.ok) {
      if (res.status === 401) {
        throw new Error('Invalid auth token for self-hosted storage');
      }

      return [];
    }

    return res.json();
  }

  private async serverMkdir(dirPath: string): Promise<void> {
    await this.loadConfig();

    const url = `${this.serverUrl}/mkdir?path=${encodeURIComponent(dirPath)}`;
    await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.authToken}` }
    });
  }

  private async serverDeleteFile(filePath: string): Promise<void> {
    await this.loadConfig();

    const url = `${this.serverUrl}/file?path=${encodeURIComponent(filePath)}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.authToken}` }
    });

    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed to delete file ${filePath}: HTTP ${res.status}`);
    }
  }

  private populateBookCard(title: string, files: ExternalFile[]) {
    if (!files.length) return;

    const bookCard: BookCardProps = {
      id: BaseStorageHandler.getDummyId(),
      title,
      imagePath: '',
      characters: 0,
      lastBookModified: 0,
      lastBookOpen: 0,
      progress: 0,
      lastBookmarkModified: 0,
      isPlaceholder: false
    };

    for (const file of files) {
      if (file.name.startsWith('bookdata_')) {
        const { characters, lastBookModified, lastBookOpen } =
          BaseStorageHandler.getBookMetadata(file.name);

        bookCard.characters = characters;
        bookCard.lastBookModified = lastBookModified;
        bookCard.lastBookOpen = lastBookOpen;
      } else if (file.name.startsWith('progress_')) {
        const { progress, lastBookmarkModified } = BaseStorageHandler.getProgressMetadata(
          file.name
        );

        bookCard.progress = progress;
        bookCard.lastBookmarkModified = lastBookmarkModified;
      }
    }

    this.titleToBookCard.set(title, bookCard);
  }
}
