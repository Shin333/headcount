import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
        sans: ["-apple-system", "BlinkMacSystemFont", "Inter", "sans-serif"],
      },
      colors: {
        ink: {
          50: "#f6f6f5",
          100: "#e7e7e4",
          200: "#cfcfc8",
          400: "#8a8a82",
          600: "#4a4a44",
          800: "#1f1f1c",
          900: "#0e0e0c",
        },
      },
    },
  },
  plugins: [],
};

export default config;
