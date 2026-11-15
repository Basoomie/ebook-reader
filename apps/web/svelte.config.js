import adapter from '@sveltejs/adapter-static';
import preprocess from 'svelte-preprocess';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  compilerOptions: {
    immutable: true
  },

  // Consult https://github.com/sveltejs/svelte-preprocess
  // for more information about preprocessors
  preprocess: [
    preprocess({
      postcss: true
    })
  ],

  kit: {
    adapter: adapter({
      fallback: '404.html'
    }),
    // Registered by the app itself (lib/app-update), which watches for a waiting
    // version and shows "New version available". Same script and scope as before.
    serviceWorker: {
      register: false
    }
  }
};

export default config;
