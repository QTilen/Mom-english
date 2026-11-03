// Adds screenshots for picture lessons from the command line (e.g. after
// copying them to the Pi with scp). The running server's job worker then has
// Claude turn each into a lesson. Usage: npm run images:add -- <source> <file...>
import fs from "fs";
import path from "path";
import { addImage } from "../content/images";

const [source, ...files] = process.argv.slice(2);
if (!source || files.length === 0) {
  console.error("Usage: npm run images:add -- <source, e.g. Zalando> <file...>");
  process.exit(1);
}
const types: Record<string, string> = { ".png": ".png", ".jpg": ".jpg", ".jpeg": ".jpg", ".webp": ".webp" };
for (const file of files) {
  const ext = types[path.extname(file).toLowerCase()];
  if (!ext) {
    console.error(`Skipping ${file}: not a PNG, JPG or WebP`);
    continue;
  }
  console.log(`${file} → image #${addImage(fs.readFileSync(file), ext, source)}`);
}
