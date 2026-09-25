import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      /*
        Poppins como tipografia por defecto de TODO.
        Con esto no alcanza solo la regla de globals.css: Tailwind define su
        propia familia en la base, y los campos de texto y los botones no
        heredan la fuente salvo que se la declare explicitamente aca.
        Las de atras son el respaldo por si Poppins no llega a bajar.
      */
      fontFamily: {
        sans: [
          "Poppins",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
      },
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
