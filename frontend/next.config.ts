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

  // The other half of that problem, and the one that only shows up on a
  // serverless host. serverExternalPackages keeps these three out of the
  // bundle so their runtime path resolution still works — but it does not
  // make them get *shipped*. Next decides which files a function needs by
  // following require() graphs, and all three reach their real payload by a
  // computed path rather than a require: ffmpeg-static exports a path string
  // to a binary its postinstall downloaded, @napi-rs/canvas selects a
  // per-platform package at runtime, and pdfjs-dist reads font/cmap data off
  // disk relative to its own package root. Untraced, those files are simply
  // absent from the deployed function — the build still succeeds, and the
  // route fails in production with a spawn ENOENT or a missing-font error.
  // Naming them here is what puts the bytes in the deployment.
  //
  // Only the thumbnail route imports any of this, so only that function pays
  // the weight (~130 MB on Linux, against Vercel's 250 MB uncompressed
  // serverless limit — the Linux ffmpeg build is ~78 MB, far larger than the
  // 18 MB Windows one, so measure on Linux, never locally).
  //
  // The key is a picomatch glob matched against the route path, NOT a literal
  // string — so the brackets of a dynamic segment have to be escaped. Written
  // unescaped, "[id]" parses as a character class matching a single "i" or
  // "d", the key matches nothing, and the includes are silently dropped with
  // no build error. (This escaping is what Next's own output.md example does.)
  outputFileTracingIncludes: {
    "/api/resources/\\[id\\]/thumbnail": [
      "./node_modules/ffmpeg-static/**",
      // The Skia binary and its ICU data live in a per-platform package
      // (…-linux-x64-gnu on Vercel, …-win32-x64-msvc here), never in the
      // parent package, which is only a 152 KB loader shim.
      "./node_modules/@napi-rs/canvas-*/**",
      // The route imports pdfjs-dist/legacy/build/pdf.mjs; the rest are data
      // directories it reads at render time. Deliberately not the whole
      // package — that would add ~19 MB of viewer/types/image_decoders that
      // no server-side render path touches.
      "./node_modules/pdfjs-dist/legacy/build/**",
      "./node_modules/pdfjs-dist/standard_fonts/**",
      "./node_modules/pdfjs-dist/cmaps/**",
      "./node_modules/pdfjs-dist/iccs/**",
      "./node_modules/pdfjs-dist/wasm/**",
    ],
  },
};

export default nextConfig;
