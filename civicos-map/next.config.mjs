export default {
  async rewrites() {
    return [{
      source: '/api/civic/:path*',
      destination: `${process.env.CIVIC_API_URL || 'http://localhost:3030'}/api/civic/:path*`,
    }];
  },
  async headers() {
    return [{
      source: '/:path*',
      headers: [{
        key: 'Content-Security-Policy',
        value: "connect-src 'self' https://tiles.openfreemap.org; worker-src 'self'",
      }],
    }];
  },
};
