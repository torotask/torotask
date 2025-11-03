import fs from 'node:fs/promises';
import path from 'node:path';
import { cwd } from 'node:process';

const docsDir = path.join(cwd(), 'apps/docs/content/docs/api');

async function addFrontmatterToFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await addFrontmatterToFiles(fullPath);
    }
    else if (entry.isFile() && entry.name.endsWith('.md')) {
      await processFile(fullPath);
    }
  }
}

async function processFile(filePath) {
  let content = await fs.readFile(filePath, 'utf-8');

  if (content.startsWith('---')) {
    console.log(`Frontmatter already exists in ${filePath}. Skipping.`);
    return;
  }

  const fileName = path.basename(filePath, '.md');
  // A simple regex to find the main heading and use it as the title
  const headingMatch = content.match(/^#\s*(.*)/m);
  const title = headingMatch ? headingMatch[1].replace(/`/g, '') : fileName;

  const frontmatter = `---
title: ${title}
---

`;

  content = frontmatter + content;
  await fs.writeFile(filePath, content, 'utf-8');
  console.log(`Added frontmatter to ${filePath}`);
}

addFrontmatterToFiles(docsDir)
  .then(() => console.log('Finished adding frontmatter.'))
  .catch(err => console.error('Error adding frontmatter:', err));
