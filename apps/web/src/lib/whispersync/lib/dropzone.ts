// vendored from ttu-whispersync — MIT License — https://github.com/Renji-XD/ttu-whispersync

export type FileExtension = `.${string}`;

export type EventWithElement<T> = Event & { currentTarget: T };

export interface FileInstance extends File {
	parentFolder: string;
	filePath: string;
}

export interface FileEntry {
	file: FileInstance;
	extension: string;
	handle?: FileSystemFileHandle;
}

export interface FileResult {
	files: FileEntry[];
	errors: string[];
}
