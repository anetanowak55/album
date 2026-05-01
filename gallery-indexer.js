const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const photosDir = path.join(__dirname, 'photos');
const outputFile = path.join(__dirname, 'gallery.json');
const maxImageBytes = 5 * 1024 * 1024;
const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.heic', '.heif']);
const fallbackJpegExtensions = new Set(['.jpg', '.jpeg']);
const jpegOutputExtensions = new Set(['.heic', '.heif']);
const videoExtensions = new Set([
  '.3g2',
  '.3gp',
  '.avi',
  '.m4v',
  '.mkv',
  '.mov',
  '.mp4',
  '.mpeg',
  '.mpg',
  '.mts',
  '.m2ts',
  '.webm',
  '.wmv',
]);

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

function findCommand(command, extraPaths = []) {
  try {
    const lookupCommand = process.platform === 'win32' ? 'where' : 'which';
    return execFileSync(lookupCommand, [command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/)
      .find(Boolean);
  } catch {
    return extraPaths.find((candidate) => fs.existsSync(candidate)) || null;
  }
}

const imageMagickCommand = findCommand('magick', [
  'C:\\Program Files\\ImageMagick-7.1.2-Q16-HDRI\\magick.exe',
]);
const powershellCommandPath = findCommand('powershell') || findCommand('pwsh');
const hasImageMagick = Boolean(imageMagickCommand);
const hasPowerShell = process.platform === 'win32' && Boolean(powershellCommandPath);
const powerShellCommand = powershellCommandPath || 'powershell';

function replaceFile(sourceFile, replacementFile) {
  fs.copyFileSync(replacementFile, sourceFile);
  fs.unlinkSync(replacementFile);
}

function getCompressedOutputPath(filePath) {
  const extension = path.extname(filePath).toLowerCase();

  if (!jpegOutputExtensions.has(extension)) {
    return filePath;
  }

  const parsedPath = path.parse(filePath);
  const jpgPath = path.join(parsedPath.dir, `${parsedPath.name}.jpg`);

  if (!fs.existsSync(jpgPath)) {
    return jpgPath;
  }

  return path.join(parsedPath.dir, `${parsedPath.name}-compressed.jpg`);
}

function compressWithImageMagick(filePath, tempFile, quality, scale) {
  execFileSync(
      imageMagickCommand,
    [
      filePath,
      '-auto-orient',
      '-resize',
      `${scale}%`,
      '-strip',
      '-interlace',
      'Plane',
      '-quality',
      String(quality),
      tempFile,
    ],
    { stdio: 'ignore' }
  );
}

function compressJpegWithPowerShell(filePath, tempFile, quality, scale) {
  const scriptFile = `${tempFile}.ps1`;
  const script = `
param([string]$InputPath, [string]$OutputPath, [int]$Quality, [int]$Scale)
Add-Type -AssemblyName System.Drawing
$image = [System.Drawing.Image]::FromFile($InputPath)
$width = [Math]::Max(1, [int]($image.Width * $Scale / 100))
$height = [Math]::Max(1, [int]($image.Height * $Scale / 100))
$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.DrawImage($image, 0, 0, $width, $height)
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $parameters = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $parameters.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)
  $bitmap.Save($OutputPath, $codec, $parameters)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
  $image.Dispose()
}
`;

  fs.writeFileSync(scriptFile, script, 'utf8');

  try {
    execFileSync(
      powerShellCommand,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptFile, filePath, tempFile, String(quality), String(scale)],
      { stdio: 'ignore' }
    );
  } finally {
    if (fs.existsSync(scriptFile)) {
      fs.unlinkSync(scriptFile);
    }
  }
}

function compressImage(filePath) {
  const originalSize = fs.statSync(filePath).size;

  if (originalSize <= maxImageBytes) {
    return {
      compressed: false,
      filePath,
    };
  }

  const extension = path.extname(filePath).toLowerCase();
  const outputFilePath = getCompressedOutputPath(filePath);
  const outputExtension = path.extname(outputFilePath).toLowerCase();
  const tempFile = `${outputFilePath}.compressing${outputExtension}`;
  const compressor = hasImageMagick
    ? compressWithImageMagick
    : fallbackJpegExtensions.has(extension) && hasPowerShell
      ? compressJpegWithPowerShell
      : null;

  if (!compressor) {
    throw new Error(
      `Cannot compress oversized image without ImageMagick: ${path.relative(process.cwd(), filePath)}`
    );
  }

  try {
    for (const scale of [100, 90, 80, 70, 60, 50, 40, 30, 20]) {
      for (const quality of [85, 75, 65, 55, 45, 35, 25, 15]) {
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }

        compressor(filePath, tempFile, quality, scale);
        const compressedSize = fs.statSync(tempFile).size;

        if (compressedSize <= maxImageBytes) {
          if (outputFilePath === filePath) {
            replaceFile(filePath, tempFile);
          } else {
            fs.renameSync(tempFile, outputFilePath);
            fs.unlinkSync(filePath);
          }

          return {
            compressed: true,
            filePath: outputFilePath,
          };
        }
      }
    }

    throw new Error(
      `Could not compress image to 5MB: ${path.relative(process.cwd(), filePath)}`
    );
  } finally {
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  }
}

function cleanNestedAlbumFiles(directoryPath, stats) {
  for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
    const entryPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      cleanNestedAlbumFiles(entryPath, stats);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();

    if (videoExtensions.has(extension)) {
      fs.unlinkSync(entryPath);
      stats.removedVideos += 1;
      continue;
    }

    if (!imageExtensions.has(extension)) {
      continue;
    }

    const compressedImage = compressImage(entryPath);

    if (compressedImage.compressed) {
      stats.compressedImages += 1;
    }
  }
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
    const yearPattern = /(?:^|\D)((?:19|20)\d{2})(?!\d)/g;
    const yearMatches = [...folderName.matchAll(yearPattern)];

    if (yearMatches.length === 0) {
      throw new Error(`Could not find a date in folder name: "${folderName}"`);
    }

    const lastYearMatch = yearMatches[yearMatches.length - 1];
    const year = Number(lastYearMatch[1]);
    const albumName = folderName
      .slice(0, lastYearMatch.index + lastYearMatch[0].indexOf(lastYearMatch[1]))
      .replace(/[\s,;-]+$/, '')
      .trim();

    return {
      name: albumName || folderName,
      year,
      date: `${year}-12-31`,
    };
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

function getImages(albumPath, folderName, existingMetadata, stats) {
  const seenImages = new Set();
  const imageFileNames = [];

  for (const entry of fs.readdirSync(albumPath, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      cleanNestedAlbumFiles(path.join(albumPath, entry.name), stats);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();
    const filePath = path.join(albumPath, entry.name);

    if (videoExtensions.has(extension)) {
      fs.unlinkSync(filePath);
      stats.removedVideos += 1;
      continue;
    }

    if (!imageExtensions.has(extension)) {
      continue;
    }

    const compressedImage = compressImage(filePath);

    if (compressedImage.compressed) {
      stats.compressedImages += 1;
    }

    imageFileNames.push(path.basename(compressedImage.filePath));
  }

  return imageFileNames
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    .filter((fileName) => {
      const src = toUrlPath('photos', folderName, fileName);

      if (seenImages.has(src)) {
        return false;
      }

      seenImages.add(src);
      return true;
    })
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
  const albumsByFolder = new Map();
  const albumKeys = new Set();
  const stats = {
    compressedImages: 0,
    removedDuplicateAlbums: 0,
    removedVideos: 0,
  };

  fs
    .readdirSync(photosDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .forEach((entry) => {
      const folder = toUrlPath('photos', entry.name);

      if (albumsByFolder.has(folder)) {
        stats.removedDuplicateAlbums += 1;
        return;
      }

      const album = parseAlbumFolder(entry.name);
      const albumKey = `${album.date}:${album.name.toLowerCase()}`;

      if (albumKeys.has(albumKey)) {
        stats.removedDuplicateAlbums += 1;
        return;
      }

      const images = getImages(path.join(photosDir, entry.name), entry.name, existingMetadata, stats);
      albumKeys.add(albumKey);

      albumsByFolder.set(folder, {
        ...album,
        folder,
        thumbnail: images[0]?.src || null,
        images,
      });
    });

  return {
    albums: [...albumsByFolder.values()].sort((a, b) => b.date.localeCompare(a.date)),
    stats,
  };
}

const { albums, stats } = buildGallery();
fs.writeFileSync(outputFile, `${JSON.stringify(albums, null, 2)}\n`, 'utf8');

console.log(`Wrote ${albums.length} albums to ${path.relative(process.cwd(), outputFile)}`);
console.log(`Removed ${stats.removedVideos} video files`);
console.log(`Compressed ${stats.compressedImages} oversized images`);
console.log(`Skipped ${stats.removedDuplicateAlbums} duplicate album folders`);
