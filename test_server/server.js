#!/usr/bin/env node

/**
 * Simple static file server for testing markmap examples
 * Serves the alternate_dir_feature folder on http://localhost:8080
 */

import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = 8080;
const PROJECT_ROOT = join(__dirname, '..');
const FEATURE_DIR = join(__dirname, 'alternate_dir_feature');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
};

const server = createServer(async (req, res) => {
  try {
    // Parse URL and default to index.html for root
    let filePath = req.url === '/' ? '/index.html' : req.url;

    // Remove query string
    filePath = filePath.split('?')[0];

    // Determine absolute path based on request
    let absolutePath;
    if (filePath.startsWith('/packages/')) {
      // Serve from project root for packages
      absolutePath = join(PROJECT_ROOT, filePath);
    } else {
      // Serve from feature directory for everything else
      absolutePath = join(FEATURE_DIR, filePath);
    }

    // Security check: ensure path is within allowed directories
    const isInFeatureDir = absolutePath.startsWith(FEATURE_DIR);
    const isInPackagesDir = absolutePath.startsWith(join(PROJECT_ROOT, 'packages'));

    if (!isInFeatureDir && !isInPackagesDir) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    // Read file
    const content = await readFile(absolutePath);

    // Set content type
    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*'
    });
    res.end(content);

    console.log(`✓ ${req.method} ${req.url}`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.writeHead(404);
      res.end('Not Found');
      console.log(`✗ 404 ${req.url}`);
    } else {
      res.writeHead(500);
      res.end('Internal Server Error');
      console.error(`✗ Error serving ${req.url}:`, error.message);
    }
  }
});

server.listen(PORT, () => {
  console.log(`\n🚀 Markmap test server running at http://localhost:${PORT}`);
  console.log(`📁 Serving:`);
  console.log(`   - Main: ${FEATURE_DIR}`);
  console.log(`   - Packages: ${join(PROJECT_ROOT, 'packages')}\n`);
});
