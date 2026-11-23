import { inflateRawSync } from 'node:zlib';
import type { SheetCell } from './domain.js';

const MAX_XML = 8 * 1024 * 1024;

export function readFirstSheet(file: Buffer): SheetCell[] {
  if (file.length > 5 * 1024 * 1024) throw new Error('请选择 5 MB 以内的 .xlsx 文件');
  const entries = readZip(file);
  const workbook = text(entries, 'xl/workbook.xml');
  const sheets = [...workbook.matchAll(/<sheet\b[^>]*>/g)];
  if (sheets.length !== 1) throw new Error('当前仅支持单工作表文件');
  const rels = text(entries, 'xl/_rels/workbook.xml.rels');
  const id = attr(sheets[0][0], 'r:id') || attr(sheets[0][0], 'id');
  const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].find((item) => attr(item[0], 'Id') === id);
  const target = rel ? attr(rel[0], 'Target') : '';
  if (!target) throw new Error('找不到工作表');
  const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  const sheet = text(entries, path);
  if (sheet.includes('<mergeCell')) throw new Error('不支持包含合并单元格的表格');
  const shared = entries.get('xl/sharedStrings.xml');
  const strings = shared ? sharedStrings(shared) : [];
  const cells: SheetCell[] = [];
  for (const match of sheet.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = match[1];
    const inner = match[2] ?? '';
    const ref = attr(`<c ${attrs}>`, 'r');
    const pos = /^([A-Z]+)(\d+)$/.exec(ref);
    if (!pos) continue;
    const col = colIndex(pos[1]);
    const row = Number(pos[2]);
    if (row > 100 || col > 100) throw new Error('表格超过 100 × 100，当前不接受');
    const type = attr(`<c ${attrs}>`, 't');
    const formula = /<f\b/.test(inner);
    const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '';
    let value = decodeXml(raw);
    let numeric = !type || type === 'n';
    if (type === 's') value = strings[Number(value)] ?? '';
    if (type === 'inlineStr') {
      numeric = false;
      value = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((item) => decodeXml(item[1])).join('');
    }
    if (value === '' && !formula) continue;
    cells.push({ row, col, value, numeric, formula });
  }
  return cells;
}

function readZip(file: Buffer): Map<string, string> {
  let end = -1;
  const min = Math.max(0, file.length - 22 - 65536);
  for (let i = file.length - 22; i >= min; i--) {
    if (file.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('无法读取 Excel 文件');
  const count = file.readUInt16LE(end + 10);
  let pos = file.readUInt32LE(end + 16);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    if (file.readUInt32LE(pos) !== 0x02014b50) throw new Error('Excel 文件结构无效');
    const method = file.readUInt16LE(pos + 10);
    const compressed = file.readUInt32LE(pos + 20);
    const size = file.readUInt32LE(pos + 24);
    const nameLen = file.readUInt16LE(pos + 28);
    const extraLen = file.readUInt16LE(pos + 30);
    const commentLen = file.readUInt16LE(pos + 32);
    const offset = file.readUInt32LE(pos + 42);
    const name = file.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    pos += 46 + nameLen + extraLen + commentLen;
    if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue;
    if (size > MAX_XML) throw new Error('Excel 内容过大');
    if (file.readUInt32LE(offset) !== 0x04034b50) throw new Error('Excel 文件结构无效');
    const localName = file.readUInt16LE(offset + 26);
    const localExtra = file.readUInt16LE(offset + 28);
    const start = offset + 30 + localName + localExtra;
    const bytes = file.subarray(start, start + compressed);
    if (method === 0) out.set(name, bytes.toString('utf8'));
    else if (method === 8) out.set(name, inflateRawSync(bytes).toString('utf8'));
    else throw new Error('不支持此 Excel 压缩格式');
  }
  return out;
}

function text(entries: Map<string, string>, name: string): string {
  const value = entries.get(name);
  if (!value) throw new Error(`Excel 中缺少 ${name}`);
  return value;
}

function sharedStrings(xml: string): string[] {
  return xml.split(/<si\b[^>]*>/).slice(1).map((block) => {
    return [...block.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((item) => decodeXml(item[1])).join('');
  });
}

function attr(tag: string, name: string): string {
  const found = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return found ? decodeXml(found[1]) : '';
}

function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64;
  return n;
}

function decodeXml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
