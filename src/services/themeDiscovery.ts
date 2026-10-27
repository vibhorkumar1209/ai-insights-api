import { ThemeInput, ThemeType, ThemeDiscoveryRow } from '@ai-insights/types';

// The fixed discovery structure for each theme type: what a seller needs to
// uncover about the account. Every theme report answers these, in this order.
export const DISCOVERY_PARAMS: Record<ThemeType, { parameter: string; question: string }[]> = {
  business: [
    { parameter: 'Strategic Imperatives', question: 'Is the customer focusing on cutting costs or launching new digital products?' },
    { parameter: 'Industry Vertical', question: 'What specific industry regulations (e.g., DORA in EU banking) are keeping them up at night?' },
    { parameter: 'Geographic Footprint', question: 'Are they expanding into new regions with strict data residency laws?' },
  ],
  technology: [
    { parameter: 'Infrastructure Topology', question: 'Are they trapped in legacy on-prem data centers, or are they cloud-native?' },
    { parameter: 'Integration Ecosystem', question: 'What are their non-negotiable core systems (e.g., SAP, Salesforce)?' },
    { parameter: 'Developer Experience', question: 'Is their internal IT team highly skilled or struggling with a skills gap?' },
  ],
  sustainability: [
    { parameter: 'Carbon Footprint Tracking', question: 'Do they have public net-zero targets (e.g., by 2030 or 2040)?' },
    { parameter: 'Regulatory Reporting', question: 'Are they subject to strict upcoming ESG disclosures (like CSRD)?' },
  ],
};

export function hasSeller(input: ThemeInput): boolean {
  return Boolean(input.userOrganization || input.solutionPortfolio);
}

/**
 * The optional inputs, written as instructions. Goes into BOTH the web
 * research query and the synthesis prompt, so an input the user gave actually
 * changes what is searched for, not only how the answer is worded. Empty when
 * no optional input was given.
 */
export function themeContextBlock(input: ThemeInput): string {
  const t = input.companyName;
  const lines: string[] = [];
  if (input.industry) {
    lines.push(`INDUSTRY: ${t} operates in ${input.industry}. Look specifically for regulations, market shifts and competitive moves in ${input.industry} that affect ${t}.`);
  }
  if (input.keyTriggers) {
    lines.push(`KEY TRIGGERS: Search specifically for evidence of these trigger events at ${t}, with dates: ${input.keyTriggers}.`);
  }
  if (input.focusTechnologies) {
    lines.push(`FOCUS TECHNOLOGIES: Report specifically on ${t}'s adoption, named vendors, spend signals and plans for: ${input.focusTechnologies}.`);
  }
  if (hasSeller(input)) {
    const seller = input.userOrganization ? `${input.userOrganization}${input.userDomain ? ` (${input.userDomain})` : ''}` : 'the seller';
    lines.push(`SELLER CONTEXT: This research supports ${seller}${input.solutionPortfolio ? `, which offers: ${input.solutionPortfolio}` : ''}. Surface evidence at ${t} of needs, pain points, current vendors and initiatives relevant to these offerings.`);
  }
  return lines.join('\n');
}

export function discoveryQuestionsBlock(input: ThemeInput): string {
  return DISCOVERY_PARAMS[input.themeType]
    .map((p, i) => `${i + 1}. ${p.parameter}: ${p.question.replace(/\bthey\b|\bthe customer\b/gi, input.companyName)}`)
    .join('\n');
}

/** Keeps exactly the predetermined parameters, in order, whatever the model returned. */
export function shapeDiscovery(input: ThemeInput, raw: unknown): ThemeDiscoveryRow[] {
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { discovery?: unknown })?.discovery) ? (raw as { discovery: unknown[] }).discovery : [];
  const byParam = new Map<string, Record<string, unknown>>();
  for (const item of list) {
    const r = (item || {}) as Record<string, unknown>;
    if (typeof r.parameter === 'string') byParam.set(r.parameter.trim().toLowerCase(), r);
  }
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  return DISCOVERY_PARAMS[input.themeType].map((p) => {
    const r = byParam.get(p.parameter.toLowerCase()) || {};
    return {
      parameter: p.parameter,
      question: p.question,
      finding: s(r.finding) || 'Not publicly disclosed.',
      sellerAngle: hasSeller(input) ? s(r.sellerAngle) || undefined : undefined,
      source: s(r.source) || undefined,
    };
  });
}
