<script lang="ts">
	// vendored from ttu-whispersync — MIT License — https://github.com/Renji-XD/ttu-whispersync
	export let path: string;
	export let width = '1.4rem';
	export let height = '1.4rem';
	export let element: SVGElement | undefined = undefined;
	export let iconStyles = '';
	export { _class as class };

	let _class = '';
</script>

<svg
	tabindex="0"
	role="button"
	style="width: {width}; height: {height};{iconStyles}"
	viewBox="0 0 24 24"
	fill="currentColor"
	class={`icon ${_class}`}
	bind:this={element}
	on:click
	on:keyup
>
	<path d={path} />
</svg>
