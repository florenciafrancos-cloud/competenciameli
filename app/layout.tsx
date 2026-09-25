import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Monitor de competencia — Mercado Libre",
  description:
    "Seguimiento diario de precios y cambios de la competencia en Mercado Libre",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es-AR">
      <head>
        {/* Poppins, desde Google Fonts. Si algun dia no carga, la app usa
            la tipografia de respaldo que esta en globals.css. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin=""
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
