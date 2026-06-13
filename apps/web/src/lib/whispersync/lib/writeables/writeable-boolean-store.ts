// vendored from ttu-whispersync — MIT License — https://github.com/Renji-XD/ttu-whispersync
import { createWriteableStore } from './writeable-store';

export function writableBooleanStore() {
	return createWriteableStore(
		(x) => !!+x,
		(x) => (x ? '1' : '0'),
	);
}
