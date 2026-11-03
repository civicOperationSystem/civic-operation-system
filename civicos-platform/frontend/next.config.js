/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [{ source: '/field-sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache' }] }];
  },
  async rewrites() {
    return [
      { source: '/api/civic/:path*', destination: `${process.env.CIVIC_API_URL || 'http://localhost:3030'}/api/civic/:path*` },
    ];
  },
};

module.exports = nextConfig;
