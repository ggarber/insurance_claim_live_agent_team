/** Structured data contracts for the insurance claim intake workflow. */

import { z } from 'zod';

export const ClaimTypeSchema = z.enum([
  'home_water_damage',
  'auto_collision',
  'theft_property_loss',
  'health_medical_reimbursement',
  'travel_delay_cancellation',
  'other',
]);
export type ClaimType = z.infer<typeof ClaimTypeSchema>;

export const SeveritySchema = z.enum(['low', 'medium', 'high', 'urgent']);
export type Severity = z.infer<typeof SeveritySchema>;

export const IntakeStatusSchema = z.enum(['valid', 'missing_info']);
export type IntakeStatus = z.infer<typeof IntakeStatusSchema>;

export const RoutingDecisionSchema = z.enum([
  'ready_for_adjuster',
  'needs_docs',
  'special_investigation',
  'emergency_escalation',
  'policy_review',
]);
export type RoutingDecision = z.infer<typeof RoutingDecisionSchema>;

export const EvidenceStatusSchema = z.enum(['unknown', 'missing', 'planned', 'available', 'received']);
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;

export const EvidenceRecordSchema = z.object({
  document_type: z.string().describe('Canonical document key from the extraction instructions.'),
  status: EvidenceStatusSchema.default('unknown'),
  source_turn_ids: z.array(z.string()).default([]),
  evidence_ids: z.array(z.string()).default([]),
});
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

export const SafetyFactSchema = z.object({
  category: z
    .string()
    .describe('injury, electrical, unsafe_housing, sewage, mold, or other immediate hazard'),
  status: z.enum(['present', 'absent', 'uncertain']),
  description: z.string(),
  source_turn_ids: z.array(z.string()).default([]),
});
export type SafetyFact = z.infer<typeof SafetyFactSchema>;

export const FactSourceSchema = z.object({
  field: z.string(),
  source_turn_ids: z.array(z.string()).default([]),
});

/** Normalized facts extracted from a messy claim narrative. */
export const ClaimNarrativeSchema = z.object({
  policyholder_name: z.string().default('not specified').describe('Name of the policyholder or claimant.'),
  policy_number: z.string().default('not specified').describe('Policy or member number if supplied.'),
  contact_method: z
    .string()
    .default('not specified')
    .describe('Best available phone, email, or mailing contact.'),
  date_of_loss: z
    .string()
    .default('not specified')
    .describe('Exact loss date in YYYY-MM-DD format, or not specified.'),
  reported_date: z
    .string()
    .default('not specified')
    .describe('Date the claimant says they are reporting, if supplied.'),
  loss_location: z
    .string()
    .default('not specified')
    .describe('City, address, intersection, facility, or travel route.'),
  loss_description: z
    .string()
    .default('not specified')
    .describe('Plain-language description of what happened.'),
  estimated_loss_usd: z
    .number()
    .nonnegative()
    .finite()
    .nullable()
    .default(null)
    .describe('Estimated financial loss in USD when supplied.'),
  injuries_or_safety_concerns: z.array(z.string()).default([]),
  parties_involved: z.array(z.string()).default([]),
  evidence_available: z.array(z.string()).default([]),
  documents_mentioned: z.array(z.string()).default([]),
  missing_or_uncertain_facts: z.array(z.string()).default([]),
  raw_narrative_summary: z
    .string()
    .default('not specified')
    .describe('Short factual summary of the source narrative.'),
  assumptions: z.array(z.string()).default([]),
  evidence_records: z.array(EvidenceRecordSchema).default([]),
  safety_facts: z.array(SafetyFactSchema).default([]),
  fact_sources: z.array(FactSourceSchema).default([]),
});
export type ClaimNarrative = z.infer<typeof ClaimNarrativeSchema>;

/** Deterministic validation of minimum claim intake information. */
export const FieldValidationSchema = z.object({
  intake_status: IntakeStatusSchema,
  missing_fields: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  ready_for_policy_review: z.boolean(),
});
export type FieldValidation = z.infer<typeof FieldValidationSchema>;

/** LLM classification of claim type and operational severity. */
export const ClaimClassificationSchema = z.object({
  claim_type: ClaimTypeSchema,
  severity: SeveritySchema,
  severity_rationale: z.string(),
  likely_policy_line: z.string(),
  loss_drivers: z.array(z.string()).default([]),
  claimant_needs: z.array(z.string()).default([]),
});
export type ClaimClassification = z.infer<typeof ClaimClassificationSchema>;

export const RequiredActionSchema = z.enum([
  'collect_info',
  'collect_document',
  'adjuster_review',
  'siu_review',
  'emergency_escalation',
]);

export const EvidenceRuleFindingSchema = z.object({
  rule_id: z.string(),
  severity: SeveritySchema,
  message: z.string(),
  required_action: RequiredActionSchema,
  document: z.string().nullable().default(null),
});
export type EvidenceRuleFinding = z.infer<typeof EvidenceRuleFindingSchema>;

export const CoverageEvidenceDecisionSchema = z.object({
  routing_decision: RoutingDecisionSchema,
  provisional_coverage_considerations: z.array(z.string()).default([]),
  required_documents: z.array(z.string()).default([]),
  findings: z.array(EvidenceRuleFindingSchema).default([]),
  audit_trail: z.array(z.string()).default([]),
});
export type CoverageEvidenceDecision = z.infer<typeof CoverageEvidenceDecisionSchema>;

export const DocumentChecklistItemSchema = z.object({
  item: z.string(),
  reason: z.string(),
  priority: z.enum(['required', 'recommended', 'conditional']),
  already_provided: z.boolean().default(false),
  status: EvidenceStatusSchema.default('unknown'),
  evidence_ids: z.array(z.string()).default([]),
});
export type DocumentChecklistItem = z.infer<typeof DocumentChecklistItemSchema>;

export const DocumentChecklistSchema = z.object({
  items: z.array(DocumentChecklistItemSchema).default([]),
  claimant_tip: z.string(),
});
export type DocumentChecklist = z.infer<typeof DocumentChecklistSchema>;

export const FraudSafetySignalSchema = z.object({
  signal_id: z.string(),
  severity: SeveritySchema,
  message: z.string(),
  route_to_siu: z.boolean().default(false),
  route_to_emergency: z.boolean().default(false),
});
export type FraudSafetySignal = z.infer<typeof FraudSafetySignalSchema>;

export const FraudSafetyGateSchema = z.object({
  final_routing_decision: RoutingDecisionSchema,
  signals: z.array(FraudSafetySignalSchema).default([]),
  audit_trail: z.array(z.string()).default([]),
});
export type FraudSafetyGate = z.infer<typeof FraudSafetyGateSchema>;

export const ClaimIntakePacketSchema = z.object({
  claim_type: ClaimTypeSchema,
  intake_status: IntakeStatusSchema,
  severity: SeveritySchema,
  routing_decision: RoutingDecisionSchema,
  missing_information: z.array(z.string()).default([]),
  required_documents: z.array(DocumentChecklistItemSchema).default([]),
  coverage_considerations: z.array(z.string()).default([]),
  adjuster_handoff_summary: z.string(),
  claimant_next_message: z.string(),
  audit_trail: z.array(z.string()).default([]),
  markdown: z.string(),
});
export type ClaimIntakePacket = z.infer<typeof ClaimIntakePacketSchema>;

/** Everything the claim team produces for one transcript snapshot. */
export interface ClaimWorkflowResult {
  normalized_claim: ClaimNarrative;
  field_validation: FieldValidation;
  claim_classification: ClaimClassification;
  coverage_evidence_decision: CoverageEvidenceDecision;
  document_checklist: DocumentChecklist;
  fraud_safety_gate: FraudSafetyGate;
  claim_intake_packet: ClaimIntakePacket;
  final_markdown: string;
}
