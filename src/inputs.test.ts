import * as core from '@actions/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseInputs } from './inputs';

// Action inputs are read via `core.getInput('foo')` which maps to env var
// INPUT_FOO. Mock core directly for predictable behavior — env-var-only
// approach forces upper-casing/dash-handling we don't want to validate here.
vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
}));

const VALID_TOKEN = `lbk_${'a'.repeat(43)}`;
const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

function withInputs(map: Record<string, string>): void {
  vi.mocked(core.getInput).mockImplementation((name: string) => map[name] ?? '');
}

describe('parseInputs', () => {
  beforeEach(() => {
    vi.mocked(core.getInput).mockReset();
  });
  afterEach(() => {
    vi.mocked(core.getInput).mockReset();
  });

  it('parses a minimal valid configuration', () => {
    withInputs({
      'api-token': VALID_TOKEN,
      'game-id': VALID_UUID,
      version: '1.0.0',
      archive: 'build/archive.zip',
    });
    const result = parseInputs();
    expect(result.apiToken).toBe(VALID_TOKEN);
    expect(result.gameId).toBe(VALID_UUID);
    expect(result.version).toBe('1.0.0');
    expect(result.baseUrl).toBe('https://admin.lbklauncher.com');
    expect(result.files.get('archive')).toBe('build/archive.zip');
    expect(result.status).toBeUndefined();
  });

  it('rejects when api-token has wrong format', () => {
    withInputs({
      'api-token': 'wrong-token',
      'game-id': VALID_UUID,
      version: '1',
      archive: 'a.zip',
    });
    expect(() => parseInputs()).toThrow(/api[-_ ]?token/i);
  });

  it('rejects when game-id is not a UUID', () => {
    withInputs({
      'api-token': VALID_TOKEN,
      'game-id': 'not-a-uuid',
      version: '1',
      archive: 'a.zip',
    });
    expect(() => parseInputs()).toThrow(/UUID/i);
  });

  it('rejects when version is empty', () => {
    withInputs({
      'api-token': VALID_TOKEN,
      'game-id': VALID_UUID,
      version: '   ',
      archive: 'a.zip',
    });
    expect(() => parseInputs()).toThrow(/version/i);
  });

  it('rejects when no archive provided', () => {
    withInputs({
      'api-token': VALID_TOKEN,
      'game-id': VALID_UUID,
      version: '1',
    });
    expect(() => parseInputs()).toThrow(/archive/i);
  });

  it('rejects "planned" status (token API does not allow it)', () => {
    withInputs({
      'api-token': VALID_TOKEN,
      'game-id': VALID_UUID,
      version: '1',
      archive: 'a.zip',
      status: 'planned',
    });
    expect(() => parseInputs()).toThrow();
  });

  it('accepts allowed status values', () => {
    for (const status of ['completed', 'in-progress', 'tech-improvement']) {
      withInputs({
        'api-token': VALID_TOKEN,
        'game-id': VALID_UUID,
        version: '1',
        archive: 'a.zip',
        status,
      });
      expect(parseInputs().status).toBe(status);
    }
  });

  it('rejects translation-progress out of range', () => {
    withInputs({
      'api-token': VALID_TOKEN,
      'game-id': VALID_UUID,
      version: '1',
      archive: 'a.zip',
      'translation-progress': '150',
    });
    // zod uses the schema field name `translationProgress` in error paths.
    expect(() => parseInputs()).toThrow(/translationProgress/i);
  });

  it('strips trailing slashes from base-url', () => {
    withInputs({
      'api-token': VALID_TOKEN,
      'game-id': VALID_UUID,
      version: '1',
      archive: 'a.zip',
      'base-url': 'https://custom.example.com///',
    });
    expect(parseInputs().baseUrl).toBe('https://custom.example.com');
  });

  it('collects multiple archive kinds', () => {
    withInputs({
      'api-token': VALID_TOKEN,
      'game-id': VALID_UUID,
      version: '1',
      archive: 'a.zip',
      voice: 'v.zip',
      'steam-linux': 'sl.zip',
    });
    const result = parseInputs();
    expect(result.files.size).toBe(3);
    expect(result.files.get('archive')).toBe('a.zip');
    expect(result.files.get('voice')).toBe('v.zip');
    expect(result.files.get('steam-linux')).toBe('sl.zip');
  });
});
