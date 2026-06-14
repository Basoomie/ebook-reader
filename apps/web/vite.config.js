import dns from 'dns';
import { sveltekit } from '@sveltejs/kit/vite';

const nodeVersion = Number.parseInt(process.versions.node.match(/^(\d+)\./)?.[1] || '17', 10);

if (nodeVersion < 17) {
  dns.setDefaultResultOrder('verbatim');
}

/** @type {import('vite').UserConfig} */
const config = {
  plugins: [sveltekit()],
  ssr: {
    // https://github.com/FortAwesome/Font-Awesome/issues/18677
    noExternal: ['@fortawesome/*', '@popperjs/*', 'sortablejs']
  },
  experimental: {
    prebundleSvelteLibraries: true
  },
  // Allow Vite to serve WASM files as URL assets (used by mediainfo.js and @ffmpeg/core)
  assetsInclude: ['**/*.wasm']
};

export default config;
