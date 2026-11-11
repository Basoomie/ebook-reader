/* eslint-disable global-require */
const plugin = require('tailwindcss/plugin');

const config = {
  content: ['./src/**/*.{html,js,svelte,ts}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Noto Sans JP', 'sans-serif'],
        serif: ['Noto Serif JP', 'serif'],
        // WP19b: headings and book titles of the catalogue pages.
        mincho: ['Shippori Mincho', 'Noto Serif JP', 'serif']
      },
      colors: {
        'background-color': 'var(--background-color)',
        // WP19b: the catalogue pages' tokens (app.scss: light, html.catalogue-dark, html.eink).
        c: {
          bg: 'var(--c-bg)',
          raised: 'var(--c-raised)',
          ink: 'var(--c-ink)',
          muted: 'var(--c-muted)',
          line: 'var(--c-line)',
          strong: 'var(--c-line-strong)',
          link: 'var(--c-link)',
          label: 'var(--c-label)',
          seal: 'var(--c-seal)',
          gold: 'var(--c-gold)',
          header: 'var(--c-header-bg)',
          'header-ink': 'var(--c-header-ink)',
          'header-muted': 'var(--c-header-muted)',
          track: 'var(--c-track)',
          fill: 'var(--c-fill)',
          tint: 'var(--c-tint)',
          sel: 'var(--c-sel-bg)',
          'sel-ink': 'var(--c-sel-ink)'
        }
      },
      spacing: {
        21: '5.25rem'
      },
      maxWidth: {
        '60vw': '60vw'
      }
    }
  },
  plugins: [
    require('@tailwindcss/aspect-ratio'),
    require('@tailwindcss/forms'),
    plugin(({ addUtilities }) => {
      addUtilities(require('./tailwindcss/material-elevation.cjs'));
    })
  ],
  safelist: [
    {
      pattern: /grid-cols-(2|3)/,
      variants: ['md']
    },
    'animate-[pulse_0.5s_cubic-bezier(0.4,0,0.6,1)_1]',
    'animate-[pulse_1s_cubic-bezier(0.4,0,0.6,1)_infinite]'
  ]
};

module.exports = config;
