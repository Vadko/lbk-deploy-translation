import { createReadStream, statSync } from 'node:fs';
import axios, { type AxiosInstance } from 'axios';
import * as tus from 'tus-js-client';
import type { UploadKind } from './inputs';

/**
 * One entry per kind in the response of POST /api/submit-via-token/uploads.
 * The token API accepts both flows:
 *   - **TUS (recommended)** — resumable upload via tus-js-client. Use
 *     `tusEndpoint` + `headers['x-signature']: token` + the bucketName/objectName
 *     metadata. Recovers from network drops mid-upload.
 *   - **Legacy single-shot PUT** — single HTTP PUT to `signedUrl`. No resume.
 * We use TUS exclusively in this action — it's strictly better for the
 * multi-GB archives this tool typically uploads.
 */
interface SignedUpload {
  kind: UploadKind;
  tusEndpoint: string;
  bucketName: string;
  objectName: string;
  token: string;
  signedUrl: string;
}

interface UploadsResponse {
  success: boolean;
  uploads?: SignedUpload[];
  error?: string;
}

interface SubmitResponse {
  success: boolean;
  message?: string;
  error?: string;
  gameId?: string;
  isUpdate?: boolean;
}

interface ErrorBody {
  error?: string;
  message?: string;
}

export interface ApiClient {
  requestSignedUploadUrls(args: SignedUrlsArgs): Promise<SignedUpload[]>;
  uploadFile(upload: SignedUpload, filePath: string): Promise<void>;
  submitMetadata(args: SubmitArgs): Promise<SubmitResponse>;
}

export interface SignedUrlsArgs {
  gameId: string;
  version: string;
  kinds: UploadKind[];
}

export interface SubmitArgs extends SignedUrlsArgs {
  status?: string;
  translationProgress?: number;
  editingProgress?: number;
}

// Supabase TUS implementation requires exactly 6 MiB chunks.
const TUS_CHUNK_SIZE = 6 * 1024 * 1024;

// Retry on transient network drops. Each value = ms delay before next attempt.
// 10 attempts up to ~1 minute backoff matches the admin web client.
const TUS_RETRY_DELAYS = [0, 1000, 3000, 5000, 10000, 15000, 20000, 30000, 45000, 60000];

export function createApiClient(baseUrl: string, apiToken: string): ApiClient {
  // Single axios instance for the authenticated JSON endpoints. TUS uploads
  // go to Supabase Storage on a different origin and use their own auth.
  const api: AxiosInstance = axios.create({
    baseURL: baseUrl,
    headers: { Authorization: `Bearer ${apiToken}` },
    timeout: 30_000,
    // Don't let axios throw on 4xx/5xx — we want to surface server error
    // bodies (which include human-readable Ukrainian messages) instead of
    // axios's generic "Request failed with status code 400".
    validateStatus: () => true,
  });

  return {
    async requestSignedUploadUrls(args) {
      const resp = await api.post<UploadsResponse | ErrorBody>(
        '/api/submit-via-token/uploads',
        args
      );
      const data = ensureOk<UploadsResponse>(resp, '/api/submit-via-token/uploads');
      if (!data.uploads) throw new Error('Server returned success but no uploads');
      // Defensive guard for older server builds — bail early instead of
      // calling tus.Upload with undefined fields.
      for (const u of data.uploads) {
        if (!u.tusEndpoint || !u.bucketName || !u.objectName || !u.token) {
          throw new Error(
            `Server returned upload entry without TUS fields for kind=${u.kind}. ` +
              'Server may be older than the lbk-deploy-translation v1.2+ contract.'
          );
        }
      }
      return data.uploads;
    },

    async uploadFile(upload, filePath) {
      const stats = statSync(filePath);
      // tus-js-client wants the stream + the total size to know when it's done.
      const stream = createReadStream(filePath);
      try {
        await new Promise<void>((resolve, reject) => {
          const tusUpload = new tus.Upload(stream, {
            endpoint: upload.tusEndpoint,
            uploadSize: stats.size,
            chunkSize: TUS_CHUNK_SIZE,
            retryDelays: TUS_RETRY_DELAYS,
            uploadDataDuringCreation: true,
            // No persistent fingerprinting in CI — each run starts fresh.
            removeFingerprintOnSuccess: true,
            headers: {
              // `x-signature` carries the token from createSignedUploadUrl;
              // Supabase accepts this in place of a Bearer JWT for resumable
              // uploads. `x-upsert` lets a retry overwrite a partial blob.
              'x-signature': upload.token,
              'x-upsert': 'true',
            },
            metadata: {
              bucketName: upload.bucketName,
              objectName: upload.objectName,
              contentType: 'application/zip',
              cacheControl: '3600',
            },
            onError: (err) => reject(new Error(`TUS upload failed: ${err.message}`)),
            onSuccess: () => resolve(),
          });
          tusUpload.start();
        });
      } finally {
        stream.destroy();
      }
    },

    async submitMetadata(args) {
      const body: Record<string, unknown> = {
        version: args.version,
        kinds: args.kinds,
      };
      // Omit fields user didn't provide — sending `null` would wipe the
      // existing DB column. Server treats missing fields as "don't touch".
      if (args.status !== undefined) body.status = args.status;
      if (args.translationProgress !== undefined) {
        body.translation_progress = args.translationProgress;
      }
      if (args.editingProgress !== undefined) body.editing_progress = args.editingProgress;

      const url = `/api/submit-via-token/games/${args.gameId}`;
      const resp = await api.put<SubmitResponse | ErrorBody>(url, body, {
        timeout: 5 * 60 * 1000, // 5m — submit triggers full server pipeline
      });
      return ensureOk<SubmitResponse>(resp, url);
    },
  };
}

/**
 * Throw a single, well-formatted error for non-2xx OR `{success: false}`
 * responses. Lifts the server's `error`/`message` body field into the thrown
 * message so the action log shows what actually went wrong.
 */
function ensureOk<T extends { success: boolean; error?: string; message?: string }>(
  resp: { status: number; statusText: string; data: T | ErrorBody; config: { url?: string } },
  fallbackUrl: string
): T {
  const url = resp.config.url ?? fallbackUrl;
  if (resp.status >= 200 && resp.status < 300 && (resp.data as T).success) {
    return resp.data as T;
  }
  const body = resp.data as ErrorBody;
  const msg = body.error ?? body.message ?? resp.statusText;
  throw new Error(`${resp.status} ${url} → ${msg}`);
}
