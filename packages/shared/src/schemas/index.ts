import { z } from 'zod'

// ---------------------------------------------------------------------------
// API Request/Response Validation Schemas
// ---------------------------------------------------------------------------

export const CreateRepoSchema = z.object({
  path: z.string().min(1),
})

export type CreateRepoInput = z.infer<typeof CreateRepoSchema>

const AnalyzeSkipGitSchema = z.boolean().optional().default(false)

export const AnalyzeRepoSchema = z.discriminatedUnion('mode', [
  z.object({
    /** Full analyze of the committed HEAD state. */
    mode: z.literal('full'),
    /** Skip git ops (branch detection, commit hash read, pre-parse stash). */
    skipGit: AnalyzeSkipGitSchema,
    /** Exact incomplete attempted run the user explicitly chose to replace. */
    abandonAttemptRunId: z.string().min(1).optional(),
  }),
  z.object({
    /** Working tree vs the active completed analysis in LATEST. */
    mode: z.literal('diff'),
    skipGit: AnalyzeSkipGitSchema,
    /** Starting over is meaningful only for a full analysis. */
    abandonAttemptRunId: z.never().optional(),
  }),
])

export type AnalyzeRepoInput = z.infer<typeof AnalyzeRepoSchema>

const AnalyzeRearmEvidenceSchema = z.object({
  runId: z.string().min(1),
  runRevision: z.number().int().nonnegative(),
  executionEpoch: z.object({
    kind: z.union([z.literal('initial'), z.literal('resume')]),
    attemptNumber: z.number().int().positive(),
    activatedAt: z.string().datetime(),
  }),
  admittedAt: z.string().datetime(),
  pendingWorkCount: z.number().int().nonnegative(),
})

/** The client must echo every durable field; the server compares it with a fresh Core offer. */
export const AnalyzeRearmRequestSchema = z.object({
  consent: z.object({
    evidence: AnalyzeRearmEvidenceSchema,
    acceptedRisk: z.literal('repeat-up-to-pending-provider-calls'),
    acceptedMaxRepeatProviderCalls: z.number().int().nonnegative().safe(),
  }),
})

export type AnalyzeRearmRequest = z.infer<typeof AnalyzeRearmRequestSchema>

export const GenerateViolationsSchema = z.object({
  analysisId: z.string().uuid().optional(),
})

export type GenerateViolationsInput = z.infer<typeof GenerateViolationsSchema>

// ---------------------------------------------------------------------------
// Directory browse (local-filesystem picker) — issue #41
// ---------------------------------------------------------------------------

/** Query for GET /api/repos/browse. `path` optional; server defaults to os.homedir(). */
export const BrowseDirQuerySchema = z.object({
  path: z.string().optional(),
})
export type BrowseDirQuery = z.infer<typeof BrowseDirQuerySchema>

/** One non-hidden subdirectory of the browsed path. */
export const BrowseEntrySchema = z.object({
  /** Basename, e.g. "my-service". */
  name: z.string(),
  /** Absolute path to this subdirectory. */
  path: z.string(),
  /** True when the subdirectory contains a `.git` directory (a git repo). */
  isRepo: z.boolean(),
})
export type BrowseEntry = z.infer<typeof BrowseEntrySchema>

export const BrowseDirResponseSchema = z.object({
  /** The (realpath-resolved) absolute directory being listed. */
  path: z.string(),
  /** Absolute parent path, or null when `path` is the filesystem root. */
  parent: z.string().nullable(),
  /** Non-hidden subdirectories, sorted alphabetically by name. */
  entries: z.array(BrowseEntrySchema),
})
export type BrowseDirResponse = z.infer<typeof BrowseDirResponseSchema>
