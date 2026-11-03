import { BadRequestException } from '@nestjs/common';

/** Exact case-insensitive source names; never reinterpret these as filesystem paths. */
export function testcenterSourceSelection(files: { name: string }[], requested?: string[]): Set<string> | undefined {
  if (requested === undefined) return undefined;
  const selected = normalizedTestcenterSourceNames(requested);
  const available = new Set(files.map(file => file.name.toUpperCase()));
  if ([...selected].some(name => !available.has(name))) throw new BadRequestException('Selected Testcenter source files are missing; inspect the source inventory');
  return selected;
}

export function normalizedTestcenterSourceNames(requested: string[]): Set<string> {
  if (!Array.isArray(requested) || requested.length === 0 || requested.length > 1000 || requested.some(name => typeof name !== 'string' || !name || name.length > 200 || name.includes('/') || name.includes(String.fromCharCode(92)) || [...name].some(character => character.charCodeAt(0) < 32))) {
    throw new BadRequestException('Invalid Testcenter source file selection');
  }
  const selected = new Set(requested.map(name => name.toUpperCase()));
  if (selected.size !== requested.length) throw new BadRequestException('Source file names must be unique without case');
  return selected;
}
