interface PredicateForm {
  concept: string;
  inherentPolarity: 1 | -1;
}

interface PredicateMention extends PredicateForm {
  polarity: 1 | -1;
  scopeTokens: Set<string>;
}

const PREDICATE_FORMS = new Map<string, PredicateForm>();

function registerPredicateForms(
  concept: string,
  positive: string[],
  negative: string[] = [],
): void {
  for (const form of positive) {
    PREDICATE_FORMS.set(form, { concept, inherentPolarity: 1 });
  }
  for (const form of negative) {
    PREDICATE_FORMS.set(form, { concept, inherentPolarity: -1 });
  }
}

registerPredicateForms(
  'confirm',
  ['confirm', 'confirms', 'confirmed', 'confirming', 'confirmation'],
  ['unconfirmed'],
);
registerPredicateForms(
  'decide',
  ['decide', 'decides', 'decided', 'deciding', 'decision'],
  ['undecided'],
);
registerPredicateForms(
  'agree',
  ['agree', 'agrees', 'agreed', 'agreeing', 'agreement'],
  ['disagree', 'disagrees', 'disagreed', 'disagreement'],
);
registerPredicateForms(
  'approve',
  ['approve', 'approves', 'approved', 'approving', 'approval'],
  ['unapproved', 'disapproved'],
);
registerPredicateForms('book', ['book', 'books', 'booked', 'booking']);
registerPredicateForms(
  'schedule',
  ['schedule', 'schedules', 'scheduled', 'scheduling'],
  ['unscheduled'],
);
registerPredicateForms('cancel', [
  'cancel',
  'cancels',
  'canceled',
  'cancelled',
  'canceling',
  'cancelling',
  'cancellation',
]);
registerPredicateForms(
  'pay',
  ['pay', 'pays', 'paid', 'paying', 'payment'],
  ['unpaid'],
);
registerPredicateForms(
  'send',
  ['send', 'sends', 'sent', 'sending'],
  ['unsent'],
);
registerPredicateForms(
  'complete',
  ['complete', 'completes', 'completed', 'completing', 'completion'],
  ['incomplete', 'uncompleted'],
);
registerPredicateForms(
  'finish',
  ['finish', 'finishes', 'finished', 'finishing'],
  ['unfinished'],
);
registerPredicateForms(
  'resolve',
  ['resolve', 'resolves', 'resolved', 'resolving', 'resolution'],
  ['unresolved'],
);
registerPredicateForms(
  'handle',
  ['handle', 'handles', 'handled', 'handling'],
  ['unhandled'],
);
registerPredicateForms(
  'answer',
  ['answer', 'answers', 'answered', 'answering'],
  ['unanswered'],
);
registerPredicateForms('respond', [
  'respond',
  'responds',
  'responded',
  'responding',
  'response',
]);
registerPredicateForms(
  'available',
  ['available', 'availability'],
  ['unavailable'],
);
registerPredicateForms('possible', ['possible', 'possibility'], ['impossible']);
registerPredicateForms(
  'needed',
  ['need', 'needs', 'needed', 'require', 'requires', 'required'],
  ['unneeded', 'unnecessary'],
);
registerPredicateForms('work', ['work', 'works', 'worked', 'working']);
registerPredicateForms('want', ['want', 'wants', 'wanted', 'wanting']);
registerPredicateForms(
  'know',
  ['know', 'knows', 'knew', 'known', 'knowing'],
  ['unknown'],
);
registerPredicateForms(
  'like',
  ['like', 'likes', 'liked', 'liking'],
  ['dislike', 'dislikes', 'disliked'],
);
registerPredicateForms('accept', [
  'accept',
  'accepts',
  'accepted',
  'accepting',
]);
registerPredicateForms('decline', [
  'decline',
  'declines',
  'declined',
  'declining',
]);
registerPredicateForms('reject', [
  'reject',
  'rejects',
  'rejected',
  'rejecting',
]);
registerPredicateForms('commit', [
  'commit',
  'commits',
  'committed',
  'committing',
  'commitment',
]);
registerPredicateForms('promise', [
  'promise',
  'promises',
  'promised',
  'promising',
]);
registerPredicateForms('delay', ['delay', 'delays', 'delayed', 'delaying']);
registerPredicateForms('due', ['due', 'overdue']);

const NEGATION_TOKENS = new Set([
  'no',
  'not',
  'never',
  'neither',
  'nor',
  'without',
  'hardly',
  'rarely',
  'cannot',
]);

const NEGATING_VERBS = new Set([
  'fail',
  'fails',
  'failed',
  'failing',
  'refuse',
  'refuses',
  'refused',
  'refusing',
]);

const SCOPE_STOPWORDS = new Set([
  'about',
  'after',
  'again',
  'also',
  'and',
  'are',
  'been',
  'before',
  'being',
  'but',
  'can',
  'could',
  'did',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'into',
  'its',
  'may',
  'might',
  'nor',
  'not',
  'now',
  'only',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'they',
  'this',
  'was',
  'were',
  'will',
  'with',
  'would',
  'yet',
]);

function normalizeForPolarity(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\bcan['’]?t\b/g, 'can not')
    .replace(/\bwon['’]?t\b/g, 'will not')
    .replace(
      /\b(?:isn|aren|wasn|weren|hasn|haven|hadn|didn|doesn|don|shouldn|wouldn|couldn)['’]?t\b/g,
      (match) => {
        const stem = match.replace(/['’]?t$/i, '');
        const auxiliaries: Record<string, string> = {
          isn: 'is',
          aren: 'are',
          wasn: 'was',
          weren: 'were',
          hasn: 'has',
          haven: 'have',
          hadn: 'had',
          didn: 'did',
          doesn: 'does',
          don: 'do',
          shouldn: 'should',
          wouldn: 'would',
          couldn: 'could',
        };
        return `${auxiliaries[stem] || stem} not`;
      },
    );
}

function tokenize(value: string): string[] {
  return value.match(/[a-z0-9]+/g) || [];
}

function clauseTexts(value: string): string[] {
  return normalizeForPolarity(value)
    .split(
      /[.!?;\n]+|\b(?:although|but|however|instead|nevertheless|though|whereas|yet)\b/g,
    )
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function hasLocalNegation(tokens: string[], predicateIndex: number): boolean {
  const start = Math.max(0, predicateIndex - 5);
  for (let index = predicateIndex - 1; index >= start; index -= 1) {
    const token = tokens[index] || '';
    if (token === 'only' && tokens[index - 1] === 'not') {
      index -= 1;
      continue;
    }
    if (NEGATION_TOKENS.has(token) || NEGATING_VERBS.has(token)) return true;
  }
  return false;
}

function mentionScopeTokens(
  tokens: string[],
  start: number,
  end: number,
): Set<string> {
  return new Set(
    tokens.slice(start, end).filter((token) => {
      if (token.length < 3) return false;
      if (SCOPE_STOPWORDS.has(token) || NEGATION_TOKENS.has(token))
        return false;
      if (NEGATING_VERBS.has(token) || PREDICATE_FORMS.has(token)) return false;
      return !/^\d+$/.test(token);
    }),
  );
}

function extractPredicateMentions(value: string): PredicateMention[] {
  const result: PredicateMention[] = [];
  for (const clause of clauseTexts(value)) {
    const tokens = tokenize(clause);
    const rawMentions = tokens
      .map((token, index) => ({ index, form: PREDICATE_FORMS.get(token) }))
      .filter((entry): entry is { index: number; form: PredicateForm } =>
        Boolean(entry.form),
      );
    for (let position = 0; position < rawMentions.length; position += 1) {
      const current = rawMentions[position]!;
      const previous = rawMentions[position - 1];
      const next = rawMentions[position + 1];
      const start = previous
        ? Math.floor((previous.index + current.index) / 2) + 1
        : 0;
      const end = next
        ? Math.floor((current.index + next.index) / 2) + 1
        : tokens.length;
      const explicitlyNegated = hasLocalNegation(tokens, current.index);
      const polarity = (
        explicitlyNegated
          ? -current.form.inherentPolarity
          : current.form.inherentPolarity
      ) as 1 | -1;
      result.push({
        ...current.form,
        polarity,
        scopeTokens: mentionScopeTokens(tokens, start, end),
      });
    }
  }
  return result;
}

function intersectionSize(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const token of left) {
    if (right.has(token)) count += 1;
  }
  return count;
}

/**
 * Detects a provider claim that reuses a grounded state predicate while
 * removing, adding, or inverting the evidence's polarity for the same local
 * subject/object scope. This is deliberately a rejection check, not a general
 * entailment engine; ordinary token and high-impact-fact grounding still run
 * alongside it.
 */
export function hasMessagesGroundingPolarityConflict(input: {
  claimText: string;
  evidenceText: string;
}): boolean {
  const claimMentions = extractPredicateMentions(input.claimText);
  if (claimMentions.length === 0) return false;
  const evidenceMentions = extractPredicateMentions(input.evidenceText);

  for (const claim of claimMentions) {
    const samePredicate = evidenceMentions.filter(
      (candidate) => candidate.concept === claim.concept,
    );
    if (samePredicate.length === 0) continue;

    const overlaps = samePredicate.map((candidate) => ({
      candidate,
      overlap: intersectionSize(claim.scopeTokens, candidate.scopeTokens),
    }));
    const maximumOverlap = Math.max(...overlaps.map((entry) => entry.overlap));
    if (
      maximumOverlap === 0 &&
      claim.scopeTokens.size > 0 &&
      overlaps.every((entry) => entry.candidate.scopeTokens.size > 0)
    ) {
      continue;
    }
    const relevant = overlaps
      .filter(
        (entry) => maximumOverlap === 0 || entry.overlap === maximumOverlap,
      )
      .map((entry) => entry.candidate);
    const matchingPolarity = relevant.some(
      (candidate) => candidate.polarity === claim.polarity,
    );
    const inversePolarity = relevant.some(
      (candidate) => candidate.polarity !== claim.polarity,
    );
    if (inversePolarity && !matchingPolarity) return true;
    if (inversePolarity && matchingPolarity) return true;
  }
  return false;
}
