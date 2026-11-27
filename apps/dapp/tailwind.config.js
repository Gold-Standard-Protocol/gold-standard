const { createGlobPatternsForDependencies } = require('@nx/react/tailwind');
const { join } = require('path');
const radixPlugin = require('tailwindcss-radix');
const animatePlugin = require('tailwindcss-animate');
const { extendedTheme } = require('../../libs/ui/src/lib/extended-theme');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    join(
      __dirname,
      '{src,pages,components,app}/**/*!(*.stories|*.spec).{ts,tsx,html}'
    ),
    ...createGlobPatternsForDependencies(__dirname),
  ],
  darkMode: 'class',
  theme: {
    container: {
      center: true,
      padding: {
        DEFAULT: '1rem',
        sm: '1.5rem',
        lg: '2rem',
      },
      screens: {
        '2xl': '1200px',
      },
    },
    extend: extendedTheme,
  },
  plugins: [animatePlugin, radixPlugin],
};
