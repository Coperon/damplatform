import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { canAccessAllTenants } from '@/lib/session';
import { getObject, putObject } from '@/lib/storage';
import { tenantHasResourceAccess, requirePermission } from '@/lib/permissions';

// The heaviest route in the app, and the only one that spawns a subprocess.
// A single request can pull a whole video out of object storage into memory,
// write it to a temp file, run FFmpeg over it, and upload the frame back —
// comfortably past any serverless platform's default timeout, which is
// typically 10-15s. 300 is Vercel's Pro ceiling for a standard serverless
// function; a Hobby deployment caps at 60 and will reject this at deploy
// time, which is the intended signal, since Hobby is non-commercial anyway.
// Self-hosted behind IIS this export is inert — ARR's own 30s response
// timeout governs there instead and has to be raised separately.
//
// Note this is a ceiling, not a budget: the FFmpeg and PDF render steps below
// keep their own tighter internal timeouts, so a hung subprocess still fails
// fast rather than holding the function open for the full 300s.
export const maxDuration = 300;

const FFMPEG_TIMEOUT_MS = 20_000;
const THUMBNAIL_WIDTH = 320;
const SEEK_SECONDS = 1;
const PDF_RENDER_TIMEOUT_MS = 20_000;
// PDF pages are mostly text — 320px (the video frame width) renders as an
// illegible smudge. 800px keeps headings/body text legible while staying a
// reasonable thumbnail size; quality 80 (up from the video path's default)
// keeps JPEG artifacts off of sharp text edges.
const PDF_THUMBNAIL_WIDTH = 800;
// Same 0-100 integer scale as IMAGE_JPEG_QUALITY below (see Stage 83) — this
// constant carried the identical 0-1-fraction bug (0.8, effectively quality
// ~0) until then; it went unnoticed because a white-page/black-text PDF
// doesn't visibly break at near-zero JPEG quality the way a photo does.
const PDF_JPEG_QUALITY = 80;
// Images are the primary visual on every card — bigger than the video frame
// (320), smaller than a PDF page (800, where legible text needs the room).
const IMAGE_THUMBNAIL_LONG_EDGE = 640;
// @napi-rs/canvas's toBuffer('image/jpeg', quality) takes an integer 0-100
// (its default with no quality arg is 92) — NOT the 0-1 fraction browser
// canvas APIs use. Passing 0.8 here truncates to an effectively-0 encoder
// quality: same tiny handful of giant blocks regardless of whether 0, 0.1,
// 0.8, or 1 is passed (confirmed empirically — all four produced
// byte-identical output size), which is exactly the blocky/desaturated
// corruption this constant caused. 80 is the correct equivalent.
const IMAGE_JPEG_QUALITY = 80;
// The same 4 raster types this app already treats as "a real image" elsewhere
// (see upload/from-url's ALLOWED_CONTENT_TYPES) — deliberately excludes
// image/svg+xml (XML, can carry scripts; same reasoning as from-url) even
// though @napi-rs/canvas can technically rasterize simple SVGs, and anything
// this canvas build can't decode (image/heic, etc.), which fails cleanly via
// the try/catch below rather than being pre-enumerated here.
const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * ffmpeg-static's default export is a path already resolved at install
 * time. With `serverExternalPackages: ['ffmpeg-static']` (next.config.ts)
 * that path is used as-is and is correct. This existsSync check is a second
 * line of defense in case bundling ever rewrites it again (it previously
 * came out as a mangled `\ROOT\node_modules\...` path that doesn't exist on
 * disk) — falls back to resolving the binary from cwd's node_modules.
 */
function resolveFfmpegPath(): string {
  if (ffmpegPath && fsSync.existsSync(ffmpegPath)) {
    return ffmpegPath;
  }
  const basename = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  // turbopackIgnore: this is a rarely-hit fallback (normal path is the
  // existsSync branch above); without the ignore comment, Turbopack treats
  // this dynamic path.join(process.cwd(), ...) as a signal to trace the
  // entire project into the server bundle.
  return path.join(/* turbopackIgnore: true */ process.cwd(), 'node_modules', 'ffmpeg-static', basename);
}

/**
 * Runs the bundled ffmpeg-static binary with a fixed argument array — never
 * a shell string — so nothing here is ever subject to shell interpretation.
 * The only external input reaching ffmpeg is the temp file paths we created
 * ourselves (not user-controlled) and the video bytes already downloaded
 * from MinIO.
 */
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const resolvedFfmpegPath = resolveFfmpegPath();
    if (!fsSync.existsSync(resolvedFfmpegPath)) {
      console.error(`ffmpeg binary not found at ${resolvedFfmpegPath}`);
      reject(new Error('ffmpeg binary not available'));
      return;
    }

    const child = spawn(resolvedFfmpegPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, FFMPEG_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error('ffmpeg timed out'));
        return;
      }
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
        return;
      }
      resolve();
    });
  });
}

async function extractFrame(inputPath: string, outputPath: string, seekSeconds: number): Promise<void> {
  const args = [
    '-y',
    ...(seekSeconds > 0 ? ['-ss', String(seekSeconds)] : []),
    '-i', inputPath,
    '-frames:v', '1',
    '-vf', `scale=${THUMBNAIL_WIDTH}:-2`,
    '-f', 'image2',
    outputPath,
  ];
  await runFfmpeg(args);
}

/**
 * pdfjs-dist's Node path loads its bundled standard-fonts data (used to
 * render PDFs that reference a base-14 font like Times/Helvetica without
 * embedding a font program — extremely common) via a direct filesystem
 * read, not a URL fetch. That means the value must be a real absolute path
 * with a trailing forward slash: pdfjs's own factory-url check rejects a
 * Windows backslash-terminated path, and a `file://` string is read
 * literally (not parsed as a URL) so it fails to resolve. process.cwd() is
 * the project root under `next dev`/`next start`, matching the same
 * assumption the ffmpeg path fallback above already relies on.
 */
function standardFontDataUrl(): string {
  return (
    path
      .join(process.cwd(), 'node_modules', 'pdfjs-dist', 'standard_fonts')
      .split(path.sep)
      .join('/') + '/'
  );
}

/**
 * Renders page 1 of a PDF to a JPEG buffer at ~800px wide, natural aspect
 * ratio (portrait pages stay portrait — unlike the video path, this is not
 * squeezed to a 4:3/16:9 box here; that cropping happens only in the
 * frontend's display box). Runs entirely in memory — no temp files needed,
 * since @napi-rs/canvas (auto-detected and required by pdfjs-dist's Node
 * build) renders directly from the parsed document to an in-process canvas.
 */
async function renderPdfFirstPage(pdfBuffer: Buffer): Promise<Buffer> {
  const loadingTask = getDocument({
    data: new Uint8Array(pdfBuffer),
    standardFontDataUrl: standardFontDataUrl(),
    verbosity: 0,
  });

  try {
    const pdf = await loadingTask.promise;
    const page = await pdf.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = PDF_THUMBNAIL_WIDTH / baseViewport.width;
    const viewport = page.getViewport({ scale });

    const canvas = createCanvas(Math.max(1, Math.round(viewport.width)), Math.max(1, Math.round(viewport.height)));

    // PDF pages are transparent where blank — filling opaque white first
    // avoids JPEG (no alpha channel) turning that into a muddy/black backdrop.
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // @napi-rs/canvas's Canvas duck-types as pdf.js's expected canvas (it calls
    // canvas.getContext('2d') internally) but isn't a real DOM HTMLCanvasElement,
    // so the type param needs a cast — verified working at runtime. It draws on
    // top of the white fill above rather than clearing the canvas first.
    await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise;

    return canvas.toBuffer('image/jpeg', PDF_JPEG_QUALITY);
  } finally {
    await loadingTask.destroy();
  }
}

/**
 * Renders a downscaled JPEG from an arbitrary supported image buffer, never
 * upscaling — if the source's long edge is already at or below
 * IMAGE_THUMBNAIL_LONG_EDGE, it's re-encoded at its native size (normalizing
 * the fetch path to always be `/api/cover?key=` matters more than saving a
 * few KB on an already-small file).
 *
 * Deliberately does **not** read or apply the image's EXIF orientation tag
 * itself, even though `exifr` is available in this codebase (lib/exif.ts) —
 * `@napi-rs/canvas`'s `loadImage()` already auto-rotates according to EXIF
 * orientation internally (confirmed empirically: `image.width`/`.height` and
 * the decoded pixels both come back in the display-corrected orientation for
 * every one of the 8 EXIF orientation values, tested against both a
 * synthetic marker image and real-world camera-orientation test photos).
 * Adding a second manual rotation on top would double-rotate the output —
 * this was hit and fixed during development. If a future canvas upgrade or
 * decode path ever changes this, that's a regression to catch via the same
 * empirical test (render a real Orientation=6/8 photo and confirm the
 * thumbnail is upright), not a reason to reach for manual rotation by default.
 */
async function renderImageThumbnail(imageBuffer: Buffer): Promise<Buffer> {
  const image = await loadImage(imageBuffer);

  const longEdge = Math.max(image.width, image.height);
  const scale = Math.min(1, IMAGE_THUMBNAIL_LONG_EDGE / longEdge);
  const drawWidth = Math.max(1, Math.round(image.width * scale));
  const drawHeight = Math.max(1, Math.round(image.height * scale));

  const canvas = createCanvas(drawWidth, drawHeight);
  const ctx = canvas.getContext('2d');

  // Source may have transparency (PNG/GIF/WEBP); JPEG has no alpha channel,
  // so an unfilled canvas would composite transparent regions onto black.
  // Same reasoning as the PDF path's white fill above.
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, drawWidth, drawHeight);
  ctx.drawImage(image, 0, 0, drawWidth, drawHeight);

  return canvas.toBuffer('image/jpeg', IMAGE_JPEG_QUALITY);
}

/**
 * Best-effort timeout for the PDF render: pdf.js has no real worker in
 * Node (disabled automatically, see pdfjs-dist internals) so everything
 * runs on this same thread — unlike ffmpeg's child process, a genuinely
 * stuck synchronous parse can't be forcibly killed. This guard still covers
 * the realistic case (a render that never resolves because of an async
 * wait), matching the "pathological PDF can't hang the request" goal.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  // Stage 108: was requireAdmin — now the per-tenant 'regenerate_thumbnail'
  // permission (default OFF for editors, always true for admin tiers).
  const admin = await requirePermission(req, 'regenerate_thumbnail');
  if (admin instanceof Response) return admin;

  const { id } = await ctx.params;
  const { searchParams } = new URL(req.url);
  const force = searchParams.get('force') === 'true';

  const lookup = await db.query<{
    storage_key: string;
    mime_type: string;
    thumbnail_storage_key: string | null;
  }>(
    'SELECT storage_key, mime_type, thumbnail_storage_key FROM resources WHERE id = $1',
    [id],
  );
  if (lookup.rows.length === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Tenant-scoped enforcement: a tenant admin may (re)generate a thumbnail
  // only for an asset their tenant can reach — cross-tenant users bypass this.
  if (!canAccessAllTenants(admin)) {
    if (!admin.tenantId || !(await tenantHasResourceAccess(admin.tenantId, id))) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }
  }

  const resource = lookup.rows[0];

  const isVideo = !!resource.mime_type && resource.mime_type.startsWith('video/');
  const isPdf = resource.mime_type === 'application/pdf';
  const isImage = !!resource.mime_type && SUPPORTED_IMAGE_MIME_TYPES.has(resource.mime_type);

  if (!isVideo && !isPdf && !isImage) {
    return NextResponse.json({ error: 'not a video, PDF, or supported image type' }, { status: 400 });
  }

  // Already has a thumbnail — return it as-is rather than regenerating.
  // (Chosen over always-regenerate: generation is a real cost — a MinIO
  // download plus an ffmpeg spawn — and resources are effectively
  // immutable once uploaded, so a stored thumbnail never goes stale.)
  // `force=true` bypasses this for stale thumbnails (e.g. re-rendered at a
  // higher resolution after a pipeline change) — the key below is
  // deterministic per resource (`thumbnails/<id>.jpg`), so regeneration
  // overwrites the same object in place; the old bytes stay servable right
  // up until putObject durably replaces them, and no other row (covers
  // included) references a key that changes as a result.
  if (resource.thumbnail_storage_key && !force) {
    return NextResponse.json({ thumbnailStorageKey: resource.thumbnail_storage_key });
  }

  const inputPath = path.join(os.tmpdir(), `dam-thumb-in-${randomUUID()}`);
  const outputPath = path.join(os.tmpdir(), `dam-thumb-out-${randomUUID()}.jpg`);

  try {
    let thumbnailBuffer: Buffer;

    if (isVideo) {
      let videoBuffer: Buffer;
      try {
        videoBuffer = await getObject(resource.storage_key);
      } catch (err) {
        console.error('thumbnail: could not fetch video from storage', err);
        return NextResponse.json({ error: 'could not generate thumbnail' }, { status: 422 });
      }

      await fs.writeFile(inputPath, videoBuffer);

      try {
        await extractFrame(inputPath, outputPath, SEEK_SECONDS);
      } catch {
        // Most likely the video is shorter than SEEK_SECONDS — fall back to
        // the very first frame instead of failing outright.
        await extractFrame(inputPath, outputPath, 0);
      }

      thumbnailBuffer = await fs.readFile(outputPath);
      if (thumbnailBuffer.length === 0) {
        throw new Error('ffmpeg produced an empty thumbnail file');
      }
    } else if (isPdf) {
      // PDF path — page 1 only, rendered entirely in memory (no temp files).
      let pdfBuffer: Buffer;
      try {
        pdfBuffer = await getObject(resource.storage_key);
      } catch (err) {
        console.error('thumbnail: could not fetch PDF from storage', err);
        return NextResponse.json({ error: 'could not generate thumbnail' }, { status: 422 });
      }

      thumbnailBuffer = await withTimeout(
        renderPdfFirstPage(pdfBuffer),
        PDF_RENDER_TIMEOUT_MS,
        'PDF render timed out',
      );
      if (thumbnailBuffer.length === 0) {
        throw new Error('PDF renderer produced an empty thumbnail file');
      }
    } else {
      // Image path — same in-memory pattern as PDF, no temp files needed.
      let sourceImageBuffer: Buffer;
      try {
        sourceImageBuffer = await getObject(resource.storage_key);
      } catch (err) {
        console.error('thumbnail: could not fetch image from storage', err);
        return NextResponse.json({ error: 'could not generate thumbnail' }, { status: 422 });
      }

      // loadImage() rejects a format it can't decode (e.g. a corrupt file, or
      // an unsupported one that slipped past SUPPORTED_IMAGE_MIME_TYPES via a
      // mismatched declared content-type) by throwing — caught by the outer
      // try/catch below, same clean 422 as every other failure mode here.
      thumbnailBuffer = await renderImageThumbnail(sourceImageBuffer);
      if (thumbnailBuffer.length === 0) {
        throw new Error('image renderer produced an empty thumbnail file');
      }
    }

    const thumbnailKey = `thumbnails/${id}.jpg`;
    await putObject(thumbnailKey, thumbnailBuffer, 'image/jpeg');

    await db.query(
      'UPDATE resources SET thumbnail_storage_key = $1 WHERE id = $2',
      [thumbnailKey, id],
    );

    // Second-chance auto-cover: a collection made up only of videos/PDFs has no
    // image at upload time, so it couldn't get a cover then — now that this
    // resource has a thumbnail, give any of its still-coverless collections one.
    // Same conditional-WHERE guard as the upload path: never clobbers a cover
    // that's already set (manually or automatically).
    await db.query(
      `UPDATE collections
         SET cover_storage_key = $1
        FROM collection_resource cr
       WHERE collections.id = cr.collection_id
         AND cr.resource_id = $2
         AND collections.cover_storage_key IS NULL`,
      [thumbnailKey, id],
    );

    // Second-chance ancestor propagation: a container collection (one holding
    // only sub-collections, no direct files) never shows up in the direct-
    // membership update above, so give the same thumbnail to any still-
    // coverless ancestor of every collection this resource directly belongs
    // to. One recursive CTE (walking up from all of the resource's direct
    // memberships at once, not one collection at a time) + one guarded
    // UPDATE — not a loop of round-trips. The NULL-guard means an ancestor
    // with an existing cover, at any level, is never touched.
    await db.query(
      `WITH RECURSIVE starts AS (
         SELECT collection_id AS id FROM collection_resource WHERE resource_id = $2
       ),
       ancestors AS (
         SELECT c.id, c.parent_id FROM collections c INNER JOIN starts s ON c.id = s.id
         UNION ALL
         SELECT c.id, c.parent_id
         FROM collections c
         INNER JOIN ancestors a ON a.parent_id = c.id
         WHERE a.parent_id IS NOT NULL
       )
       UPDATE collections
          SET cover_storage_key = $1
        WHERE id IN (SELECT id FROM ancestors WHERE id NOT IN (SELECT id FROM starts))
          AND cover_storage_key IS NULL`,
      [thumbnailKey, id],
    );

    return NextResponse.json({ thumbnailStorageKey: thumbnailKey });
  } catch (err) {
    console.error('thumbnail generation failed for resource', id, err);
    return NextResponse.json({ error: 'could not generate thumbnail' }, { status: 422 });
  } finally {
    await fs.rm(inputPath, { force: true }).catch(() => {});
    await fs.rm(outputPath, { force: true }).catch(() => {});
  }
}
