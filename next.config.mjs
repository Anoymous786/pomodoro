/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emit .next/standalone (self-contained server.js) for the Docker image —
  // the Dockerfile copies this tree into the final runner stage.
  output: "standalone",
};

export default nextConfig;