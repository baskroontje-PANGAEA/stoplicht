/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    // Tesseract.js en andere packages hebben geen Node.js fs/path nodig in de browser
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      path: false,
      stream: false,
    };
    return config;
  },
};

export default nextConfig;
