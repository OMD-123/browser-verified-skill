/**
 * The injection guard: detectors, the nonce envelope and sanitisation (M08).
 *
 * All page-derived text that leaves the process towards a model or the host
 * agent is wrapped in a nonce-tagged envelope. The nonce is regenerated per
 * call, and any occurrence of the nonce or a forged closing tag inside the
 * content is escaped.
 *
 * The detectors are **heuristic**. They are a speed bump and an evidence
 * source, not a trust boundary. Phase 6 measures them against a red-team pack
 * and publishes the misses.
 */
import { randomBytes } from 'node:crypto';

/** The severity of a finding. */
export type FindingSeverity = 'info' | 'warn' | 'review' | 'block';

/** The kinds of finding the detectors produce. */
export type FindingKind =
  | 'hidden-text'
  | 'aria-hidden-text'
  | 'html-comment'
  | 'invisible-characters'
  | 'attribute-instruction'
  | 'css-content'
  | 'instruction-phrase'
  | 'fake-system-banner'
  | 'base64-blob'
  | 'exfiltration-url'
  | 'suspicious-hidden-field';

/** One injection finding. */
export interface Finding {
  /** A stable id, e.g. `f-12`. */
  readonly id: string;
  /** What kind of finding it is. */
  readonly kind: FindingKind;
  /** How serious it is. */
  readonly severity: FindingSeverity;
  /** The text that triggered the finding. */
  readonly evidenceSnippet: string;
  /** The ref of the node it was found on, when known. */
  readonly nodeRef?: string;
}

/** The result of scanning content. */
export interface ScanResult {
  /** The findings, in the order they were detected. */
  readonly findings: readonly Finding[];
  /** The highest severity found. */
  readonly worstSeverity: FindingSeverity | undefined;
}

/** The severity ordering, from least to most serious. */
const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  info: 0,
  warn: 1,
  review: 2,
  block: 3,
};

/** Compare two severities. */
export function severityRank(severity: FindingSeverity): number {
  return SEVERITY_ORDER[severity];
}

/** The highest of a list of severities. */
export function worstSeverity(findings: readonly Finding[]): FindingSeverity | undefined {
  let worst: FindingSeverity | undefined;
  for (const finding of findings) {
    if (worst === undefined || severityRank(finding.severity) > severityRank(worst)) {
      worst = finding.severity;
    }
  }
  return worst;
}

// ---------------------------------------------------------------------------
// Instruction phrases
// ---------------------------------------------------------------------------

/**
 * Instruction-like phrases.
 *
 * The list is multilingual and extensible. It is deliberately a *signal*, not
 * a verdict: a page that legitimately contains the word "system" is not
 * attacked, but a page whose hidden text says "ignore previous instructions"
 * is flagged.
 */
export const DEFAULT_INSTRUCTION_PHRASES: readonly string[] = [
  // English
  //
  // The list is deliberately long and deliberately redundant. A phrase
  // detector that only catches one wording of an attack is not a detector.
  // The red-team suite in `test/redteam/guards.test.ts` is what keeps this
  // list honest: every phrase there has to be caught by one of these.
  'ignore previous',
  'ignore the previous',
  'ignore any previous',
  'ignore all previous',
  'ignore everything above',
  'ignore the above',
  'ignore the instructions',
  'ignore your instructions',
  'ignore prior',
  'ignore the prior',
  'disregard previous',
  'disregard the previous',
  'disregard the above',
  'forget previous',
  'forget the previous',
  'forget everything above',
  'forget all',
  'system prompt',
  'your system prompt',
  'the system prompt',
  'new instructions',
  'updated instructions',
  'additional instructions',
  'you must now',
  'you should now',
  'you must immediately',
  'you must run',
  'you are required to',
  'do not tell the user',
  "don't tell the user",
  'do not mention',
  'do not inform the user',
  'without telling the user',
  'without asking the user',
  'without informing the user',
  'reveal the',
  'reveal your',
  'reveal secret',
  'reveal your secret',
  'print your instructions',
  'show your instructions',
  'send this page to',
  'send the page to',
  'send the vault',
  'email this page to',
  'forward this page to',
  'post this to',
  'post the vault',
  'exfiltrate',
  'click the link below',
  'follow the link below',
  'approve this payment',
  'approve the following',
  'authorize this payment',
  'as the administrator',
  'system message',
  'system:',
  '[system',
  '<system',
  'important instruction',
  'critical instruction',
  'override your instructions',
  'override previous',
  'act as the administrator',
  'developer mode',
  'you are now',
  'your new role',
  'do not access',
  'bypass your',
  'bypass the',
];

/**
 * Phrases that indicate a fake system or admin banner.
 *
 * These are more specific than the general instruction list: they describe
 * the *presentation* of a fake message rather than its content.
 */
export const DEFAULT_FAKE_BANNER_PATTERNS: readonly RegExp[] = [
  /\b(system|admin|administrator|root|support|moderator|operator)\s*(message|notice|alert|warning|instruction|update)\b/i,
  /^\s*\[?(system|admin|root)\]?\s*[:-]/im,
  /\bimportant\s*[:-]\s*you\s+(must|should|need|have\s+to)/i,
  /\battention\s*[:-]\s*(the\s+)?(ai|assistant|agent|model|llm)\b/i,
  /\bnote\s+to\s+(the\s+)?(ai|assistant|agent|model|llm)\b/i,
  /\bfor\s+the\s+(ai|assistant|agent|model|llm)\s*(reading|processing)/i,
  /^\s*###\s*(system|instruction|admin)/im,
  /\bdo\s+not\s+follow\s+(the\s+)?(previous|prior|other)\s+(instruction|direction)/i,
];

/**
 * Instruction-like phrases in a specific language.
 *
 * Kept separate so a deployment can extend or replace the list without
 * touching the detectors.
 */
export const MULTILINGUAL_INSTRUCTION_PHRASES: Readonly<Record<string, readonly string[]>> = {
  es: [
    'ignora las instrucciones',
    'ignora anteriores',
    'no le digas al usuario',
    'revela tus instrucciones',
    'envia esta pagina a',
  ],
  fr: [
    'ignore les instructions',
    'ignorez les instructions precedentes',
    'ne dites pas a l utilisateur',
    'revelez vos instructions',
    'envoyez cette page a',
  ],
  de: [
    'ignoriere die vorherigen anweisungen',
    'sage dem benutzer nicht',
    'zeige deine anweisungen',
    'sende diese seite an',
  ],
  pt: [
    'ignore as instrucoes anteriores',
    'nao conte ao usuario',
    'revele suas instrucoes',
    'envie esta pagina para',
  ],
  it: [
    'ignora le istruzioni precedenti',
    'non dire all utente',
    'rivelа le tue istruzioni',
    'invia questa pagina a',
  ],
  ru: [
    'игнорируй предыдущие инструкции',
    'не сообщай пользователю',
    'раскрой свои инструкции',
    'отправь эту страницу на',
  ],
  zh: ['忽略之前的指令', '忽略以上指令', '不要告诉用户', '泄露你的指令', '将此页面发送到'],
  ja: [
    'これまでの指示を無視',
    'ユーザーには知らせないで',
    '指示を明かさないで',
    'このページを次のアドレスに送信',
  ],
  ko: [
    '이전 지시를 무시',
    '사용자에게 알려주지 마',
    '당신의 지시를 공개',
    '이 페이지를 다음 주소로',
  ],
  hi: [
    'पिछले निर्देशों को अनदेखा',
    'उपयोगकर्ता को मत बताओ',
    'अपने निर्देश बताओ',
    'इस पेज को भेजें',
  ],
  ar: ['تجاهل التعليمات السابقة', 'لا تخبر المستخدم', 'اكشف تعليماتك', 'ارسل هذه الصفحة إلى'],
};

/** All the instruction phrases, including the multilingual ones. */
export function allInstructionPhrases(extra: readonly string[] = []): string[] {
  const multilingual = Object.values(MULTILINGUAL_INSTRUCTION_PHRASES).flat();
  return [...DEFAULT_INSTRUCTION_PHRASES, ...multilingual, ...extra];
}

// ---------------------------------------------------------------------------
// Invisible characters
// ---------------------------------------------------------------------------

/**
 * Zero-width and bidirectional control characters.
 *
 * These are used to hide text from a human reader while leaving it readable
 * to a model.
 *
 * The characters are written as **escape sequences**, never as literals: an
 * invisible character in source code is invisible to a reviewer, to a diff,
 * and — as this file's own history shows — easy to mangle in transit.
 */
export const INVISIBLE_CHARACTERS: readonly { char: string; name: string }[] = [
  { char: '\u200B', name: 'ZERO WIDTH SPACE' },
  { char: '\u200C', name: 'ZERO WIDTH NON-JOINER' },
  { char: '\u200D', name: 'ZERO WIDTH JOINER' },
  { char: '\u200E', name: 'LEFT-TO-RIGHT MARK' },
  { char: '\u200F', name: 'RIGHT-TO-LEFT MARK' },
  { char: '\u202A', name: 'LEFT-TO-RIGHT EMBEDDING' },
  { char: '\u202B', name: 'RIGHT-TO-LEFT EMBEDDING' },
  { char: '\u202C', name: 'POP DIRECTIONAL FORMATTING' },
  { char: '\u202D', name: 'LEFT-TO-RIGHT OVERRIDE' },
  { char: '\u202E', name: 'RIGHT-TO-LEFT OVERRIDE' },
  { char: '\u2060', name: 'WORD JOINER' },
  { char: '\u2061', name: 'FUNCTION APPLICATION' },
  { char: '\u2062', name: 'INVISIBLE TIMES' },
  { char: '\u2063', name: 'INVISIBLE SEPARATOR' },
  { char: '\u2064', name: 'INVISIBLE PLUS' },
  { char: '\uFEFF', name: 'ZERO WIDTH NO-BREAK SPACE (BOM)' },
  { char: '\u00AD', name: 'SOFT HYPHEN' },
];

/** A character that hides text. */
export interface InvisibleHit {
  /** The character. */
  char: string;
  /** Its name. */
  name: string;
  /** Where it appears in the text. */
  index: number;
}

/** Find invisible characters in a text. */
export function findInvisibleCharacters(text: string): InvisibleHit[] {
  const hits: InvisibleHit[] = [];
  for (const { char, name } of INVISIBLE_CHARACTERS) {
    let index = text.indexOf(char);
    while (index !== -1) {
      hits.push({ char, name, index });
      index = text.indexOf(char, index + char.length);
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------------------
// Base64 and exfiltration URLs
// ---------------------------------------------------------------------------

/**
 * A base64-looking blob of at least this length is suspicious.
 *
 * 16 characters is one base64 quantum (12 bytes); a padded blob is usually
 * close to that length. A longer threshold would miss short encoded
 * payloads, which are exactly the ones used to smuggle a short instruction.
 */
const BASE64_MIN_LENGTH = 16;

/** A base64 blob. */
export interface Base64Hit {
  /** The blob. */
  text: string;
  /** Where it appears. */
  index: number;
}

/** Find base64-looking blobs in a text. */
export function findBase64Blobs(text: string): Base64Hit[] {
  const pattern = new RegExp(`[A-Za-z0-9+/]{${BASE64_MIN_LENGTH},}={0,2}`, 'g');
  const hits: Base64Hit[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const candidate = match[0];
    // A plain word run of this length is common; require either padding, a
    // mix of cases, or a character that is unusual in prose.
    const hasPadding = candidate.endsWith('=');
    const hasMixedCase = /[a-z]/.test(candidate) && /[A-Z]/.test(candidate);
    const hasDigit = /\d/.test(candidate);
    const hasSymbol = /[+/]/.test(candidate);
    if (hasPadding || (hasMixedCase && hasDigit) || (hasMixedCase && hasSymbol)) {
      hits.push({ text: candidate, index: match.index });
    }
  }
  return hits;
}

/** Query-string keys that commonly carry secrets or exfiltrated page data. */
const EXFIL_KEYS = [
  'token',
  'access_token',
  'auth',
  'authorization',
  'apikey',
  'api_key',
  'key',
  'secret',
  'password',
  'passwd',
  'pwd',
  'session',
  'sessionid',
  'cookie',
  'data',
  'payload',
  'body',
  'content',
  'page',
  'html',
  'text',
  'email',
  'user',
  'username',
  'prompt',
  'instructions',
  'context',
  'creds',
  'credentials',
];

/** An exfiltration-style URL. */
export interface ExfilHit {
  /** The URL. */
  url: string;
  /** The suspicious query key. */
  key: string;
  /** Where it appears. */
  index: number;
}

/** Find exfiltration-style URLs in a text. */
export function findExfiltrationUrls(text: string): ExfilHit[] {
  const urlPattern = /https?:\/\/[^\s"'<>)\]]+/g;
  const hits: ExfilHit[] = [];
  let match: RegExpExecArray | null;
  while ((match = urlPattern.exec(text)) !== null) {
    const url = match[0];
    const queryStart = url.indexOf('?');
    if (queryStart !== -1) {
      const query = url.slice(queryStart + 1);
      for (const part of query.split('&')) {
        const eq = part.indexOf('=');
        const key = (eq === -1 ? part : part.slice(0, eq)).toLowerCase();
        if (EXFIL_KEYS.some((k) => key === k || key.includes(k))) {
          hits.push({ url, key, index: match.index });
          break;
        }
      }
      continue;
    }

    // A URL with no query is still an exfiltration channel when the text
    // around it says what to do with it. A bare URL is not enough on its
    // own — that would flag every link on the page.
    const context = text.slice(Math.max(0, match.index - 80), match.index).toLowerCase();
    if (EXFIL_CONTEXT.some((phrase) => context.includes(phrase))) {
      hits.push({ url, key: 'context', index: match.index });
    }
  }
  return hits;
}

/**
 * The phrases that make a bare URL an exfiltration channel.
 *
 * The phrase has to be near the URL, so an ordinary link on a page that
 * happens to mention "send" is not flagged.
 */
export const EXFIL_CONTEXT: readonly string[] = [
  'post the',
  'post this',
  'post your',
  'send the',
  'send this',
  'send your',
  'upload the',
  'upload your',
  'submit the',
  'submit your',
  'exfiltrate',
  'collect the',
  'forward the',
  'email the',
  'email this',
];

// ---------------------------------------------------------------------------
// Suspicious hidden field names
// ---------------------------------------------------------------------------

/** Field names that suggest a hidden credential or instruction channel. */
const SUSPICIOUS_FIELD_NAMES = [
  'prompt',
  'instruction',
  'instructions',
  'system',
  'sysmsg',
  'admin',
  'override',
  'secret',
  'token',
  'apikey',
  'api_key',
  'password',
  'passwd',
  'credential',
  'session',
  'role',
  'directive',
  'context',
];

/** A suspicious hidden form field. */
export interface HiddenFieldHit {
  /** The field name. */
  name: string;
  /** The field type. */
  type: string;
}

/** Find hidden form fields with suspicious names. */
export function findSuspiciousHiddenFields(
  fields: readonly { name: string; type: string; hidden: boolean }[],
): HiddenFieldHit[] {
  const hits: HiddenFieldHit[] = [];
  for (const field of fields) {
    if (!field.hidden) continue;
    const name = field.name.toLowerCase();
    if (SUSPICIOUS_FIELD_NAMES.some((s) => name === s || name.includes(s))) {
      hits.push({ name: field.name, type: field.type });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------

/** A piece of content to scan. */
export interface ScannableContent {
  /** The text. */
  text: string;
  /** The ref of the node, when known. */
  ref?: string;
  /** Where the text came from, e.g. `attribute:alt`. */
  via?: string;
}

/** Options for the scanner. */
export interface ScanOptions {
  /** Extra instruction phrases. */
  extraPhrases?: readonly string[];
  /** Replace the default fake-banner patterns. */
  fakeBannerPatterns?: readonly RegExp[];
}

/** The injection scanner. */
export class InjectionScanner {
  private readonly phrases: string[];
  private readonly bannerPatterns: readonly RegExp[];

  constructor(options: ScanOptions = {}) {
    this.phrases = allInstructionPhrases(options.extraPhrases ?? []);
    this.bannerPatterns = options.fakeBannerPatterns ?? DEFAULT_FAKE_BANNER_PATTERNS;
  }

  /**
   * Scan a list of content pieces.
   *
   * The findings are returned with sequential ids (`f-1`, `f-2`, …).
   */
  scan(contents: readonly ScannableContent[]): ScanResult {
    const findings: Finding[] = [];
    let counter = 0;
    const nextId = (): string => {
      counter += 1;
      return `f-${counter}`;
    };

    for (const content of contents) {
      const text = content.text;
      if (text.length === 0) continue;
      const ref = content.ref;

      // --- Invisible characters --------------------------------------------
      const invisible = findInvisibleCharacters(text);
      if (invisible.length > 0) {
        findings.push({
          id: nextId(),
          kind: 'invisible-characters',
          severity: 'block',
          evidenceSnippet: `${invisible.length} hidden character(s): ${invisible
            .slice(0, 3)
            .map((h) => h.name)
            .join(', ')}`,
          ...(ref !== undefined ? { nodeRef: ref } : {}),
        });
      }

      // --- Instruction phrases ---------------------------------------------
      const lowered = text.toLowerCase();
      for (const phrase of this.phrases) {
        if (!lowered.includes(phrase.toLowerCase())) continue;
        findings.push({
          id: nextId(),
          kind: 'instruction-phrase',
          severity: 'review',
          evidenceSnippet: snippetAround(text, phrase),
          ...(ref !== undefined ? { nodeRef: ref } : {}),
        });
        break; // One instruction finding per content piece is enough.
      }

      // --- Fake system banners ----------------------------------------------
      for (const pattern of this.bannerPatterns) {
        if (!pattern.test(text)) continue;
        findings.push({
          id: nextId(),
          kind: 'fake-system-banner',
          severity: 'block',
          evidenceSnippet: snippetAround(text, pattern.source),
          ...(ref !== undefined ? { nodeRef: ref } : {}),
        });
        break;
      }

      // --- Base64 blobs ------------------------------------------------------
      const blobs = findBase64Blobs(text);
      if (blobs.length > 0) {
        // The array is non-empty here, so the first element always exists.
        const first = blobs[0] as { text: string; index: number };
        findings.push({
          id: nextId(),
          kind: 'base64-blob',
          severity: 'warn',
          evidenceSnippet: `${blobs.length} base64-like blob(s), first: ${first.text.slice(0, 32)}…`,
          ...(ref !== undefined ? { nodeRef: ref } : {}),
        });
      }

      // --- Exfiltration URLs --------------------------------------------------
      const exfil = findExfiltrationUrls(text);
      if (exfil.length > 0) {
        const first = exfil[0] as { url: string; key: string; index: number };
        findings.push({
          id: nextId(),
          kind: 'exfiltration-url',
          severity: 'block',
          evidenceSnippet: `${first.url.slice(0, 80)} (key: ${first.key})`,
          ...(ref !== undefined ? { nodeRef: ref } : {}),
        });
      }
    }

    return { findings, worstSeverity: worstSeverity(findings) };
  }

  /**
   * Scan a DOM-derived structure: hidden text, comments, attributes and
   * hidden fields.
   */
  scanDom(dom: DomScanInput): ScanResult {
    const contents: ScannableContent[] = [];

    // --- Hidden text --------------------------------------------------------
    for (const node of dom.hiddenText) {
      contents.push({ text: node.text, ...(node.ref !== undefined ? { ref: node.ref } : {}) });
    }

    // --- aria-hidden text ---------------------------------------------------
    for (const node of dom.ariaHiddenText) {
      contents.push({ text: node.text, ...(node.ref !== undefined ? { ref: node.ref } : {}) });
    }

    // --- HTML comments ------------------------------------------------------
    for (const comment of dom.comments) {
      contents.push({ text: comment });
    }

    // --- Attributes ---------------------------------------------------------
    for (const attribute of dom.attributes) {
      contents.push({
        text: attribute.value,
        ...(attribute.ref !== undefined ? { ref: attribute.ref } : {}),
      });
    }

    // --- CSS content --------------------------------------------------------
    for (const value of dom.cssContent) {
      contents.push({ text: value });
    }

    // --- noscript -----------------------------------------------------------
    for (const value of dom.noscript) {
      contents.push({ text: value });
    }

    const result = this.scan(contents);

    // --- Hidden fields ------------------------------------------------------
    const hiddenFields = findSuspiciousHiddenFields(dom.hiddenFields);
    if (hiddenFields.length > 0) {
      const extra: Finding[] = [
        {
          id: `f-${result.findings.length + 1}`,
          kind: 'suspicious-hidden-field',
          severity: 'review',
          evidenceSnippet: hiddenFields
            .slice(0, 3)
            .map((f) => `${f.name} (${f.type})`)
            .join(', '),
        },
      ];
      return {
        findings: [...result.findings, ...extra],
        worstSeverity: worstSeverity([...result.findings, ...extra]),
      };
    }

    return result;
  }
}

/** The DOM facts the scanner needs. */
export interface DomScanInput {
  /** Text that is hidden by computed style. */
  hiddenText: { text: string; ref?: string }[];
  /** Text inside an `aria-hidden` container. */
  ariaHiddenText: { text: string; ref?: string }[];
  /** HTML comment bodies. */
  comments: string[];
  /** Attribute values that could carry instructions. */
  attributes: { value: string; ref?: string; attribute: string }[];
  /** CSS `content:` values. */
  cssContent: string[];
  /** `<noscript>` bodies. */
  noscript: string[];
  /** Hidden form fields. */
  hiddenFields: { name: string; type: string; hidden: boolean }[];
}

/** Extract a snippet around a match. */
function snippetAround(text: string, needle: string, radius = 40): string {
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index === -1) return text.slice(0, radius * 2);
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + needle.length + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

// ---------------------------------------------------------------------------
// The nonce envelope
// ---------------------------------------------------------------------------

/** The tag that wraps untrusted content. */
export const UNTRUSTED_TAG = 'untrusted_web_content';

/** An envelope around untrusted content. */
export interface Envelope {
  /** The nonce used for this envelope. */
  readonly nonce: string;
  /** The wrapped text. */
  readonly text: string;
}

/**
 * Wrap page-derived content in a nonce-tagged envelope.
 *
 * The nonce is 16 hex characters, regenerated per call. Any occurrence of the
 * nonce inside the content is escaped, so the content cannot forge a closing
 * tag.
 */
export function wrapUntrusted(
  content: string,
  options: { origin?: string; nonce?: string } = {},
): Envelope {
  const nonce = options.nonce ?? randomBytes(8).toString('hex');
  const origin = options.origin ?? 'unknown';
  const escaped = escapeContent(content, nonce);
  const text =
    `<${UNTRUSTED_TAG} origin="@url:\`${origin}\`" nonce="${nonce}">\n` +
    `${escaped}\n` +
    `</${UNTRUSTED_TAG} nonce="${nonce}">`;
  return { nonce, text };
}

/**
 * Escape content so it cannot break out of the envelope.
 *
 * Three things are handled:
 *  - an occurrence of the nonce (which would allow a forged close tag),
 *  - a literal closing tag of the untrusted tag,
 *  - an opening tag of the untrusted tag (which would confuse a parser).
 */
export function escapeContent(content: string, nonce: string): string {
  let escaped = content;

  // Escape the nonce first: it is the shortest and most dangerous sequence.
  escaped = escaped.replaceAll(nonce, escapeToken(nonce));

  // Escape any untrusted tag, opening or closing, regardless of nonce.
  escaped = escaped.replaceAll(`</${UNTRUSTED_TAG}`, `&lt;/${UNTRUSTED_TAG}`);
  escaped = escaped.replaceAll(`<${UNTRUSTED_TAG}`, `&lt;${UNTRUSTED_TAG}`);

  return escaped;
}

/** Escape a token so it cannot appear literally. */
function escapeToken(token: string): string {
  // Insert a zero-width-free escape that cannot be produced by an attacker
  // matching the original: a Unicode escape sequence written out.
  return token
    .split('')
    .map((ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .join('');
}

/**
 * Redact a node's text when a `block` finding applies to it.
 *
 * The redaction marker names the finding, so the agent can tell that
 * something was removed and why.
 */
export function redact(text: string, findingId: string): string {
  return `[REDACTED: injection-suspect ${findingId}]`;
}

/**
 * Apply the redactions for the `block` findings to a map of node refs.
 *
 * Returns a new map; the input is not modified.
 */
export function applyRedactions(
  texts: ReadonlyMap<string, string>,
  findings: readonly Finding[],
): Map<string, string> {
  const result = new Map(texts);
  for (const finding of findings) {
    if (finding.severity !== 'block') continue;
    if (finding.nodeRef === undefined) continue;
    const existing = result.get(finding.nodeRef);
    if (existing === undefined) continue;
    result.set(finding.nodeRef, redact(existing, finding.id));
  }
  return result;
}

/**
 * The nodes that need approval before they can be acted on.
 *
 * A `review` finding means the node must not be acted on without approval.
 */
export function nodesNeedingApproval(findings: readonly Finding[]): string[] {
  const refs = new Set<string>();
  for (const finding of findings) {
    if (finding.severity !== 'review') continue;
    if (finding.nodeRef !== undefined) refs.add(finding.nodeRef);
  }
  return [...refs];
}

/** A summary of the findings, for the snapshot header. */
export function summarizeFindings(findings: readonly Finding[]): string {
  if (findings.length === 0) return '';
  const counts = new Map<FindingSeverity, number>();
  for (const finding of findings) {
    counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const severity of ['block', 'review', 'warn', 'info'] as const) {
    const count = counts.get(severity);
    if (count !== undefined && count > 0) parts.push(`${severity}:${count}`);
  }
  return `injection ${parts.join(' ')}`;
}
