/**
 * Project registry — the dashboard's list of known projects. File-backed by
 * default (global `~/.truecourse/registry.json`); the enterprise edition injects
 * a Postgres-backed impl via `setRegistryStore` (the registry collapses into the
 * server-side `repos` table for hosted, multi-instance deploys). Async so a DB
 * impl is possible; the file impl wraps synchronous `fs`.
 *
 * The whole public API is on the interface (not just read/write): several
 * methods are filesystem-coupled today (`path.resolve`, `ensureRepoTruecourseDir`,
 * a `.truecourse/`-exists liveness check) and the EE impl must replace that logic
 * with row operations.
 */

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '../lib/atomic-write.js';
import { ensureRepoTruecourseDir, getGlobalDir, getRegistryPath, getRepoTruecourseDir } from './paths.js';

export interface RegistryEntry {
  /** Stable URL-safe identifier derived from the project name. */
  slug: string;
  /** Display name (defaults to the directory basename). */
  name: string;
  /** Absolute path to the repo root that contains `.truecourse/`. */
  path: string;
  /**
   * ISO timestamp of the last dashboard interaction (add / open / any
   * project-scoped request). Used purely for "recent projects" UX — never
   * surfaced as an analysis timestamp.
   */
  lastOpened?: string;
  /**
   * ISO timestamp of the last SUCCESSFUL analysis completion. Written only
   * by `analyzeInProcess` at the end of a completed run. `null`/undefined
   * means "never analyzed".
   */
  lastAnalyzed?: string;
  /**
   * Default branch (e.g. `main`). Set by registries that track it without a
   * local checkout — the hosted `gh_repos`-derived registry. OSS leaves it
   * unset, and the repo route reads the branch from the on-disk git repo.
   */
  defaultBranch?: string;
}

interface RegistryFile {
  projects: RegistryEntry[];
}

export type EnsureLastAnalyzedResult = 'updated' | 'present' | 'superseded' | 'untracked';

export function validateLastAnalyzedTimestamp(
  isoTimestamp: string,
  label = 'lastAnalyzed',
): void {
  if (
    typeof isoTimestamp !== 'string'
    || Number.isNaN(Date.parse(isoTimestamp))
    || new Date(isoTimestamp).toISOString() !== isoTimestamp
  ) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

/** Pluggable project registry. File-backed by default; EE injects Postgres. */
export interface RegistryStore {
  readRegistry(): Promise<RegistryEntry[]>;
  pruneStaleProjects(): Promise<RegistryEntry[]>;
  getProjectBySlug(slug: string): Promise<RegistryEntry | null>;
  getProjectByPath(repoPath: string): Promise<RegistryEntry | null>;
  registerProject(repoPath: string, displayName?: string): Promise<RegistryEntry>;
  unregisterProject(slug: string): Promise<boolean>;
  touchProject(slug: string): Promise<void>;
  setLastAnalyzed(slug: string, isoTimestamp: string): Promise<void>;
  /** Call while holding the repository lifecycle lock. */
  ensureLastAnalyzed?(
    slug: string,
    isoTimestamp: string,
  ): Promise<EnsureLastAnalyzedResult>;
}

// ---------------------------------------------------------------------------
// File-backed default impl (OSS) — synchronous fs under an async surface.
// ---------------------------------------------------------------------------

class FileRegistryStore implements RegistryStore {
  private async withMutationLock<T>(operation: () => T): Promise<T> {
    fs.mkdirSync(getGlobalDir(), { recursive: true });
    const lockPath = `${getRegistryPath()}.lock`;
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        const fd = fs.openSync(lockPath, 'wx');
        try {
          fs.writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
        } catch (error) {
          fs.unlinkSync(lockPath);
          throw error;
        } finally {
          fs.closeSync(fd);
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) {
          throw new Error(`Project registry is locked; remove ${lockPath} if no process owns it`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    try {
      return operation();
    } finally {
      fs.unlinkSync(lockPath);
    }
  }

  private loadRaw(): RegistryFile {
    const file = getRegistryPath();
    if (!fs.existsSync(file)) return { projects: [] };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<RegistryFile>;
    if (!Array.isArray(parsed.projects)) throw new Error('Project registry is malformed');
    return { projects: parsed.projects };
  }

  private persist(file: RegistryFile): void {
    atomicWriteJson(getRegistryPath(), file);
  }

  async readRegistry(): Promise<RegistryEntry[]> {
    return this.loadRaw().projects;
  }

  async pruneStaleProjects(): Promise<RegistryEntry[]> {
    if (!fs.existsSync(getRegistryPath())) return [];
    return this.withMutationLock(() => {
      const file = this.loadRaw();
      const alive = file.projects.filter((entry) => fs.existsSync(getRepoTruecourseDir(entry.path)));
      if (alive.length !== file.projects.length) this.persist({ projects: alive });
      return alive;
    });
  }

  async getProjectBySlug(slug: string): Promise<RegistryEntry | null> {
    return this.loadRaw().projects.find((p) => p.slug === slug) ?? null;
  }

  async getProjectByPath(repoPath: string): Promise<RegistryEntry | null> {
    const normalized = path.resolve(repoPath);
    return this.loadRaw().projects.find((p) => p.path === normalized) ?? null;
  }

  async registerProject(repoPath: string, displayName?: string): Promise<RegistryEntry> {
    const normalized = path.resolve(repoPath);
    ensureRepoTruecourseDir(normalized);
    return this.withMutationLock(() => {
      const file = this.loadRaw();
      const name = displayName || path.basename(normalized);
      const existing = file.projects.find((p) => p.path === normalized);

      if (existing) {
        existing.name = name;
        existing.lastOpened = new Date().toISOString();
        this.persist(file);
        return existing;
      }

      const entry: RegistryEntry = {
        slug: slugify(name, file.projects.map((p) => p.slug)),
        name,
        path: normalized,
        lastOpened: new Date().toISOString(),
      };
      file.projects.push(entry);
      this.persist(file);
      return entry;
    });
  }

  async unregisterProject(slug: string): Promise<boolean> {
    if (!fs.existsSync(getRegistryPath())) return false;
    if (!this.loadRaw().projects.some((entry) => entry.slug === slug)) return false;
    return this.withMutationLock(() => {
      const file = this.loadRaw();
      const before = file.projects.length;
      file.projects = file.projects.filter((p) => p.slug !== slug);
      if (file.projects.length === before) return false;
      this.persist(file);
      return true;
    });
  }

  async touchProject(slug: string): Promise<void> {
    if (!fs.existsSync(getRegistryPath())) return;
    if (!this.loadRaw().projects.some((entry) => entry.slug === slug)) return;
    await this.withMutationLock(() => {
      const file = this.loadRaw();
      const entry = file.projects.find((p) => p.slug === slug);
      if (!entry) return;
      entry.lastOpened = new Date().toISOString();
      this.persist(file);
    });
  }

  async ensureLastAnalyzed(
    slug: string,
    isoTimestamp: string,
  ): Promise<EnsureLastAnalyzedResult> {
    validateLastAnalyzedTimestamp(isoTimestamp);
    return this.withMutationLock(() => {
      const file = this.loadRaw();
      const entry = file.projects.find((p) => p.slug === slug);
      if (!entry) throw new Error('Cannot project lastAnalyzed for an untracked project');
      if (entry.lastAnalyzed) {
        validateLastAnalyzedTimestamp(entry.lastAnalyzed, 'Stored lastAnalyzed');
        if (entry.lastAnalyzed === isoTimestamp) return 'present';
        if (entry.lastAnalyzed > isoTimestamp) return 'superseded';
      }
      entry.lastAnalyzed = isoTimestamp;
      this.persist(file);
      return 'updated';
    });
  }

  async setLastAnalyzed(slug: string, isoTimestamp: string): Promise<void> {
    if (!fs.existsSync(getRegistryPath())) return;
    if (!this.loadRaw().projects.some((entry) => entry.slug === slug)) return;
    try {
      await this.ensureLastAnalyzed(slug, isoTimestamp);
    } catch (error) {
      if ((error as Error).message === 'Cannot project lastAnalyzed for an untracked project') return;
      throw error;
    }
  }
}

let active: RegistryStore = new FileRegistryStore();

/** The active project registry (file-backed unless EE installed a Postgres one). */
export function getRegistryStore(): RegistryStore {
  return active;
}
/** Install a project registry (e.g. the enterprise Postgres impl). */
export function setRegistryStore(store: RegistryStore): void {
  active = store;
}
/** Restore the file-backed default (tests). */
export function resetRegistryStore(): void {
  active = new FileRegistryStore();
}

// ---------------------------------------------------------------------------
// Public API (delegators)
// ---------------------------------------------------------------------------

/** Return all registered projects. */
export const readRegistry = (): Promise<RegistryEntry[]> => active.readRegistry();

/** Drop entries whose `.truecourse/` directory no longer exists. Returns the pruned list. */
export const pruneStaleProjects = (): Promise<RegistryEntry[]> => active.pruneStaleProjects();

export const getProjectBySlug = (slug: string): Promise<RegistryEntry | null> =>
  active.getProjectBySlug(slug);

export const getProjectByPath = (repoPath: string): Promise<RegistryEntry | null> =>
  active.getProjectByPath(repoPath);

/**
 * Add (or update) an entry for `repoPath`. Returns the resulting entry.
 * Existing entries keep their slug; lastOpened is refreshed.
 */
export const registerProject = (repoPath: string, displayName?: string): Promise<RegistryEntry> =>
  active.registerProject(repoPath, displayName);

export const unregisterProject = (slug: string): Promise<boolean> =>
  active.unregisterProject(slug);

export const touchProject = (slug: string): Promise<void> => active.touchProject(slug);

/**
 * Idempotently project a successful analysis completion while holding the
 * repository lifecycle lock. A delayed older recovery never lowers the value.
 */
export const ensureLastAnalyzed = (
  slug: string,
  isoTimestamp: string,
): Promise<EnsureLastAnalyzedResult> => {
  if (!active.ensureLastAnalyzed) {
    return Promise.reject(new Error('Active registry store does not support monotonic projection'));
  }
  return active.ensureLastAnalyzed(slug, isoTimestamp);
};

/** Backward-compatible command API, including unknown-project no-op behavior. */
export const setLastAnalyzed = (slug: string, isoTimestamp: string): Promise<void> =>
  active.setLastAnalyzed(slug, isoTimestamp);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive a unique URL-safe slug from a display name, avoiding `taken`. */
export function slugify(name: string, taken: string[]): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'project';
  if (!taken.includes(base)) return base;
  let i = 2;
  while (taken.includes(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}
