import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const fixtureDir = path.resolve("fixtures/phase2a/images");
const referenceJpg = path.join(fixtureDir, "acid-god-ai-reference.jpg");

await mkdir(fixtureDir, { recursive: true });
await sharp(referenceJpg, { animated: false })
  .png({ compressionLevel: 9 })
  .toFile(path.join(fixtureDir, "Acid God_optimization.png"));

await sharp({
  create: {
    width: 64,
    height: 64,
    channels: 4,
    background: { r: 255, g: 0, b: 0, alpha: 0.5 },
  },
})
  .png()
  .toFile(path.join(fixtureDir, "Transparent_optimization.png"));

console.log(`created ${path.join(fixtureDir, "Acid God_optimization.png")}`);
console.log(`created ${path.join(fixtureDir, "Transparent_optimization.png")}`);
