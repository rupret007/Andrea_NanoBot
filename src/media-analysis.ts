import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

import {
  getMessageMediaAttachment,
  listMessageMediaAttachments,
  upsertMessageMediaAttachment,
} from './db.js';
import { ANDREA_MEDIA_ANALYSIS_MAX_INPUT_BYTES } from './config.js';
import {
  buildDerivedMediaDir,
  getUsableCachedMediaFile,
  pruneMediaCache,
} from './media-cache.js';
import {
  resolveOpenAiProviderConfig,
  type OpenAiProviderStatus,
  getOpenAiProviderStatus,
} from './openai-provider.js';
import {
  getGeminiProviderStatus,
  resolveGeminiProviderConfig,
  type GeminiProviderStatus,
} from './gemini-provider.js';
import { providerRequestSignal } from './provider-http.js';
import type { MessageMediaAttachment } from './types.js';

type FetchLike = typeof fetch;

const require = createRequire(import.meta.url);
export interface MediaAnalysisInput {
  chatJid?: string;
  messageId?: string;
  attachmentIds?: string[];
  prompt?: string;
  requester?: 'andrea' | 'openclaw' | 'control_api';
  fetchImpl?: FetchLike;
}

export interface MediaAnalysisResult {
  handled: boolean;
  providerStatus: OpenAiProviderStatus;
  providerStatuses?: {
    openai: OpenAiProviderStatus;
    gemini: GeminiProviderStatus;
  };
  providerUsed?: 'openai_vision' | 'gemini_vision';
  summaryText?: string;
  blocker?: string;
  debugPath: string[];
  attachments: MessageMediaAttachment[];
}

function extractResponseOutputText(payload: unknown): string {
  const record =
    payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>)
      : {};
  if (typeof record.output_text === 'string' && record.output_text.trim()) {
    return record.output_text.trim();
  }
  const output = Array.isArray(record.output) ? record.output : [];
  const parts: string[] = [];
  for (const item of output) {
    const itemRecord =
      item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const content = Array.isArray(itemRecord.content) ? itemRecord.content : [];
    for (const chunk of content) {
      const chunkRecord =
        chunk && typeof chunk === 'object'
          ? (chunk as Record<string, unknown>)
          : {};
      if (
        chunkRecord.type === 'output_text' &&
        typeof chunkRecord.text === 'string'
      ) {
        parts.push(chunkRecord.text);
      }
    }
  }
  return parts.join('\n').trim();
}

function extractOpenAiCompatibleChatText(payload: unknown): string {
  const record =
    payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>)
      : {};
  const choices = Array.isArray(record.choices) ? record.choices : [];
  return choices
    .map((choice) => {
      if (!choice || typeof choice !== 'object') return '';
      const message = (choice as Record<string, unknown>).message;
      if (!message || typeof message !== 'object') return '';
      const content = (message as Record<string, unknown>).content;
      return typeof content === 'string' ? content.trim() : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function resolveOptionalStaticPath(packageName: string): string | null {
  try {
    const loaded = require(packageName) as unknown;
    if (typeof loaded === 'string') return loaded;
    if (loaded && typeof loaded === 'object' && 'path' in loaded) {
      const maybePath = (loaded as { path?: unknown }).path;
      return typeof maybePath === 'string' ? maybePath : null;
    }
  } catch {
    return null;
  }
  return null;
}

function probeVideoDurationMs(localPath: string): number | null {
  const ffprobe = resolveOptionalStaticPath('ffprobe-static');
  if (!ffprobe) return null;
  try {
    const stdout = execFileSync(
      ffprobe,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'json',
        localPath,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );
    const parsed = JSON.parse(stdout) as { format?: { duration?: string } };
    const seconds = Number.parseFloat(parsed.format?.duration || '');
    return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
  } catch {
    return null;
  }
}

function sampleVideoFrames(
  attachment: MessageMediaAttachment,
): Array<{ localPath: string; mimeType: string; filename: string }> {
  const source = getUsableCachedMediaFile(attachment.localPath);
  if (!source) return [];
  const ffmpeg = resolveOptionalStaticPath('ffmpeg-static');
  if (!ffmpeg) return [];
  const hash =
    attachment.contentHash ||
    attachment.attachmentId.replace(/[^a-z0-9]/gi, '').slice(0, 32);
  const dir = buildDerivedMediaDir(hash || 'video');
  fs.mkdirSync(dir, { recursive: true });
  const pattern = path.join(dir, 'frame-%03d.jpg');
  try {
    execFileSync(
      ffmpeg,
      [
        '-y',
        '-i',
        source.localPath,
        '-vf',
        'fps=1/2,scale=1024:-1',
        '-frames:v',
        '8',
        pattern,
      ],
      { stdio: 'ignore', timeout: 30_000 },
    );
  } catch {
    return [];
  }
  pruneMediaCache();
  return fs
    .readdirSync(dir)
    .filter((name) => /^frame-\d+\.jpg$/i.test(name))
    .sort()
    .slice(0, 8)
    .flatMap((name) => {
      const cached = getUsableCachedMediaFile(path.join(dir, name));
      return cached
        ? [
            {
              localPath: cached.localPath,
              mimeType: 'image/jpeg',
              filename: name,
            },
          ]
        : [];
    });
}

type LocalImageInput = {
  localPath: string;
  mimeType: string;
  filename: string;
  sizeBytes: number;
};

function localImageInputs(attachments: MessageMediaAttachment[]): {
  inputs: LocalImageInput[];
  skippedTooLarge: boolean;
  skippedUnavailable: boolean;
} {
  const candidates: LocalImageInput[] = [];
  let skippedTooLarge = false;
  let skippedUnavailable = false;
  for (const attachment of attachments) {
    if (attachment.kind === 'image') {
      const cached = getUsableCachedMediaFile(attachment.localPath);
      if (!cached) {
        skippedUnavailable = true;
        continue;
      }
      candidates.push({
        localPath: cached.localPath,
        mimeType: attachment.mimeType || 'image/jpeg',
        filename: attachment.filename || `${attachment.attachmentId}.jpg`,
        sizeBytes: cached.sizeBytes,
      });
      continue;
    }
    if (attachment.kind === 'video') {
      const source = getUsableCachedMediaFile(attachment.localPath);
      if (!source) {
        skippedUnavailable = true;
        continue;
      }
      const frames = sampleVideoFrames({
        ...attachment,
        localPath: source.localPath,
      });
      if (frames.length === 0) skippedUnavailable = true;
      for (const frame of frames) {
        const cached = getUsableCachedMediaFile(frame.localPath);
        if (!cached) {
          skippedUnavailable = true;
          continue;
        }
        candidates.push({
          ...frame,
          localPath: cached.localPath,
          sizeBytes: cached.sizeBytes,
        });
      }
      const durationMs =
        attachment.durationMs || probeVideoDurationMs(source.localPath);
      if (durationMs && durationMs !== attachment.durationMs) {
        upsertMessageMediaAttachment({
          ...attachment,
          durationMs,
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }

  const inputs: LocalImageInput[] = [];
  let totalBytes = 0;
  for (const candidate of candidates.slice(0, 12)) {
    if (
      totalBytes + candidate.sizeBytes >
      ANDREA_MEDIA_ANALYSIS_MAX_INPUT_BYTES
    ) {
      skippedTooLarge = true;
      continue;
    }
    inputs.push(candidate);
    totalBytes += candidate.sizeBytes;
  }
  return { inputs, skippedTooLarge, skippedUnavailable };
}

function markAnalysisStatus(
  attachments: MessageMediaAttachment[],
  analysisStatus: 'analyzed' | 'failed',
): void {
  const updatedAt = new Date().toISOString();
  for (const attachment of attachments) {
    upsertMessageMediaAttachment({
      ...attachment,
      analysisStatus,
      updatedAt,
    });
  }
}

function selectAttachments(
  input: MediaAnalysisInput,
): MessageMediaAttachment[] {
  if (input.attachmentIds?.length) {
    return input.attachmentIds
      .map((attachmentId) => getMessageMediaAttachment(attachmentId))
      .filter((item): item is MessageMediaAttachment => Boolean(item));
  }
  if (input.chatJid && input.messageId) {
    return listMessageMediaAttachments({
      chatJid: input.chatJid,
      messageId: input.messageId,
      limit: 20,
    });
  }
  return [];
}

export async function analyzeMessageMedia(
  input: MediaAnalysisInput,
): Promise<MediaAnalysisResult> {
  const status = getOpenAiProviderStatus();
  const config = resolveOpenAiProviderConfig();
  const geminiStatus = getGeminiProviderStatus();
  const geminiConfig = resolveGeminiProviderConfig();
  const providerStatuses = { openai: status, gemini: geminiStatus };
  const attachments = selectAttachments(input).filter((attachment) =>
    ['image', 'video'].includes(attachment.kind),
  );
  const debugPath = [
    `media.analysis:requester=${input.requester || 'andrea'}`,
    `media.analysis:attachments=${attachments.length}`,
  ];
  if (attachments.length === 0) {
    return {
      handled: false,
      providerStatus: status,
      providerStatuses,
      blocker: 'No image or video attachments were available to analyze.',
      debugPath,
      attachments: [],
    };
  }
  if (!config && !geminiConfig) {
    return {
      handled: false,
      providerStatus: status,
      providerStatuses,
      blocker:
        'Media analysis needs a configured OpenAI or Gemini vision provider on this host.',
      debugPath: [...debugPath, 'media.analysis:provider_missing'],
      attachments,
    };
  }

  const localInputs = localImageInputs(attachments);
  if (localInputs.inputs.length === 0) {
    return {
      handled: false,
      providerStatus: status,
      providerStatuses,
      blocker: localInputs.skippedTooLarge
        ? `The selected media exceeds Andrea's ${ANDREA_MEDIA_ANALYSIS_MAX_INPUT_BYTES}-byte analysis limit.`
        : 'The media metadata is present, but no cached image bytes or video frames are available for analysis yet.',
      debugPath: [
        ...debugPath,
        localInputs.skippedTooLarge
          ? 'media.analysis:input_too_large'
          : 'media.analysis:no_cached_frames',
        ...(localInputs.skippedUnavailable
          ? ['media.analysis:cache_unavailable']
          : []),
      ],
      attachments,
    };
  }

  const prompt =
    input.prompt ||
    'Analyze the attached image or video frames. Describe what is visible, call out uncertainty, and mention if this appears to be sampled video rather than a complete video review.';
  const content: Array<Record<string, unknown>> = [
    {
      type: 'input_text',
      text: [
        prompt,
        '',
        `Attachments: ${attachments
          .map((attachment) =>
            [
              attachment.kind,
              attachment.filename || attachment.attachmentId,
              attachment.durationMs ? `${attachment.durationMs}ms` : '',
            ]
              .filter(Boolean)
              .join(' '),
          )
          .join('; ')}`,
      ].join('\n'),
    },
  ];
  try {
    for (const image of localInputs.inputs) {
      const data = fs.readFileSync(image.localPath).toString('base64');
      content.push({
        type: 'input_image',
        image_url: `data:${image.mimeType};base64,${data}`,
      });
    }
  } catch {
    return {
      handled: false,
      providerStatus: status,
      providerStatuses,
      blocker:
        "The selected media is no longer available in Andrea's local cache.",
      debugPath: [...debugPath, 'media.analysis:cache_read_failed'],
      attachments,
    };
  }

  const fetchImpl = input.fetchImpl || fetch;
  const providerDebug: string[] = [];
  const providerBlockers: string[] = [];

  if (config) {
    try {
      const response = await fetchImpl(`${config.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.standardModel,
          input: [
            {
              role: 'user',
              content,
            },
          ],
          max_output_tokens: 700,
        }),
        signal: providerRequestSignal(),
      });
      const requestId = response.headers.get('x-request-id') || undefined;
      const payloadText = await response.text();
      if (!response.ok) {
        providerDebug.push(
          `media.analysis:provider_error:${response.status}`,
          requestId ? `request_id:${requestId}` : 'request_id:missing',
        );
        providerBlockers.push(
          `OpenAI media analysis is unavailable right now (HTTP ${response.status}).`,
        );
      } else {
        let payload: unknown;
        try {
          payload = JSON.parse(payloadText);
        } catch {
          providerDebug.push('media.analysis:invalid_provider_response');
          providerBlockers.push(
            'OpenAI media analysis returned an unreadable response.',
          );
        }
        const summaryText = payload ? extractResponseOutputText(payload) : '';
        if (summaryText) {
          markAnalysisStatus(attachments, 'analyzed');
          return {
            handled: true,
            providerStatus: status,
            providerStatuses,
            providerUsed: 'openai_vision',
            summaryText,
            debugPath: [
              ...debugPath,
              'media.analysis:provider=openai_vision',
              requestId ? `request_id:${requestId}` : 'request_id:missing',
            ],
            attachments,
          };
        }
        if (payload && !summaryText) {
          providerDebug.push('media.analysis:empty_response');
          providerBlockers.push(
            'OpenAI media analysis returned an empty response.',
          );
        }
      }
    } catch {
      providerDebug.push('media.analysis:provider_transport_failed');
      providerBlockers.push(
        'OpenAI media analysis is unavailable right now. Please try again later.',
      );
    }
  } else {
    providerDebug.push('media.analysis:openai_not_configured');
  }

  if (geminiConfig && geminiStatus.quotaState !== 'blocked') {
    const geminiContent = content.map((item) =>
      item.type === 'input_image'
        ? {
            type: 'image_url',
            image_url: { url: item.image_url },
          }
        : {
            type: 'text',
            text: item.text,
          },
    );
    try {
      const response = await fetchImpl(
        `${geminiConfig.openAiBaseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${geminiConfig.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: geminiConfig.fastModel,
            messages: [{ role: 'user', content: geminiContent }],
            max_tokens: 700,
          }),
          signal: providerRequestSignal(),
        },
      );
      const requestId =
        response.headers.get('x-request-id') ||
        response.headers.get('x-goog-request-id') ||
        undefined;
      const payloadText = await response.text();
      if (!response.ok) {
        providerDebug.push(
          `media.analysis:gemini_provider_error:${response.status}`,
          requestId
            ? `gemini_request_id:${requestId}`
            : 'gemini_request_id:missing',
        );
        providerBlockers.push(
          `Gemini media analysis is unavailable right now (HTTP ${response.status}).`,
        );
      } else {
        let payload: unknown;
        try {
          payload = JSON.parse(payloadText);
        } catch {
          providerDebug.push('media.analysis:gemini_invalid_provider_response');
          providerBlockers.push(
            'Gemini media analysis returned an unreadable response.',
          );
        }
        const summaryText = payload
          ? extractOpenAiCompatibleChatText(payload)
          : '';
        if (summaryText) {
          markAnalysisStatus(attachments, 'analyzed');
          return {
            handled: true,
            providerStatus: status,
            providerStatuses,
            providerUsed: 'gemini_vision',
            summaryText,
            debugPath: [
              ...debugPath,
              ...providerDebug,
              'media.analysis:provider=gemini_vision',
              requestId
                ? `gemini_request_id:${requestId}`
                : 'gemini_request_id:missing',
            ],
            attachments,
          };
        }
        if (payload && !summaryText) {
          providerDebug.push('media.analysis:gemini_empty_response');
          providerBlockers.push(
            'Gemini media analysis returned an empty response.',
          );
        }
      }
    } catch {
      providerDebug.push('media.analysis:gemini_provider_transport_failed');
      providerBlockers.push(
        'Gemini media analysis is unavailable right now. Please try again later.',
      );
    }
  } else if (geminiStatus.quotaState === 'blocked') {
    providerDebug.push('media.analysis:gemini_quota_blocked');
    providerBlockers.push(
      'Gemini media analysis is blocked by its current quota state.',
    );
  } else {
    providerDebug.push('media.analysis:gemini_not_configured');
  }

  markAnalysisStatus(attachments, 'failed');
  return {
    handled: false,
    providerStatus: status,
    providerStatuses,
    blocker:
      providerBlockers.join(' ') ||
      'Media analysis is unavailable right now. Please try again later.',
    debugPath: [...debugPath, ...providerDebug],
    attachments,
  };
}
