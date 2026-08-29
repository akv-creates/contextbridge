// Extracts plain text from uploaded .docx / .pptx files so it can be run
// through the same capture pipeline as chat messages (engine/capture-flow.js).

import mammoth from 'mammoth';
import JSZip from 'jszip';

const MAX_CHARS = 15000; // matches the limit used by the extension's chat scrapers

// Strip XML tags from a single <a:t>...</a:t> text run.
function textRunsFromSlideXml(xml) {
  const runs = [];
  const re = /<a:t>([\s\S]*?)<\/a:t>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const decoded = m[1]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
    if (decoded.trim()) runs.push(decoded);
  }
  return runs;
}

async function extractPptx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml$/)[1]);
      const nb = Number(b.match(/slide(\d+)\.xml$/)[1]);
      return na - nb;
    });

  if (slideFiles.length === 0) {
    throw new Error('No slides found in .pptx file');
  }

  const slideTexts = [];
  for (const file of slideFiles) {
    const xml = await zip.files[file].async('string');
    const runs = textRunsFromSlideXml(xml);
    if (runs.length > 0) {
      const slideNum = file.match(/slide(\d+)\.xml$/)[1];
      slideTexts.push(`--- Slide ${slideNum} ---\n${runs.join('\n')}`);
    }
  }

  return slideTexts.join('\n\n');
}

async function extractDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

// Returns { text, truncated } for a buffer + filename. Throws on unsupported
// extension or parse failure — caller (route) maps this to a 400.
export async function extractDocumentText(buffer, filename) {
  const ext = (filename || '').toLowerCase().split('.').pop();

  let text;
  if (ext === 'docx') {
    text = await extractDocx(buffer);
  } else if (ext === 'pptx') {
    text = await extractPptx(buffer);
  } else {
    const err = new Error(`Unsupported file type: .${ext}. Only .docx and .pptx are supported.`);
    err.status = 400;
    throw err;
  }

  text = (text || '').trim();
  if (!text) {
    const err = new Error('No extractable text found in this file.');
    err.status = 400;
    throw err;
  }

  const truncated = text.length > MAX_CHARS;
  return {
    text: truncated ? text.slice(0, MAX_CHARS) : text,
    truncated,
  };
}
