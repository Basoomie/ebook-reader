// vendored from ttu-whispersync — MIT License — https://github.com/Renji-XD/ttu-whispersync
import { SvelteComponentTyped } from 'svelte';

export default class DialogTemplate extends SvelteComponentTyped<
	Record<string, never>,
	{ close: CustomEvent<void> },
	{ header: {}; content: {}; footer: {} }
> {}
