export default {
  distDir: process.env.NEXT_DIST_DIR || '.next',
  async rewrites() {
    return [{
      source: '/api/civic/:path*',
      destination: `${process.env.CIVIC_API_URL || 'http://localhost:3030'}/api/civic/:path*`,
    }];
  },
};
