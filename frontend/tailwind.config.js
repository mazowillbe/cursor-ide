/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          800: "#1e1e1e",
          700: "#252526",
          600: "#2d2d30",
          500: "#3c3c3c",
        },
        accent: "#0078d4",
      },
    },
  },
  plugins: [],
};
