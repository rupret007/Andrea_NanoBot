import fs from 'fs';

import {
  getAlexaInteractionModelPath,
  getAlexaModelSyncStatus,
  markAlexaInteractionModelSynced,
} from '../src/alexa-model-sync-state.js';
import { emitStatus } from './status.js';

type AlexaModelSyncAction = 'status' | 'mark-synced' | '';

function parseAction(args: string[]): AlexaModelSyncAction {
  const action = (args[0] || '').trim().toLowerCase();
  if (action === 'status' || action === 'mark-synced') {
    return action;
  }
  return '';
}

function emitAlexaModelSyncStatus(action: AlexaModelSyncAction): void {
  const modelPath = getAlexaInteractionModelPath(process.cwd());
  if (!fs.existsSync(modelPath)) {
    emitStatus('ALEXA_MODEL_SYNC', {
      ACTION: action || 'status',
      STATUS: 'failed',
      ERROR: `missing_interaction_model:${modelPath}`,
    });
    process.exit(1);
  }

  const current = action === 'mark-synced'
    ? markAlexaInteractionModelSynced({
        projectRoot: process.cwd(),
        syncedBy: 'setup/alexa-model-sync',
      })
    : null;
  const status = getAlexaModelSyncStatus(process.cwd());

  emitStatus('ALEXA_MODEL_SYNC', {
    ACTION: action || 'status',
    STATUS: 'success',
    INTERACTION_MODEL_PATH: status.interactionModelPath,
    INTERACTION_MODEL_HASH: status.interactionModelHash,
    SYNC_STATUS: status.syncStatus,
    LAST_SYNCED_HASH: status.lastSyncedHash,
    LAST_SYNCED_AT: status.lastSyncedAt,
    LAST_SYNCED_BY: status.lastSyncedBy,
    NEXT_ACTION:
      status.syncStatus === 'pending'
        ? 'After importing docs/alexa/interaction-model.en-US.json in the Alexa Developer Console and running Build Model, run npm run setup -- --step alexa-model-sync mark-synced.'
        : 'none',
    UPDATED_AT: current?.syncedAt || 'none',
  });
}

export async function run(args: string[]): Promise<void> {
  const action = parseAction(args);
  if (!action) {
    emitStatus('ALEXA_MODEL_SYNC', {
      STATUS: 'failed',
      ERROR:
        'usage: npm run setup -- --step alexa-model-sync status | mark-synced',
    });
    process.exit(4);
  }

  emitAlexaModelSyncStatus(action);
}
