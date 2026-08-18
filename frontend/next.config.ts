import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // ffmpeg-static exports a resolved path to its bundled binary; letting
  // Next/webpack trace and bundle that module rewrites the path to a
  // mangled build-output location where the binary doesn't exist. Keeping
  // it external means the import is resolved at runtime via normal
  // node_modules require() instead. pdfjs-dist (loads standard-fonts data
  // from disk at a path relative to its own package) and @napi-rs/canvas
  // (a native, prebuilt-per-platform binary, same class of module as
  // ffmpeg-static) hit the identical bug if bundled, so they're external too.
  serverExternalPackages: ["ffmpeg-static", "pdfjs-dist", "@napi-rs/canvas"],
};

export default nextConfig;
