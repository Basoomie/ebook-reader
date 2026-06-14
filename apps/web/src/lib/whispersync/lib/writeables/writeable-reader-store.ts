// Bridges whispersync settings to the reader's store infrastructure.
// Uses writableStorageSubject (RxJS BehaviorSubject) instead of raw window.localStorage.
import { writableStorageSubject } from '$lib/data/internal/writable-storage-subject';
import { localStorage } from '$lib/data/window/local-storage';
import type { Subscriber, Invalidator } from 'svelte/store';
import { getDefaultSetting, type Settings } from '../settings';

function createReaderStore<T>(
	mapFromString: (s: string) => T,
	mapToString: (t: T) => string,
) {
	return (storageKey: string, forcedDefault?: T) => {
		const defaultValue = forcedDefault ?? (getDefaultSetting(storageKey as keyof Settings) as T);
		const subject = writableStorageSubject(localStorage, mapFromString, mapToString)(
			storageKey,
			defaultValue,
		);
		return {
			subscribe: (run: Subscriber<T>, _invalidate?: Invalidator<T>) => {
				const sub = subject.subscribe(run);
				return () => sub.unsubscribe();
			},
			set: (value: T) => subject.next(value),
			get: () => subject.getValue() as T,
			key: () => storageKey as keyof Settings,
			reset: () => {
				subject.next(defaultValue);
				return defaultValue;
			},
		};
	};
}

export function writableBooleanStore() {
	return createReaderStore<boolean>(
		(x) => !!+x,
		(x) => (x ? '1' : '0'),
	);
}

export function writableNumberStore() {
	return createReaderStore<number>(
		(x) => +x,
		(x) => `${x}`,
	);
}

export function writableStringStore<T extends string>() {
	return createReaderStore<T>(
		(x) => x as T,
		(x) => x,
	);
}

export function writeableArrayStore<T>() {
	return createReaderStore<T[]>(
		(x) => JSON.parse(x || '[]') as T[],
		(x) => JSON.stringify(x),
	);
}
