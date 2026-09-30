#!/usr/bin/env node
// Generates every PWA icon from public/icon-source.svg via sharp.
// Run once per icon change: node scripts/generate-icons.mjs
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const publicDir = path.join(root, "public");
const source = readFileSync(path.join(publicDir, "icon-source.svg"));

const jobs = [
  // Standard PWA icons (any-purpose).
  { file: "icons/icon-192.png", size: 192 },
  { file: "icons/icon-512.png", size: 512 },
  // Maskable icons: content confined to the inner 80% safe zone so
  // launcher cropping never clips artwork.
  { file: "icons/icon-maskable-192.png", size: 192, scale: 0.8 },
  { file: "icons/icon-maskable-512.png", size: 512, scale: 0.8 },
  // Apple touch icon: opaque, square (iOS rounds it), no transparency.
  // Emitted twice: /icons/apple-touch-icon.png (linked from the head)
  // and /apple-touch-icon.png (the root path iOS probes as a fallback).
  { file: "icons/apple-touch-icon.png", size: 180 },
  { file: "apple-touch-icon.png", size: 180 },
  { file: "favicon-96.png", size: 96 },
];

mkdirSync(path.join(publicDir, "icons"), { recursive: true });
for (const job of jobs) {
  const scale = job.scale ?? 1;
  const inner = Math.round(job.size * scale);
  const offset = Math.round((job.size - inner) / 2);
  const tile = await sharp(source)
    .resize(inner, inner)
    .png()
    .toBuffer();
  const image = sharp({
    create: {
      width: job.size,
      height: job.size,
      channels: 4,
      background: { r: 28, g: 28, b: 34, alpha: 1 },
    },
  });
  await image
    .composite([{ input: tile, left: offset, top: offset }])
    .png()
    .toFile(path.join(publicDir, job.file));
  console.log(`wrote public/${job.file} (${job.size}x${job.size})`);
}
