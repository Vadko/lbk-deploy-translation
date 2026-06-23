import { statSync } from 'node:fs';
import * as core from '@actions/core';
import pMap from 'p-map';
import prettyBytes from 'pretty-bytes';
import { createApiClient } from './api';
import { parseInputs } from './inputs';

export async function run(): Promise<void> {
  try {
    const inputs = parseInputs();
    const kinds = [...inputs.files.keys()];
    const api = createApiClient(inputs.baseUrl, inputs.apiToken);

    // Sanity-check files exist BEFORE asking the server for signed URLs —
    // otherwise we'd allocate slots then fail mid-upload and leave orphans
    // in storage.
    for (const [kind, path] of inputs.files) {
      try {
        const st = statSync(path);
        if (!st.isFile()) throw new Error('not a regular file');
        core.info(`${kind}: ${path} (${prettyBytes(st.size)})`);
      } catch (e) {
        throw new Error(`${kind}: cannot read "${path}" — ${(e as Error).message}`);
      }
    }

    core.startGroup('Request signed upload URLs');
    const uploads = await api.requestSignedUploadUrls({
      gameId: inputs.gameId,
      version: inputs.version,
      kinds,
    });
    core.info(`Got ${uploads.length} signed URL(s)`);
    core.endGroup();

    core.startGroup('Upload archives');
    const t0 = Date.now();
    await pMap(
      uploads,
      async (u) => {
        const path = inputs.files.get(u.kind);
        if (!path) {
          // Defensive: server only returns URLs for kinds we asked for.
          throw new Error(`Server returned URL for unknown kind: ${u.kind}`);
        }
        core.info(`${u.kind} → TUS upload`);
        await api.uploadFile(u, path);
        core.info(`${u.kind} ✓`);
      },
      // 8 max in parallel = max number of kinds. No throttling needed; we
      // want every available channel saturated.
      { concurrency: uploads.length, stopOnError: true }
    );
    core.info(`All uploads complete in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    core.endGroup();

    core.startGroup('Submit metadata');
    const resp = await api.submitMetadata({
      gameId: inputs.gameId,
      version: inputs.version,
      kinds,
      status: inputs.status,
      translationProgress: inputs.translationProgress,
      editingProgress: inputs.editingProgress,
    });
    core.info(resp.message ?? 'Submitted.');
    core.endGroup();

    core.setOutput('game-id', inputs.gameId);
    core.info(`✅ Deployed translation v${inputs.version} for game ${inputs.gameId}`);
  } catch (e) {
    core.setFailed(e instanceof Error ? e.message : String(e));
  }
}
