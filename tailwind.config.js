/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'sans-serif'] },
      colors: {
        emerald: {
          50:  '#ecfdf5',
          500: '#10b981',
          600: '#059669',
        },
        purple: { 500: '#8b5cf6' },
      },
      keyframes: {
        'glow-green': {
          '0%':   { boxShadow: '0 0 0 0 rgba(16,185,129,0.55)', backgroundColor: 'rgba(16,185,129,0.08)' },
          '60%':  { boxShadow: '0 0 0 6px rgba(16,185,129,0)',  backgroundColor: 'rgba(16,185,129,0.04)' },
          '100%': { boxShadow: '0 0 0 0 rgba(16,185,129,0)',    backgroundColor: 'transparent' },
        },
      },
      animation: {
        'glow-green': 'glow-green 0.8s ease-out forwards',
      },
    },
  },
  plugins: [],
}
