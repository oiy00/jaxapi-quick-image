import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || "",
  experimental: {
    // Default clone limit is 10MB. Two real reference photos exceed that and the
    // truncated multipart never reaches a clean 413.
    middlewareClientMaxBodySize: "64mb",
  },
};

export default nextConfig;
