import type { NextConfig } from "next";

/** Treasury became Jars and Disputes moved under Money; old links, bookmarks and notifications still land. */
const nextConfig: NextConfig = {
  async redirects() {
    return [
      { source: "/treasury/setup", destination: "/money/jars/accounts", permanent: true },
      { source: "/treasury/policies", destination: "/money/jars/rules", permanent: true },
      { source: "/treasury/policy", destination: "/money/jars/rule", permanent: true },
      { source: "/treasury/:path*", destination: "/money/jars/:path*", permanent: true },
      { source: "/disputes/:path*", destination: "/money/disputes/:path*", permanent: true },
    ];
  },
};

export default nextConfig;
