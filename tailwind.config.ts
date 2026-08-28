import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0f1720",
        muted: "#6b7684",
        line: "#e4e7ec",
        up: "#c0392b",
        down: "#1e8e5a",
        meli: "#ffe600",
      },
    },
  },
  plugins: [],
};

export default config;
