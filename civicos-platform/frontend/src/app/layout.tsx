import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'CivicOS — Your community, connected',
  description: 'Public services, staff operations and field work on one permission-aware platform.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}
