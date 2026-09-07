import { decodeMessageId } from '@nulab/chat-adapter-backlog';
import { z } from 'zod';

/**
 * Backlog's three default priorities, which the severity proposal is phrased
 * in so that a reader can apply it by picking the priority of the same name.
 */
export const SEVERITY_LEVELS = ['High', 'Normal', 'Low'] as const;

/** The headings the model must fill in, in order. */
export const REPORT_SECTIONS = [
  'Summary',
  'What the report has',
  'What is missing',
  'Questions for the reporter',
  'Suggested severity',
] as const;

/** The five facts a bug report is triaged against. */
export const EXPECTED_DETAILS = [
  'reproduction steps',
  'expected result',
  'actual result',
  'environment',
  'affected scope',
] as const;

/**
 * Whether this message is an issue's body rather than a comment on one.
 *
 * The part is read off the message id instead of `raw`, because the id is
 * where the adapter has already made the distinction: a type-1 delivery is
 * tagged `root`, while a status change on the issue page is `comment` or
 * `update`. The subject kind is checked too — a pull request being opened is
 * also a `root`, and this bot triages issues.
 */
export function isIssueRoot(messageId: string): boolean {
  const decoded = decodeMessageId(messageId);
  return decoded.part === 'root' && decoded.subject.kind === 'issue';
}

const change = z.object({
  field: z.string(),
  newValue: z.string().nullable(),
});

/**
 * The two delivery shapes that can carry a status change, parsed out of
 * `message.raw` — which reaches a handler as `unknown`.
 *
 * Both are accepted: a type-2 update from the issue's own page, and a
 * `bulkUpdate` fanned out of a type 14 from the issue list. Nothing else
 * parses, which is the point — the `status` entry of a REST change log holds
 * a display name where a webhook holds an id, so letting it through would
 * compare the wrong thing.
 */
const statusChangeDelivery = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bulkUpdate'), changes: z.array(change) }),
  z.object({
    kind: z.literal('webhook'),
    payload: z.object({ type: z.literal(2) }),
    changes: z.array(change),
  }),
]);

export function movedToDoneStatus(raw: unknown, doneStatusId: number): boolean {
  const parsed = statusChangeDelivery.safeParse(raw);
  return (
    parsed.success &&
    parsed.data.changes.some(
      (entry) =>
        entry.field === 'status' && entry.newValue === String(doneStatusId)
    )
  );
}

export interface IntakePromptInput {
  summary: string;
  description: string;
}

export interface IntakePrompt {
  system: string;
  prompt: string;
}

/**
 * The system prompt states the job — first-line intake of a bug report — and
 * then states what intake is *not*. Both halves are load-bearing: asked only
 * to "triage a bug report", a model volunteers a probable cause and a patch,
 * which reads as an answer and stops the reporter filling in the report.
 */
export function buildIntakePrompt(input: IntakePromptInput): IntakePrompt {
  const system = [
    'You are the first-line intake desk for bug reports in a Backlog project.',
    'You are accepting this report, not solving it. Your job is to acknowledge it, say what the report already contains, ask for what it is missing, and propose a severity.',
    '',
    "Never speculate about the cause of the bug, and never suggest a change, a patch or a workaround. That is the assignee's work later, and guessing at it here tells the reporter the report is already complete.",
    '',
    `Judge the report against exactly these five details: ${EXPECTED_DETAILS.join(', ')}.`,
    `Propose exactly one severity from ${SEVERITY_LEVELS.join(', ')}, which are the project's priority names, and give the reason in one clause.`,
    '',
    'Answer in the language the report is written in.',
    'Reply with Markdown in exactly this shape, keeping the headings verbatim and the whole reply under 30 lines:',
    '',
    `**${REPORT_SECTIONS[0]}**`,
    'One sentence restating what is reported.',
    '',
    `**${REPORT_SECTIONS[1]}**`,
    '- One bullet per detail the report does contain.',
    '',
    `**${REPORT_SECTIONS[2]}**`,
    '- One bullet per detail the report does not contain, or "Nothing — this report is complete." if none are missing.',
    '',
    `**${REPORT_SECTIONS[3]}**`,
    '- One direct question per missing detail, addressed to the reporter, or "None." if nothing is missing.',
    '',
    `**${REPORT_SECTIONS[4]}**`,
    'The level, then the reason.',
  ].join('\n');

  const prompt = [
    `Subject: ${input.summary}`,
    '',
    'Description:',
    input.description.trim().length > 0
      ? input.description
      : '(the reporter left the description empty)',
  ].join('\n');

  return { system, prompt };
}

/**
 * Posted verbatim when the model call fails or comes back empty. It asks for
 * the same five details the prompt does, so a reporter who hits an AI outage
 * still learns what a usable report needs.
 */
export const INTAKE_FALLBACK_BODY =
  'Thanks for the report. Please make sure it has reproduction steps, expected and actual results, and the environment.';

/** A mention, then the intake body as the model wrote it. */
export function intakeComment(reporterMention: string, body: string): string {
  return `${reporterMention}\n\n${body}`;
}

export function handOffComment(
  contactMention: string,
  closedByName: string
): string {
  return `${contactMention}\n\nMarked done by ${closedByName}. Handing it to you for confirmation.`;
}

/** The model call, as a parameter so the failure handling can be read on its own. */
export type IntakeWriter = (prompt: IntakePrompt) => Promise<string>;

/**
 * The intake body, or {@link INTAKE_FALLBACK_BODY} if the model could not
 * produce one.
 *
 * An empty answer is treated as a failure alongside a thrown one: a comment
 * consisting of a bare mention reads as the bot having nothing to say, which
 * is worse for the reporter than the fixed text.
 */
export async function writeIntakeBody(
  prompt: IntakePrompt,
  write: IntakeWriter,
  onFailure: (reason: unknown) => void
): Promise<string> {
  try {
    const body = await write(prompt);
    if (body.trim().length === 0) {
      onFailure(new Error('the model returned an empty intake body'));
      return INTAKE_FALLBACK_BODY;
    }
    return body.trim();
  } catch (reason) {
    onFailure(reason);
    return INTAKE_FALLBACK_BODY;
  }
}
