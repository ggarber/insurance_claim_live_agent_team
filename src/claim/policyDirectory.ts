/**
 * Mock policy directory used by the live voice agent's background policy lookup.
 *
 * This stands in for a carrier policy administration system. The records match
 * the mock policies in the README so a live call can verify the policy the
 * claimant mentions while the conversation keeps going.
 */

import type { ClaimNarrative } from './schemas.js';

export interface PolicyRecord {
  policy_number: string;
  policyholder_name: string;
  policy_line: string;
  status: 'active' | 'lapsed' | string;
  effective_period: string;
  effective_start: string;
  effective_end: string;
  deductibles: Record<string, number>;
  coverages: string[];
  notes: string[];
}

export type PolicyLookup =
  | ({ found: true } & PolicyRecord)
  | { found: false; policy_number: string; message: string };

function record(input: Omit<PolicyRecord, 'effective_start' | 'effective_end'>): PolicyRecord {
  // Structured periods are assessed against the loss date, never inferred from today's date.
  const dates = input.effective_period.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  return { ...input, effective_start: dates[0] ?? '', effective_end: dates[1] ?? '' };
}

export const POLICY_RECORDS: Record<string, PolicyRecord> = {
  44721: record({
    policy_number: '44721',
    policyholder_name: 'Adam Singh',
    policy_line: 'Homeowners (HO-3)',
    status: 'active',
    effective_period: '2026-01-01 to 2026-12-31',
    deductibles: { all_perils: 1000, wind_hail: 2500 },
    coverages: [
      'Dwelling $620,000',
      'Personal property $310,000',
      'Water backup and sump overflow endorsement $10,000',
      'Loss of use 12 months',
    ],
    notes: ['Sump pump and water backup endorsement is on file.'],
  }),
  AUTO123: record({
    policy_number: 'AUTO-123',
    policyholder_name: 'Jordan Lee',
    policy_line: 'Personal auto',
    status: 'active',
    effective_period: '2026-03-15 to 2026-09-15',
    deductibles: { collision: 500, comprehensive: 250 },
    coverages: [
      'Bodily injury 100/300',
      'Collision',
      'Comprehensive',
      'Medical payments $5,000',
      'Rental reimbursement $40/day up to 30 days',
    ],
    notes: ['Two listed drivers.', 'Rental reimbursement is available while the vehicle is in the shop.'],
  }),
  RNT3008: record({
    policy_number: 'RNT-3008',
    policyholder_name: 'Priya Shah',
    policy_line: 'Renters (HO-4)',
    status: 'active',
    effective_period: '2025-11-01 to 2026-10-31',
    deductibles: { all_perils: 250 },
    coverages: [
      'Personal property $25,000',
      'Theft away from premises up to 10 percent of personal property',
      'Personal liability $100,000',
    ],
    notes: ['Theft claims require a police report number before adjuster assignment.'],
  }),
  TRV7711: record({
    policy_number: 'TRV-7711',
    policyholder_name: 'Alex Chen',
    policy_line: 'Single trip travel',
    status: 'active',
    effective_period: 'Trip dates 2026-01-12 to 2026-01-22',
    deductibles: { trip_delay: 0, trip_cancellation: 0 },
    coverages: [
      'Trip cancellation up to $5,000',
      'Trip delay $200 per day after 6 hours, up to $1,000',
      'Baggage delay $300',
    ],
    notes: ['Weather-related carrier cancellations are a listed covered reason.'],
  }),
  MED5520: record({
    policy_number: 'MED-5520',
    policyholder_name: 'Sam Rivera',
    policy_line: 'Supplemental medical reimbursement',
    status: 'active',
    effective_period: '2026-01-01 to 2026-12-31',
    deductibles: { annual: 300 },
    coverages: [
      'Out-of-pocket medical reimbursement up to $7,500 per year',
      'Urgent care and emergency room copay reimbursement',
    ],
    notes: ['Itemized provider bill and explanation of benefits are required.'],
  }),
  AUTO11111: record({
    policy_number: 'AUTO-11111',
    policyholder_name: 'Chris Park',
    policy_line: 'Personal auto',
    status: 'lapsed',
    effective_period: '2025-08-01 to 2026-08-01 (not renewed)',
    deductibles: { collision: 1000 },
    coverages: ['Collision', 'Comprehensive'],
    notes: [
      'Policy lapsed on 2026-08-01 for non-payment.',
      'Any loss after the lapse date needs underwriting and human review before intake continues.',
    ],
  }),
};

const DIGIT_WORDS: Record<string, string> = {
  zero: '0', oh: '0', o: '0', one: '1', two: '2', three: '3', four: '4', for: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};
const SEPARATOR_WORDS = new Set(['dash', 'hyphen', 'minus', 'number', 'no', 'policy']);

/**
 * Turn a spoken policy number into characters: "auto one two three" becomes
 * "AUTO 123" and "double four seven two one" becomes "44721".
 * Text that already contains digits, like "AUTO-123", passes through unchanged.
 */
export function spokenPolicyNumber(value: string | null | undefined): string {
  const tokens = String(value ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (!tokens.some((token) => token in DIGIT_WORDS && token !== 'o')) return String(value ?? '').trim();
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const repeat = token === 'double' ? 2 : token === 'triple' ? 3 : 0;
    const next = tokens[i + 1];
    if (repeat && next && next in DIGIT_WORDS) {
      out.push(DIGIT_WORDS[next]!.repeat(repeat));
      i += 1;
    } else if (token in DIGIT_WORDS && (token !== 'o' || out.length)) {
      out.push(DIGIT_WORDS[token]!);
    } else if (!SEPARATOR_WORDS.has(token)) {
      out.push(` ${token.toUpperCase()} `);
    }
  }
  return out.join('').replace(/\s+/g, ' ').trim();
}

/** Collapse spoken digits, spacing, punctuation, and letter O versus zero confusion. */
export function normalizePolicyNumber(value: string | null | undefined): string {
  let text = spokenPolicyNumber(value)
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();
  // Voice transcripts often render zeros as the letter O inside the numeric tail.
  const match = text.match(/^([A-Z]+)([A-Z0-9]*)$/);
  if (match && match[2]) {
    let prefix = match[1]!;
    const tail = match[2].replace(/O/g, '0');
    // Keep the prefix's trailing O as a zero when a record uses one, like H0-123.
    if (prefix.endsWith('O') && `${prefix.slice(0, -1)}0${tail}` in POLICY_RECORDS) {
      prefix = `${prefix.slice(0, -1)}0`;
    }
    text = prefix + tail;
  }
  return text;
}

/** Return the policy record for a policy number, or a not-found payload. */
export function lookupPolicy(policyNumber: string): PolicyLookup {
  const key = normalizePolicyNumber(policyNumber);
  if (!key) {
    return {
      found: false,
      policy_number: '',
      message:
        'No policy number was provided. Ask the claimant to read it from their ID card or renewal notice.',
    };
  }
  const record = POLICY_RECORDS[key];
  if (!record) {
    return {
      found: false,
      policy_number: spokenPolicyNumber(policyNumber),
      message:
        'No policy matched that number. Ask the claimant to confirm it digit by digit, ' +
        'or continue intake using their name and contact details.',
    };
  }
  return { found: true, ...record };
}

function parseIsoDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime())) return null;
  if (date.getUTCMonth() !== Number(match[2]) - 1 || date.getUTCDate() !== Number(match[3])) return null;
  return date;
}

/** Deterministic policy checks that feed the policy_review route. */
export function policyReview(claim: ClaimNarrative): string[] {
  const record = lookupPolicy(claim.policy_number);
  if (!record.found) return ['Policy number needs verification'];
  const issues: string[] = [];
  const loss = parseIsoDate(claim.date_of_loss);
  const start = parseIsoDate(record.effective_start);
  const end = parseIsoDate(record.effective_end);
  if (!loss || !start || !end) {
    issues.push('Confirm an exact loss date for policy review');
  } else if (!(start <= loss && loss <= end)) {
    issues.push('Loss date falls outside the recorded policy period');
  }
  if (record.status !== 'active') issues.push('Policy status needs human review');
  const normalize = (text: string) => text.toLowerCase().replace(/[^a-z]/g, '');
  if (normalize(claim.policyholder_name) !== normalize(record.policyholder_name)) {
    issues.push('Claimant name differs from the mock policyholder record');
  }
  return issues;
}

/** Short human-readable status for the UI and voice summary. */
export function policyStatusHeadline(record: PolicyLookup): string {
  if (!record.found) return 'Not found';
  const status = String(record.status ?? 'unknown').toLowerCase();
  if (status === 'active') return 'Active';
  if (status === 'lapsed') return 'Lapsed - human review required';
  return status.charAt(0).toUpperCase() + status.slice(1);
}
