import {
  planSimpleReminder,
  type ReminderOperationIdentity,
} from './local-reminder.js';

export interface CompoundReminderResearchPlan {
  reminderText: string;
  researchText: string;
  requestedDepth: 'standard' | 'deep';
  allowWebSearch: true;
  explicitMaxEffort: boolean;
}

const RESEARCH_CLAUSE =
  /^(?:also\s+)?(?:look\s+(?:up|into)|research|investigate|compare|find|recommend|kick\s+off\s+(?:some\s+)?research|start\s+(?:some\s+)?research)\b/i;
const MAX_EFFORT =
  /\b(?:all (?:the )?(?:available )?resources|everything|ultrathink|deep dive|thoroughly|comprehensively)\b/i;

/**
 * Split only an already-valid explicit reminder from an unmistakable research
 * clause. This intentionally leaves ambiguous conjunctions to ordinary chat.
 */
export function planCompoundReminderResearchRequest(
  text: string,
  groupFolder: string,
  chatJid: string,
  now: Date,
  identity?: ReminderOperationIdentity,
): CompoundReminderResearchPlan | null {
  for (const boundary of text.matchAll(/,?\s+and\s+/gi)) {
    const index = boundary.index;
    if (index === undefined) continue;
    const reminderText = text.slice(0, index).trim();
    const researchText = text.slice(index + boundary[0].length).trim();
    if (!RESEARCH_CLAUSE.test(researchText)) continue;
    if (
      !planSimpleReminder(reminderText, groupFolder, chatJid, now, identity)
    ) {
      continue;
    }
    const explicitMaxEffort = MAX_EFFORT.test(researchText);
    return {
      reminderText,
      researchText,
      requestedDepth: explicitMaxEffort ? 'deep' : 'standard',
      allowWebSearch: true,
      explicitMaxEffort,
    };
  }
  return null;
}
