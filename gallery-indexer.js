const fs = require('fs');
const path = require('path');

const photosDir = path.join(__dirname, 'photos');
const outputFile = path.join(__dirname, 'gallery.json');
const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function readExistingGallery() {
  if (!fs.existsSync(outputFile)) {
    return new Map();
  }

  const albums = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
  const metadata = new Map();

  for (const album of albums) {
    for (const image of album.images || []) {
      const src = typeof image === 'string' ? image : image.src;

      if (src) {
        metadata.set(src, {
          date: typeof image === 'object' && image.date ? image.date : null,
          description: typeof image === 'object' && image.description ? image.description : '',
        });
      }
    }
  }

  return metadata;
}

function toUrlPath(...parts) {
  return parts.map((part) => encodeURIComponent(part)).join('/');
}

function normalizeYear(year) {
  if (year.length === 2) {
    const value = Number(year);
    return value >= 70 ? 1900 + value : 2000 + value;
  }

  return Number(year);
}

function parseAlbumFolder(folderName) {
  const datePattern = /(?:(\d{1,2})\.(\d{1,2})-)?(\d{1,2})(?:-(\d{1,2}))?\.(\d{1,2})[.-](\d{2,4})/g;
  const matches = [...folderName.matchAll(datePattern)];

  if (matches.length === 0) {
    throw new Error(`Could not find a date in folder name: "${folderName}"`);
  }

  const lastMatch = matches[matches.length - 1];
  const day = Number(lastMatch[4] || lastMatch[3]);
  const month = Number(lastMatch[5]);
  const year = normalizeYear(lastMatch[6]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid date in folder name: "${folderName}"`);
  }

  const albumName = folderName
    .slice(0, lastMatch.index)
    .replace(/[\s,;-]+$/, '')
    .trim();

  return {
    name: albumName || folderName,
    year,
    date: date.toISOString().slice(0, 10),
  };
}

function getImages(albumPath, folderName, existingMetadata) {
  return fs
    .readdirSync(albumPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && imageExtensions.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    .map((fileName) => {
      const src = toUrlPath('photos', folderName, fileName);
      const metadata = existingMetadata.get(src);

      return {
        src,
        date: metadata?.date || null,
        description: metadata?.description || '',
      };
    });
}

function buildGallery() {
  if (!fs.existsSync(photosDir)) {
    throw new Error(`Photos directory not found: ${photosDir}`);
  }

  const existingMetadata = readExistingGallery();

  return fs
    .readdirSync(photosDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const album = parseAlbumFolder(entry.name);
      const images = getImages(path.join(photosDir, entry.name), entry.name, existingMetadata);

      return {
        ...album,
        folder: toUrlPath('photos', entry.name),
        thumbnail: images[0]?.src || null,
        images,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

const albums = buildGallery();
fs.writeFileSync(outputFile, `${JSON.stringify(albums, null, 2)}\n`, 'utf8');

console.log(`Wrote ${albums.length} albums to ${path.relative(process.cwd(), outputFile)}`);
