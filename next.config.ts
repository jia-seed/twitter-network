import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Twitter profile pictures come from pbs.twimg.com. Allow the next/image
  // domain even though we're using <img> for now — flips on cheaply later.
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'pbs.twimg.com' },
      { protocol: 'https', hostname: 'abs.twimg.com' },
    ],
  },
}

export default nextConfig
