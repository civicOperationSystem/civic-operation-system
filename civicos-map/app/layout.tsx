import type { Metadata } from 'next';
import './globals.css';
import 'maplibre-gl/dist/maplibre-gl.css';
export const metadata: Metadata = { title: 'CivicOS Community Map', description: 'Authorized service requests, facilities and infrastructure.' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
