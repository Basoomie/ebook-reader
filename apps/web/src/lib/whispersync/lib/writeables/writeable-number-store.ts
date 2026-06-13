// vendored from ttu-whispersync — MIT License — https://github.com/Renji-XD/ttu-whispersync
import { createWriteableStore } from './writeable-store';

export function writableNumberStore() {
	return createWriteableStore<number>(
		(x) => +x,
		(x) => `${x}`,
	);
}
