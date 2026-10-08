/** Deterministic policy, evidence, routing, and packet builders. */

import { policyReview } from './policyDirectory.js';
import {
  type ClaimClassification,
  ClaimClassificationSchema,
  type ClaimIntakePacket,
  type ClaimNarrative,
  ClaimNarrativeSchema,
  type CoverageEvidenceDecision,
  CoverageEvidenceDecisionSchema,
  type DocumentChecklist,
  type DocumentChecklistItem,
  type EvidenceRecord,
  type EvidenceRuleFinding,
  type FieldValidation,
  FieldValidationSchema,
  type FraudSafetyGate,
  type FraudSafetySignal,
  type RoutingDecision,
  type Severity,
} from './schemas.js';

export const TYPE_REQUIRED_DOCS: Record<string, Array<[string, string]>> = {
  home_water_damage: [
    ['Photos or video of damaged areas before cleanup', 'Documents the loss condition.'],
    ['Mitigation or drying invoice', 'Shows steps taken to prevent additional damage.'],
    ['Repair estimate or contractor assessment', 'Supports the estimated repair cost.'],
    ['Receipts for damaged personal property', 'Supports contents reimbursement.'],
  ],
  auto_collision: [
    ['Photos of vehicles and scene', 'Documents impact location and visible damage.'],
    ['Police report or incident exchange form', 'Confirms crash facts and involved parties.'],
    ['Repair estimate or tow/storage invoice', 'Supports vehicle damage costs.'],
    ['Medical documentation for any injuries', 'Supports injury-related escalation and benefits.'],
    ['Other driver and witness information', 'Helps liability review.'],
  ],
  theft_property_loss: [
    ['Police report number or theft report', 'Most theft claims require a filed report.'],
    ['Receipts, serial numbers, or ownership proof', 'Supports ownership and value.'],
    ['Photos of the item or packaging if available', 'Helps item identification.'],
    ['Location timeline and access details', 'Helps verify circumstances of loss.'],
  ],
  health_medical_reimbursement: [
    ['Itemized provider bill', 'Shows services, dates, and charged amounts.'],
    ['Explanation of benefits or denial notice', 'Shows what was paid or denied.'],
    ['Proof of payment', 'Supports reimbursement amount.'],
    ['Provider name and diagnosis or treatment summary', 'Supports eligibility review.'],
  ],
  travel_delay_cancellation: [
    ['Carrier cancellation or delay notice', 'Confirms the covered travel disruption.'],
    ['Original itinerary and booking confirmation', 'Shows trip dates and route.'],
    ['Receipts for prepaid nonrefundable expenses', 'Supports claimed loss amount.'],
    ['Refund, voucher, or credit documentation', 'Prevents duplicate recovery.'],
    ['Weather, emergency, or event documentation if available', 'Supports cause of disruption.'],
  ],
  other: [
    ['Photos or available proof of loss', 'Documents what happened.'],
    ['Receipts, estimates, or invoices', 'Supports the claimed amount.'],
    ['Any third-party report or confirmation', 'Helps verify loss facts.'],
  ],
};

export const BLOCKING_FIELD_QUESTIONS: Record<string, string> = {
  policyholder_name: 'What is your full name as it appears on the policy?',
  policy_number: 'What is the policy number, if you have it available?',
  contact_method: 'What is the best phone number or email for the adjuster to reach you?',
  date_of_loss: 'When did the loss happen?',
  loss_location: 'Where did the loss happen?',
  loss_description: 'Can you briefly describe what happened?',
};

/** Every checklist item has a stable type. Similar words never satisfy a different document. */
export const DOCUMENT_KEYS: Record<string, string> = {
  'Photos or video of damaged areas before cleanup': 'damage_photo',
  'Mitigation or drying invoice': 'drying_invoice',
  'Repair estimate or contractor assessment': 'repair_estimate',
  'Receipts for damaged personal property': 'ownership_receipt',
  'Photos of vehicles and scene': 'damage_photo',
  'Police report or incident exchange form': 'police_report',
  'Repair estimate or tow/storage invoice': 'repair_estimate',
  'Medical documentation for any injuries': 'medical_bill',
  'Other driver and witness information': 'witness_details',
  'Police report number or theft report': 'police_report',
  'Receipts, serial numbers, or ownership proof': 'ownership_receipt',
  'Photos of the item or packaging if available': 'damage_photo',
  'Location timeline and access details': 'timeline',
  'Itemized provider bill': 'medical_bill',
  'Explanation of benefits or denial notice': 'eob',
  'Proof of payment': 'payment_proof',
  'Provider name and diagnosis or treatment summary': 'treatment_summary',
  'Carrier cancellation or delay notice': 'carrier_notice',
  'Original itinerary and booking confirmation': 'itinerary',
  'Receipts for prepaid nonrefundable expenses': 'expense_receipt',
  'Refund, voucher, or credit documentation': 'refund_document',
  'Weather, emergency, or event documentation if available': 'event_document',
  'Photos or available proof of loss': 'damage_photo',
  'Receipts, estimates, or invoices': 'ownership_receipt',
  'Any third-party report or confirmation': 'third_party_report',
};

export const DOCUMENT_TYPE_VALUES = [...new Set(Object.values(DOCUMENT_KEYS))];

export function isBlank(value: unknown): boolean {
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  return ['', 'unknown', 'not specified', 'unspecified', 'n/a', 'none', 'not provided'].includes(text);
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const normalized = String(item ?? '').trim();
    const key = normalized.toLowerCase();
    if (normalized && !seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }
  return result;
}

function allEvidenceText(claim: ClaimNarrative): string {
  return [
    claim.loss_description,
    claim.raw_narrative_summary,
    claim.evidence_available.join(' '),
    claim.documents_mentioned.join(' '),
  ]
    .join('\n')
    .toLowerCase();
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/** Conservative fallback for legacy callers; structured facts are authoritative. */
function withoutNegatedSafetyMentions(text: string): string {
  const clauses = String(text).split(/[.;!?]|\bbut\b|\bhowever\b/i);
  const result: string[] = [];
  for (const clause of clauses) {
    // Split conjunctions so 'no injuries and electrical hazard' keeps the hazard.
    for (let part of clause.split(/\band\b/i)) {
      part = part.replace(/\bno (?:safe )?place to (?:live|stay)\b/gi, 'unsafe housing');
      part = part.replace(/\bnot safe\b/gi, 'unsafe');
      if (/\b(no|not|none|nobody|neither|without|denies|denied|ruled out)\b/i.test(part)) continue;
      result.push(part);
    }
  }
  return result.join('. ');
}

function hasPositiveSafetyLanguage(text: string): boolean {
  return /\b(injur\w*|hurt|pain|fractur\w*|bleeding|hospital|urgent care|ambulance|unsafe|electrical|sewage|mold|hazard\w*|danger|no place to live)\b/i.test(
    withoutNegatedSafetyMentions(text),
  );
}

export function positiveSafetyConcerns(claim: ClaimNarrative): string[] {
  if (claim.safety_facts.length) {
    return claim.safety_facts
      .filter((fact) => fact.status === 'present' || fact.status === 'uncertain')
      .map((fact) => fact.description);
  }
  const values = [...claim.injuries_or_safety_concerns, claim.loss_description, claim.raw_narrative_summary];
  return values.filter((text) => hasPositiveSafetyLanguage(text));
}

function documentRecord(document: string, claim: ClaimNarrative): EvidenceRecord | undefined {
  const key = DOCUMENT_KEYS[document] ?? document;
  const records = claim.evidence_records.filter((record) => record.document_type === key);
  const received = records.filter((record) => record.status === 'received' && record.evidence_ids.length);
  return received.at(-1) ?? records.at(-1);
}

function documentProvided(document: string, claim: ClaimNarrative): boolean {
  const record = documentRecord(document, claim);
  return Boolean(record && record.status === 'received' && record.evidence_ids.length);
}

export interface ReceivedEvidence {
  id: string;
  document_types: string[];
}

/** Only the server capture registry can mint received evidence, never an LLM. */
export function prepareClaim(claimValue: unknown, receivedEvidence: ReceivedEvidence[] = []): ClaimNarrative {
  const claim = ClaimNarrativeSchema.parse(claimValue ?? {});
  const records: EvidenceRecord[] = [];
  for (const record of claim.evidence_records) {
    records.push({
      ...record,
      evidence_ids: [],
      status: record.status === 'received' ? 'available' : record.status,
    });
  }
  for (const evidence of receivedEvidence) {
    for (const kind of evidence.document_types ?? []) {
      if (DOCUMENT_TYPE_VALUES.includes(kind)) {
        records.push({ document_type: kind, status: 'received', source_turn_ids: [], evidence_ids: [evidence.id] });
      }
    }
  }
  return { ...claim, evidence_records: records };
}

const MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

function calendarDate(year: number, month: number, day: number): Date | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

/** Accepts YYYY-MM-DD, MM/DD/YYYY, MM-DD-YYYY, and 'March 18, 2026' style dates. */
export function parseDate(value: unknown): Date | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const cleaned = text.replace(/(\d+)(st|nd|rd|th)/gi, '$1');

  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(cleaned);
  if (match) return calendarDate(Number(match[1]), Number(match[2]), Number(match[3]));

  match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(cleaned);
  if (match) return calendarDate(Number(match[3]), Number(match[1]), Number(match[2]));

  match = /^([A-Za-z]+)\.? (\d{1,2}),? (\d{4})$/.exec(cleaned);
  if (match) {
    const month = MONTHS[match[1]!.toLowerCase()];
    if (!month) return null;
    return calendarDate(Number(match[3]), month, Number(match[2]));
  }
  return null;
}

function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

function nextClaimantMessage(route: RoutingDecision, missing: string[], requiredDocuments: string[]): string {
  if (route === 'emergency_escalation') {
    return (
      'Your claim mentions injury, safety, or habitability concerns. A human representative ' +
      'should review this immediately. If anyone is in danger, contact local emergency services first.'
    );
  }
  if (route === 'policy_review') {
    return 'The policy details need human review. Please confirm the policy number, policyholder, and loss date. Your packet has not been submitted to an adjuster yet.';
  }
  for (const fieldName of missing) {
    if (BLOCKING_FIELD_QUESTIONS[fieldName]) return BLOCKING_FIELD_QUESTIONS[fieldName]!;
  }
  if (missing.length) {
    return `Can you clarify this missing detail so the adjuster can process the claim smoothly: ${missing[0]}?`;
  }
  if (requiredDocuments.length) {
    return `Do you have this document or evidence available now: ${requiredDocuments[0]}?`;
  }
  if (route === 'special_investigation') {
    return (
      'A human reviewer should look at this file, but the core intake packet is started. ' +
      'Please keep originals of any receipts, reports, photos, or messages related to the loss.'
    );
  }
  return (
    'Your intake packet has the core information needed for adjuster assignment. Keep copies of ' +
    'all receipts, photos, reports, and communications related to the loss.'
  );
}

/** Validate minimum intake facts before coverage and evidence rules run. */
export function validateRequiredClaimFields(claimValue: unknown): FieldValidation {
  const claim = ClaimNarrativeSchema.parse(claimValue ?? {});
  let missing: string[] = [];
  const warnings: string[] = [];

  const requiredFields: Record<string, string> = {
    policyholder_name: claim.policyholder_name,
    policy_number: claim.policy_number,
    contact_method: claim.contact_method,
    date_of_loss: claim.date_of_loss,
    loss_location: claim.loss_location,
    loss_description: claim.loss_description,
  };
  for (const [fieldName, value] of Object.entries(requiredFields)) {
    if (isBlank(value)) missing.push(fieldName);
  }

  for (const name of ['date_of_loss', 'reported_date'] as const) {
    const value = claim[name];
    if (!isBlank(value)) {
      const parsed = parseDate(value);
      const label = name.replace(/_/g, ' ');
      if (!parsed) missing.push(`Confirm a valid calendar date for ${label}`);
      else if (parsed > todayUtc()) missing.push(`Confirm the future date for ${label}`);
    }
  }

  if (claim.estimated_loss_usd === null) warnings.push('Estimated loss amount was not supplied.');

  missing.push(...claim.missing_or_uncertain_facts);
  missing = dedupe(missing);

  return FieldValidationSchema.parse({
    intake_status: missing.length ? 'missing_info' : 'valid',
    missing_fields: missing,
    warnings: dedupe(warnings),
    ready_for_policy_review: !missing.length,
  });
}

/** Apply deterministic coverage, evidence, and first-pass routing rules. */
export function applyCoverageAndEvidenceRules(
  claimValue: unknown,
  validationValue: unknown,
  classificationValue: unknown,
): CoverageEvidenceDecision {
  const claim = ClaimNarrativeSchema.parse(claimValue ?? {});
  const validation = FieldValidationSchema.parse(validationValue);
  const classification = ClaimClassificationSchema.parse(classificationValue);

  const findings: EvidenceRuleFinding[] = [];
  const coverageNotes: string[] = [];
  const requiredDocs: string[] = [];

  const add = (
    ruleId: string,
    severity: Severity,
    message: string,
    requiredAction: EvidenceRuleFinding['required_action'],
    document: string | null = null,
  ) => {
    findings.push({ rule_id: ruleId, severity, message, required_action: requiredAction, document });
    if (document) requiredDocs.push(document);
  };

  if (validation.missing_fields.length) {
    add('INTAKE-001', 'medium', 'Required intake facts are missing before the claim can be fully assigned.', 'collect_info');
  }

  const docs = TYPE_REQUIRED_DOCS[classification.claim_type] ?? TYPE_REQUIRED_DOCS.other!;
  for (const [document, reason] of docs) {
    if (!documentProvided(document, claim)) {
      add('DOC-001', 'medium', `Missing or unconfirmed document: ${document}. ${reason}`, 'collect_document', document);
    }
  }

  if (claim.estimated_loss_usd !== null && claim.estimated_loss_usd >= 25000) {
    add('LOSS-001', 'high', 'Estimated loss is high enough to require prompt human adjuster review.', 'adjuster_review');
  }

  switch (classification.claim_type) {
    case 'home_water_damage':
      coverageNotes.push(
        'Water damage review usually turns on source of water, suddenness, mitigation, exclusions, and whether flood coverage is separate.',
        'Do not promise coverage until policy forms, endorsements, cause of loss, and mitigation facts are reviewed.',
      );
      break;
    case 'auto_collision':
      coverageNotes.push(
        'Auto collision review usually depends on liability facts, coverage type, deductibles, police report, photos, and damage estimate.',
        'Injury claims require immediate human handling and no medical coverage promises in the intake response.',
      );
      break;
    case 'theft_property_loss':
      coverageNotes.push(
        'Theft/property loss review usually requires proof of ownership, loss location, access details, and a police or incident report.',
        'High-value electronics or jewelry may have sublimits or scheduled-property requirements.',
      );
      if (!documentProvided('Police report number or theft report', claim)) {
        add(
          'THEFT-001',
          'medium',
          'Theft claim lacks a police or incident report.',
          'collect_document',
          'Police report number or theft report',
        );
      }
      break;
    case 'health_medical_reimbursement':
      coverageNotes.push(
        'Educational/demo note: medical reimbursement review depends on plan terms, eligibility, dates of service, itemized bills, EOBs, and proof of payment.',
        'This app does not provide medical, benefits, or coverage advice.',
      );
      break;
    case 'travel_delay_cancellation':
      coverageNotes.push(
        'Travel claim review usually depends on covered reason, carrier confirmation, trip dates, nonrefundable amounts, and refunds or credits received.',
        'Weather-related disruption may require carrier notices and documentation of unused prepaid expenses.',
      );
      break;
    default:
      coverageNotes.push(
        'Claim type is unclear; route for human triage after collecting minimum loss facts and proof of loss.',
      );
  }

  if (positiveSafetyConcerns(claim).length) {
    add('SAFE-001', 'urgent', 'A present or uncertain safety concern needs immediate human review.', 'emergency_escalation');
  }
  const review = policyReview(claim);
  for (const issue of review) add('POLICY-001', 'high', issue, 'adjuster_review');

  let route: RoutingDecision;
  if (findings.some((finding) => finding.required_action === 'emergency_escalation')) route = 'emergency_escalation';
  else if (findings.some((finding) => finding.required_action === 'siu_review')) route = 'special_investigation';
  else if (review.length) route = 'policy_review';
  else if (validation.missing_fields.length || findings.some((finding) => finding.required_action === 'collect_document'))
    route = 'needs_docs';
  else route = 'ready_for_adjuster';

  return CoverageEvidenceDecisionSchema.parse({
    routing_decision: route,
    provisional_coverage_considerations: dedupe(coverageNotes),
    required_documents: dedupe(requiredDocs),
    findings,
    audit_trail: [
      'Validated minimum claim intake fields.',
      `Classified claim as ${classification.claim_type} with ${classification.severity} severity.`,
      'Applied deterministic evidence, document, high-loss, injury, and safety routing gates.',
      `Initial route selected: ${route}.`,
    ],
  });
}

/** Generate a claimant-facing checklist from deterministic document rules. */
export function generateDocumentChecklist(
  claimValue: unknown,
  classificationValue: unknown,
  evidenceDecisionValue: unknown,
): DocumentChecklist {
  const claim = ClaimNarrativeSchema.parse(claimValue ?? {});
  const classification = ClaimClassificationSchema.parse(classificationValue);
  const evidenceDecision = CoverageEvidenceDecisionSchema.parse(evidenceDecisionValue);
  const required = new Set(evidenceDecision.required_documents);

  const items: DocumentChecklistItem[] = [];
  const docs = TYPE_REQUIRED_DOCS[classification.claim_type] ?? TYPE_REQUIRED_DOCS.other!;
  for (const [document, reason] of docs) {
    const provided = documentProvided(document, claim);
    const record = documentRecord(document, claim);
    items.push({
      item: document,
      reason,
      priority: required.has(document) ? 'required' : 'recommended',
      already_provided: provided,
      status: record ? record.status : 'unknown',
      evidence_ids: provided && record ? record.evidence_ids : [],
    });
  }

  if (classification.claim_type === 'auto_collision' && positiveSafetyConcerns(claim).length) {
    items.push({
      item: 'Names of injured people and treatment locations',
      reason: 'Supports urgent injury claim assignment.',
      priority: 'required',
      already_provided: false,
      status: 'unknown',
      evidence_ids: [],
    });
  }

  return {
    items,
    claimant_tip:
      'Show clear copies on camera when available. If a document is not available yet, explain why ' +
      'and provide the expected date.',
  };
}

/** Apply deterministic SIU, fraud-pattern, timing, and safety gates. */
export function fraudSignalAndSafetyGate(
  claimValue: unknown,
  validationValue: unknown,
  classificationValue: unknown,
  evidenceDecisionValue: unknown,
): FraudSafetyGate {
  const claim = ClaimNarrativeSchema.parse(claimValue ?? {});
  const validation = FieldValidationSchema.parse(validationValue);
  const classification = ClaimClassificationSchema.parse(classificationValue);
  const evidenceDecision = CoverageEvidenceDecisionSchema.parse(evidenceDecisionValue);

  const signals: FraudSafetySignal[] = [];
  const evidenceText = allEvidenceText(claim);
  const signal = (
    signalId: string,
    severity: Severity,
    message: string,
    routeToSiu = false,
    routeToEmergency = false,
  ) => {
    signals.push({
      signal_id: signalId,
      severity,
      message,
      route_to_siu: routeToSiu,
      route_to_emergency: routeToEmergency,
    });
  };

  const lossDate = parseDate(claim.date_of_loss);
  const reportDate = parseDate(claim.reported_date);
  if (lossDate && reportDate && reportDate < lossDate) {
    signal('TIMING-001', 'high', 'Reported date appears to be before the loss date.', true);
  }
  if (lossDate && reportDate && (reportDate.getTime() - lossDate.getTime()) / 86_400_000 > 90) {
    signal('TIMING-002', 'medium', 'Claim appears to be reported more than 90 days after the loss.', true);
  }
  if (hasAny(evidenceText, [/\bnot sure\b/, /\bdon'?t remember\b/, /\bmaybe\b/, /\bexact date\b/])) {
    signal('FACTS-001', 'medium', 'Narrative contains uncertain or vague key facts that need follow-up.');
  }
  if (
    claim.estimated_loss_usd !== null &&
    claim.estimated_loss_usd >= 10000 &&
    !claim.evidence_records.some((record) => record.status === 'available' || record.status === 'received')
  ) {
    signal('EVID-001', 'high', 'High estimated loss was submitted without supporting evidence.', true);
  }
  if (
    classification.claim_type === 'theft_property_loss' &&
    hasAny(evidenceText, [/\bno police\b/, /\bhave not filed\b/, /\bdidn'?t file\b/])
  ) {
    signal('THEFT-002', 'medium', 'Theft claim states that no police report has been filed yet.');
  }
  if (
    evidenceDecision.routing_decision === 'emergency_escalation' ||
    evidenceDecision.findings.some((finding) => finding.required_action === 'emergency_escalation')
  ) {
    signal('SAFETY-001', 'urgent', 'Safety, injury, or habitability issue requires immediate human review.', false, true);
  }
  if (['date_of_loss', 'loss_location', 'loss_description'].some((item) => validation.missing_fields.includes(item))) {
    signal('INTAKE-002', 'medium', 'Core loss facts are missing, so routing should remain follow-up oriented.');
  }

  let finalRoute: RoutingDecision;
  if (signals.some((item) => item.route_to_emergency)) finalRoute = 'emergency_escalation';
  else if (signals.some((item) => item.route_to_siu)) finalRoute = 'special_investigation';
  else finalRoute = evidenceDecision.routing_decision;

  return {
    final_routing_decision: finalRoute,
    signals,
    audit_trail: [
      ...evidenceDecision.audit_trail,
      'Applied deterministic fraud, suspicious timing, vague facts, and safety gates.',
      `Final route selected: ${finalRoute}.`,
    ],
  };
}

function titleCase(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Build the final Markdown claim intake packet. */
export function buildClaimIntakePacket(
  claim: ClaimNarrative,
  validation: FieldValidation,
  classification: ClaimClassification,
  evidenceDecision: CoverageEvidenceDecision,
  checklist: DocumentChecklist,
  fraudGate: FraudSafetyGate,
): ClaimIntakePacket {
  const missing = dedupe(validation.missing_fields);
  const route = fraudGate.final_routing_decision;
  const routeLabel = titleCase(route);

  const checklistLines = checklist.items.map((item) => `- [${item.status}] **${item.item}** - ${item.reason}`);
  if (!checklistLines.length) checklistLines.push('- No additional documents identified by current rules.');

  const missingLines = missing.length ? missing.map((field) => `- ${field}`) : ['- No required intake fields are missing.'];
  const coverageLines = evidenceDecision.provisional_coverage_considerations.length
    ? evidenceDecision.provisional_coverage_considerations.map((note) => `- ${note}`)
    : ['- Coverage review requires policy forms, endorsements, loss facts, and adjuster analysis.'];
  const signalLines = fraudGate.signals.length
    ? fraudGate.signals.map((item) => `- \`${item.signal_id}\` [${item.severity}] ${item.message}`)
    : ['- No deterministic fraud or emergency signal was triggered.'];
  const findingLines = evidenceDecision.findings.length
    ? evidenceDecision.findings.map((item) => `- \`${item.rule_id}\` [${item.severity}] ${item.message}`)
    : ['- No deterministic evidence findings were generated.'];

  const handoff =
    `${claim.policyholder_name || 'Unknown claimant'} reported a ` +
    `${classification.claim_type.replace(/_/g, ' ')} loss at ${claim.loss_location || 'an unknown location'} ` +
    `on ${claim.date_of_loss || 'an unknown date'}. ` +
    `Summary: ${claim.raw_narrative_summary || claim.loss_description}. ` +
    `Estimated loss: ${claim.estimated_loss_usd !== null ? claim.estimated_loss_usd : 'not supplied'}.`;

  const claimantNext = nextClaimantMessage(route, missing, evidenceDecision.required_documents);
  const auditLines = fraudGate.audit_trail.map((entry, index) => `${index + 1}. ${entry}`);

  const markdown = `# Insurance Claim Intake Packet

**Claim type:** ${titleCase(classification.claim_type)}
**Intake status:** ${titleCase(validation.intake_status)}
**Severity:** ${titleCase(classification.severity)}
**Routing decision:** ${routeLabel}

## Missing Information
${missingLines.join('\n')}

## Required Documents Checklist
${checklistLines.join('\n')}

## Coverage Considerations and Disclaimer
${coverageLines.join('\n')}

This is an intake triage packet for demo and educational use. It does not confirm coverage, benefits, liability, payment, or legal rights. A licensed adjuster or qualified human reviewer must evaluate the applicable policy, endorsements, exclusions, deductibles, documentation, and governing law.

## Adjuster Handoff Summary
${handoff}

## Claimant-Friendly Next Message
${claimantNext}

## Deterministic Findings
${findingLines.join('\n')}

## Fraud, Timing, and Safety Signals
${signalLines.join('\n')}

## Audit Trail
${auditLines.join('\n')}
`;

  return {
    claim_type: classification.claim_type,
    intake_status: validation.intake_status,
    severity: classification.severity,
    routing_decision: route,
    missing_information: missing,
    required_documents: checklist.items,
    coverage_considerations: evidenceDecision.provisional_coverage_considerations,
    adjuster_handoff_summary: handoff,
    claimant_next_message: claimantNext,
    audit_trail: fraudGate.audit_trail,
    markdown,
  };
}
