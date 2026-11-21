// vendored from ttu-whispersync — MIT License — https://github.com/Renji-XD/ttu-whispersync
// 2026-11-21: the frame is the app's modal; `size` and `dirty` pass through to it.
import { SvelteComponentTyped } from 'svelte';

export default class DialogTemplate extends SvelteComponentTyped<
	{ size?: 'sm' | 'md' | 'lg' | 'xl'; dirty?: boolean },
	{ close: CustomEvent<void> },
	{
		header: Record<string, never>;
		content: Record<string, never>;
		footer: Record<string, never>;
		default: Record<string, never>;
	}
> {}
