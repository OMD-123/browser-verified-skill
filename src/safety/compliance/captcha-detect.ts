/**
 * The CAPTCHA, login-wall and 2FA detector (M11).
 *
 * When one of these is detected, the run **pauses for a human**. It does not
 * attempt to solve a CAPTCHA, does not bypass a login wall, and does not
 * guess a 2FA code. A human completes the challenge in the (headed) browser
 * and then runs `bv resume`.
 *
 * The detector is deliberately conservative: a false positive costs a human
 * a moment, but a false negative could mean an automated login attempt.
 */

/** The kinds of challenge that need a human. */
export type ChallengeKind = 'captcha' | 'login-wall' | 'two-factor';

/** A detected challenge. */
export interface Challenge {
  /** What kind of challenge it is. */
  kind: ChallengeKind;
  /** Why it was detected. */
  reason: string;
  /** The evidence that led to the detection. */
  evidence: string;
  /** How confident the detector is, from 0 to 1. */
  confidence: number;
}

/** The text and markers a detector inspects. */
export interface ChallengeInput {
  /** The page's visible text. */
  text: string;
  /** The page's title. */
  title?: string;
  /** The page's URL. */
  url?: string;
  /** Whether the page has a password field. */
  hasPasswordField?: boolean;
  /** The names of the visible inputs. */
  inputNames?: readonly string[];
  /** The names of the visible buttons and links. */
  buttonNames?: readonly string[];
}

/** The patterns that indicate a CAPTCHA. */
const CAPTCHA_PATTERNS: readonly RegExp[] = [
  /verify (?:you are|you're) (?:a )?human/i,
  /are you a (?:human|robot)/i,
  /i'?m not a robot/i,
  /complete the (?:captcha|security check)/i,
  /enter the (?:characters|code) (?:you )?see/i,
  /recaptcha/i,
  /hcaptcha/i,
  /turnstile/i,
  /cloudflare.*challenge/i,
  /checking your browser before accessing/i,
  /press and hold/i,
];

/** The patterns that indicate a login wall. */
const LOGIN_PATTERNS: readonly RegExp[] = [
  /sign in to continue/i,
  /log ?in to (?:continue|proceed|access|view)/i,
  /you must be logged in/i,
  /please (?:sign|log) ?in to (?:view|access|continue)/i,
  /create (?:an |a )?account to (?:continue|view|access)/i,
  /members[- ]only/i,
  /authentication required/i,
  /session (?:has )?expired.*sign in/i,
];

/** The patterns that indicate a two-factor step. */
const TWO_FACTOR_PATTERNS: readonly RegExp[] = [
  /two[- ]factor (?:authentication|verification)/i,
  /two[- ]step (?:verification|authentication)/i,
  /2fa/i,
  /one[- ]time (?:code|password|passcode)/i,
  /verification code (?:sent|has been sent|we sent)/i,
  /enter the (?:6|six)[- ]digit (?:code|otp)/i,
  /authenticator app/i,
  /check your (?:authenticator|phone) for/i,
];

/** The input names that indicate a one-time-code field. */
const OTP_INPUT_NAMES: readonly RegExp[] = [
  /^otp/i,
  /^totp/i,
  /^mfa/i,
  /^2fa/i,
  /one[- ]?time/i,
  /verification[- ]?code/i,
  /auth[- ]?code/i,
  /^code$/i,
];

/**
 * The button names that mean "this form is a sign-in form".
 *
 * The `sign ?in` alternative matches "sign in" and "signin"; `log ?in`
 * matches "log in" and "login".
 */
const SIGN_IN_PATTERN = /sign ?in|log ?in|continue|submit/;

/**
 * Detect a CAPTCHA challenge.
 *
 * Returns undefined when no CAPTCHA is found.
 */
export function detectCaptcha(input: ChallengeInput): Challenge | undefined {
  const haystack = `${input.title ?? ''}\n${input.text}`;
  for (const pattern of CAPTCHA_PATTERNS) {
    const match = pattern.exec(haystack);
    if (match !== null) {
      return {
        kind: 'captcha',
        reason: `the page asks for a human verification (${pattern.source})`,
        evidence: match[0],
        confidence: 0.9,
      };
    }
  }
  return undefined;
}

/**
 * Detect a login wall.
 *
 * Returns undefined when the page is not gated behind a login.
 */
export function detectLoginWall(input: ChallengeInput): Challenge | undefined {
  const haystack = `${input.title ?? ''}\n${input.text}`;
  for (const pattern of LOGIN_PATTERNS) {
    const match = pattern.exec(haystack);
    if (match !== null) {
      return {
        kind: 'login-wall',
        reason: `the page requires a sign-in (${pattern.source})`,
        evidence: match[0],
        confidence: 0.8,
      };
    }
  }

  // A password field with no way past it is a login wall even without the
  // words "sign in".
  if (input.hasPasswordField === true) {
    const submitNames = (input.buttonNames ?? []).join(' ').toLowerCase();
    if (SIGN_IN_PATTERN.test(submitNames)) {
      return {
        kind: 'login-wall',
        reason: 'the page shows a password field and a sign-in control',
        evidence: 'password field present',
        confidence: 0.6,
      };
    }
  }

  return undefined;
}

/**
 * Detect a two-factor step.
 *
 * Returns undefined when no two-factor step is found.
 */
export function detectTwoFactor(input: ChallengeInput): Challenge | undefined {
  const haystack = `${input.title ?? ''}\n${input.text}`;
  for (const pattern of TWO_FACTOR_PATTERNS) {
    const match = pattern.exec(haystack);
    if (match !== null) {
      return {
        kind: 'two-factor',
        reason: `the page asks for a second factor (${pattern.source})`,
        evidence: match[0],
        confidence: 0.85,
      };
    }
  }

  for (const name of input.inputNames ?? []) {
    for (const pattern of OTP_INPUT_NAMES) {
      if (pattern.test(name)) {
        return {
          kind: 'two-factor',
          reason: `the page has a one-time-code field (${pattern.source})`,
          evidence: name,
          confidence: 0.7,
        };
      }
    }
  }

  return undefined;
}

/**
 * Detect any challenge that needs a human.
 *
 * The kinds are checked in order of certainty: a CAPTCHA is the most
 * explicit signal, then two-factor, then a login wall.
 */
export function detectChallenge(input: ChallengeInput): Challenge | undefined {
  return detectCaptcha(input) ?? detectTwoFactor(input) ?? detectLoginWall(input);
}

/**
 * The message shown to the user when a handoff is needed.
 *
 * It says what to do, not just what happened.
 */
export function handoffMessage(url: string, challenge: Challenge): string {
  return [
    `Human needed at ${url}`,
    `Reason: ${challenge.reason}`,
    '',
    'Complete the challenge in the browser window, then run `bv resume`.',
    'browser-verified-skill does not solve CAPTCHAs, bypass logins or guess 2FA codes.',
  ].join('\n');
}
