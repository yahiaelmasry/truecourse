import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureLastAnalyzed,
  getProjectBySlug,
  registerProject,
  resetRegistryStore,
  setLastAnalyzed,
} from '../../packages/core/src/config/registry';

let home: string;
let repoPath: string;
const originalHome = process.env.TRUECOURSE_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'truecourse-registry-'));
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'truecourse-repo-'));
  process.env.TRUECOURSE_HOME = home;
  resetRegistryStore();
});

afterEach(() => {
  resetRegistryStore();
  if (originalHome === undefined) delete process.env.TRUECOURSE_HOME;
  else process.env.TRUECOURSE_HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe('file registry lastAnalyzed projection', () => {
  it('is idempotent and never regresses a newer completed-analysis timestamp', async () => {
    const project = await registerProject(repoPath, 'My Repo');
    const newer = '2026-05-02T00:00:00.000Z';
    const older = '2026-05-01T00:00:00.000Z';

    await expect(ensureLastAnalyzed(project.slug, newer)).resolves.toBe('updated');
    await expect(ensureLastAnalyzed(project.slug, newer)).resolves.toBe('present');
    await expect(ensureLastAnalyzed(project.slug, older)).resolves.toBe('superseded');
    expect((await getProjectBySlug(project.slug))?.lastAnalyzed).toBe(newer);
  });

  it('fails closed for invalid input or an untracked project', async () => {
    await expect(ensureLastAnalyzed('missing', '2026-05-01T00:00:00.000Z')).rejects.toThrow(
      'Cannot project lastAnalyzed for an untracked project',
    );
    await expect(ensureLastAnalyzed('missing', 'not-a-timestamp')).rejects.toThrow(
      'lastAnalyzed must be a canonical ISO timestamp',
    );
  });

  it('keeps the setLastAnalyzed compatibility API monotonic', async () => {
    const project = await registerProject(repoPath, 'My Repo');
    const newer = '2026-05-02T00:00:00.000Z';

    await expect(setLastAnalyzed(project.slug, newer)).resolves.toBeUndefined();
    await expect(setLastAnalyzed(project.slug, '2026-05-01T00:00:00.000Z'))
      .resolves.toBeUndefined();
    await expect(setLastAnalyzed('missing', newer)).resolves.toBeUndefined();
    expect((await getProjectBySlug(project.slug))?.lastAnalyzed).toBe(newer);
  });

  it('serializes every global registry mutation before reading its snapshot', async () => {
    await registerProject(repoPath, 'First');
    const lockPath = path.join(home, 'registry.json.lock');
    fs.writeFileSync(lockPath, 'external-owner\n', 'utf-8');

    const secondPath = fs.mkdtempSync(path.join(os.tmpdir(), 'truecourse-repo-second-'));
    const pending = registerProject(secondPath, 'Second');
    await new Promise((resolve) => setTimeout(resolve, 25));

    const registryPath = path.join(home, 'registry.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8')) as {
      projects: Array<Record<string, unknown>>;
    };
    registry.projects.push({
      slug: 'external',
      name: 'External',
      path: '/external',
      lastOpened: '2026-05-01T00:00:00.000Z',
    });
    fs.writeFileSync(registryPath, JSON.stringify(registry), 'utf-8');
    fs.unlinkSync(lockPath);

    try {
      await expect(pending).resolves.toMatchObject({ slug: 'second' });
      expect((await getProjectBySlug('external'))?.name).toBe('External');
    } finally {
      fs.rmSync(secondPath, { recursive: true, force: true });
    }
  });

  it('rejects a malformed stored timestamp without mutating the registry', async () => {
    const project = await registerProject(repoPath, 'My Repo');
    const registryPath = path.join(home, 'registry.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8')) as {
      projects: Array<{ slug: string; lastAnalyzed?: string }>;
    };
    registry.projects.find((entry) => entry.slug === project.slug)!.lastAnalyzed = 'malformed';
    fs.writeFileSync(registryPath, JSON.stringify(registry), 'utf-8');
    const before = fs.readFileSync(registryPath, 'utf-8');

    await expect(ensureLastAnalyzed(
      project.slug,
      '2026-05-01T00:00:00.000Z',
    )).rejects.toThrow('Stored lastAnalyzed must be a canonical ISO timestamp');
    expect(fs.readFileSync(registryPath, 'utf-8')).toBe(before);
  });

  it('does not overwrite a malformed registry document', async () => {
    const project = await registerProject(repoPath, 'My Repo');
    const registryPath = path.join(home, 'registry.json');
    fs.writeFileSync(registryPath, '{ malformed', 'utf-8');

    await expect(ensureLastAnalyzed(
      project.slug,
      '2026-05-01T00:00:00.000Z',
    )).rejects.toThrow();
    expect(fs.readFileSync(registryPath, 'utf-8')).toBe('{ malformed');
  });
});
