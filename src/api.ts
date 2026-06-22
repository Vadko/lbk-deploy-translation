import axios, { type AxiosInstance } from 'axios';
import { createReadStream, statSync } from 'node:fs';
import type { UploadKind } from './inputs';

interface SignedUpload {
  kind: UploadKind;
  signedUrl: string;
  token: string;
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
  uploadFile(signedUrl: string, filePath: string): Promise<void>;
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

export function createApiClient(baseUrl: string, apiToken: string): ApiClient {
  // Single axios instance for the authenticated JSON endpoints. Uploads go
  // to signed URLs on a different origin (R2) and need their own per-request
  // config — they bypass this instance.
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
      if (!data.uploads) throw new Error('Server returned success but no signed uploads');
      return data.uploads;
    },

    async uploadFile(signedUrl, filePath) {
      const size = statSync(filePath).size;
      const stream = createReadStream(filePath);
      try {
        const resp = await axios.put(signedUrl, stream, {
          headers: {
            'Content-Type': 'application/zip',
            'Content-Length': String(size),
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          timeout: 2 * 60 * 60 * 1000, // 2h cap, matches client TUS uploadTimeout
          validateStatus: (s) => s >= 200 && s < 300,
        });
        // axios validateStatus already throws on non-2xx, so reaching here = OK
        void resp;
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
