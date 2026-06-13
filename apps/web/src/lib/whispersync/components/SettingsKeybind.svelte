<script lang="ts">
	// vendored from ttu-whispersync — MIT License — https://github.com/Renji-XD/ttu-whispersync
	export let key: string;
	export let description: string;
	export let extendDescription = true;
</script>

<div>{key}</div>
<div>{description}{extendDescription ? ' for active subtitle' : ''}</div>
<div />
