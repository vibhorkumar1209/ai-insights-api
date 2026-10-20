import {
  BusinessSegmentInput, SegmentDossierEntry, SegmentLeader,
  BattlecardInput, BattlecardComparisonRow,
} from '@ai-insights/types';
import {
  claudeCreateDirect, claudeWithWebResearch, getRecencyDirective, WRITING_DIRECTIVE,
  parseJsonRobust, SYNTHESIS_MODEL,
} from './claudeAI';

// ── URL honesty ──────────────────────────────────────────────────────────────
// The brief for this module is "do not hallucinate URLs". A model asked for an
// executive's LinkedIn profile will write a plausible one whether or not it
// found it, so the prompt alone cannot be trusted. Every link that reaches the
// user is checked against the URLs the web tools actually returned; anything
// else is dropped (and a segment page falls back to the parent site, which is
// what the brief asks for when a segment has no page of its own).

export function normalizeUrl(url: string): string {
  return String(url || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/^[a-z]{2,3}\.linkedin\.com/, 'linkedin.com')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
}

export function makeUrlVerifier(observed: string[], alwaysAllowed: string[] = []): (url: unknown) => string {
  const allowed = new Set([...observed, ...alwaysAllowed].map(normalizeUrl).filter(Boolean));
  return (url: unknown) => {
    if (typeof url !== 'string' || !url.trim()) return '';
    const key = normalizeUrl(url);
    if (!allowed.has(key)) return '';
    return /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => str(x).replace(/^[•\-*]\s+/, '')).filter(Boolean);
}

export function sanitizeDossier(
  raw: unknown,
  observedUrls: string[],
  input: BusinessSegmentInput
): SegmentDossierEntry[] {
  const parentSite = /^https?:\/\//i.test(input.companyDomain) ? input.companyDomain : `https://${input.companyDomain}`;
  const parentLinkedin = input.linkedinUrl || '';
  const verify = makeUrlVerifier(observedUrls, [parentSite, parentLinkedin]);
  const list = Array.isArray((raw as { segments?: unknown })?.segments) ? (raw as { segments: unknown[] }).segments : [];

  const out: SegmentDossierEntry[] = [];
  for (const item of list) {
    const s = (item || {}) as Record<string, unknown>;
    const name = str(s.name);
    if (!name) continue;

    const ownSite = verify(s.webpageUrl);
    const webpageUrl = ownSite || parentSite;
    const ownLinkedin = verify(s.linkedinUrl);
    const linkedinUrl = ownLinkedin || parentLinkedin;

    const leaders: SegmentLeader[] = [];
    for (const l of Array.isArray(s.leaders) ? s.leaders : []) {
      const lr = (l || {}) as Record<string, unknown>;
      const lname = str(lr.name);
      const title = str(lr.title);
      if (!lname || !title) continue;
      leaders.push({ name: lname, title, linkedinUrl: verify(lr.linkedinUrl) || undefined, profile: str(lr.profile) });
      if (leaders.length === 4) break;
    }

    out.push({
      name,
      coreFocus: str(s.coreFocus),
      contribution: str(s.contribution) || 'Not disclosed',
      webpageUrl,
      webpageRollsUp: !ownSite || normalizeUrl(ownSite) === normalizeUrl(parentSite),
      linkedinUrl,
      linkedinRollsUp: !ownLinkedin || normalizeUrl(ownLinkedin) === normalizeUrl(parentLinkedin),
      overview: str(s.overview),
      financialBaseline: str(s.financialBaseline) || 'Not publicly disclosed',
      keyProducts: strList(s.keyProducts),
      leaders,
    });
  }
  return out;
}

// ── Phase 1: research then structure ─────────────────────────────────────────

const SYSTEM_RESEARCH = `You are an institutional equity research analyst and corporate intelligence specialist. You build company dossiers STRICTLY from web sources you retrieve yourself with your tools. Every fact must come from a page you actually read or a search result you actually saw. Never use memory for names, figures or URLs, never invent anything, and never write a URL you did not see in a tool result. ${getRecencyDirective()}`;

export async function researchSegmentDossier(input: BusinessSegmentInput): Promise<{ notes: string; urls: string[] }> {
  const site = /^https?:\/\//i.test(input.companyDomain) ? input.companyDomain : `https://${input.companyDomain}`;
  const user = `TARGET COMPANY: "${input.companyName}", website ${site}${input.linkedinUrl ? `, parent LinkedIn page ${input.linkedinUrl}` : ''}.

Company names are often shared by unrelated businesses. Only use sources clearly about the company at ${input.companyDomain}.

RESEARCH, in this order:
1. Find the company's reporting or business segments and major subsidiaries. Best sources: the latest annual report or investor relations page, then the website's About, Business or Solutions pages. If the company reports no segments, treat the whole company as one segment.
2. For each segment capture: what it does and for whom, its share of revenue (%) or assets under management, the latest revenue, net income or AUM with the fiscal year, its main products or services, its own webpage, and its own LinkedIn page if it has a separate one.
3. For each segment find the top 3 to 4 executive leaders (for example CEO, CIO, head of distribution, head of a business line): full name, exact current title, a one-line background, and their LinkedIn profile if a search result or page showed it.

OUTPUT: plain text research notes, one block per segment, with the figures and fiscal years exactly as the source states them. After each fact that has a URL, write that URL. Write "NOT FOUND" for anything you could not verify. Do not pad, do not speculate. Keep names and titles exactly as published.`;

  const { text, urls } = await claudeWithWebResearch(SYSTEM_RESEARCH, user, 12000, SYNTHESIS_MODEL, {
    maxSearches: 15,
    maxFetches: 6,
    maxContentTokensPerFetch: 5000,
    timeoutMs: 270_000,
    source: 'businessSegment.research',
  });
  return { notes: text, urls };
}

export async function structureSegmentDossier(
  input: BusinessSegmentInput,
  notes: string,
  observedUrls: string[]
): Promise<SegmentDossierEntry[]> {
  const system = `You convert research notes into a structured company dossier. Use ONLY facts present in the notes. Do not add anything from memory. ${getRecencyDirective()} ${WRITING_DIRECTIVE} Output ONLY valid JSON, no markdown fences, no commentary.`;
  const user = `COMPANY: "${input.companyName}" (${input.companyDomain}).

RESEARCH NOTES:
${notes.slice(0, 40000)}

URLS THE RESEARCH ACTUALLY RETRIEVED (the only URLs you may output):
${observedUrls.slice(0, 200).join('\n')}

Return JSON of exactly this shape:
{"segments":[{
  "name":"segment or subsidiary name",
  "coreFocus":"core focus or asset class, a few words",
  "contribution":"share of total revenue (%) or total managed assets (AUM) with the fiscal year, or \\"Not disclosed\\"",
  "webpageUrl":"the segment's own page from the URL list, or \\"\\" if it has none",
  "linkedinUrl":"the segment's own LinkedIn page from the URL list, or \\"\\" if it has none",
  "overview":"2 to 3 sentences: what it does, its target audience or buyers, its market positioning",
  "financialBaseline":"latest revenue, net income or AUM with the fiscal year, or \\"Not publicly disclosed\\"",
  "keyProducts":["short, punchy product or service", "..."],
  "leaders":[{"name":"full name","title":"exact corporate title","linkedinUrl":"from the URL list or \\"\\"","profile":"2 sentences: background and responsibilities in this segment"}]
}]}

RULES
- Include every major segment and subsidiary the notes identify, ordered by revenue contribution, largest first.
- 3 to 4 leaders per segment, but ONLY people named in the notes. Return fewer, or an empty list, rather than guess a name or title.
- A URL field must be copied exactly from the URL list. If the notes did not surface one, return "". Never construct a URL.
- Never invent a figure. If the notes give none, use "Not disclosed" or "Not publicly disclosed".
- No marketing language, no filler. Single quotes inside strings, never double quotes.`;

  const raw = await claudeCreateDirect(system, user, 14000, SYNTHESIS_MODEL, 180_000, undefined, 'businessSegment.structure');
  return sanitizeDossier(parseJsonRobust(raw), observedUrls, input);
}

// ── Phase 2: battlecard ──────────────────────────────────────────────────────

export interface BattlecardDraft {
  segmentContext: string;
  coreWinTheme: string;
  opportunityAreas: string[];
  comparison: BattlecardComparisonRow[];
}

export function sanitizeBattlecard(raw: unknown): BattlecardDraft {
  const r = (raw || {}) as Record<string, unknown>;
  const comparison: BattlecardComparisonRow[] = [];
  for (const row of Array.isArray(r.comparison) ? r.comparison : []) {
    const x = (row || {}) as Record<string, unknown>;
    const dimension = str(x.dimension);
    if (!dimension) continue;
    comparison.push({
      dimension,
      yourSolution: str(x.yourSolution),
      competitor: str(x.competitor),
    });
  }
  return {
    segmentContext: str(r.segmentContext),
    coreWinTheme: str(r.coreWinTheme),
    opportunityAreas: strList(r.opportunityAreas).slice(0, 3),
    comparison,
  };
}

export async function generateBattlecard(
  company: BusinessSegmentInput,
  segment: SegmentDossierEntry,
  inputs: BattlecardInput
): Promise<BattlecardDraft> {
  const system = `You are an enterprise B2B sales strategist writing a competitive battlecard. Ground every claim about the target segment, the seller and the competitor in sources you retrieve with your tools or in the dossier provided. Never invent a customer relationship, a feature or a weakness: where something is not publicly documented, say so. ${getRecencyDirective()} ${WRITING_DIRECTIVE}`;

  const dossier = JSON.stringify({
    company: company.companyName,
    segment: segment.name,
    coreFocus: segment.coreFocus,
    overview: segment.overview,
    financialBaseline: segment.financialBaseline,
    keyProducts: segment.keyProducts,
  });

  const user = `TARGET SEGMENT DOSSIER (already researched):
${dossier}

SELLER: ${inputs.yourCompany} (${inputs.yourUrl})
FOCUS SOLUTION: ${inputs.yourSolution}
COMPETITOR: ${inputs.competitorName} (${inputs.competitorUrl})

Research the seller's solution and the competitor's offering from their sites and recent coverage, and look for any known vendor relationship between either of them and ${company.companyName}'s ${segment.name} unit. Then output ONLY this JSON:
{
 "segmentContext":"validate the segment, then note any known historical vendor relationships, structural pain points or technology gaps typical for this unit",
 "coreWinTheme":"exactly 2 sentences: why this segment should choose the seller over the competitor",
 "opportunityAreas":["2 to 3 bullets, each a specific operational inefficiency, regulatory shift or strategic growth goal in this segment where the solution solves a major pain point"],
 "comparison":[{"dimension":"feature or service area","yourSolution":"the seller's advantage","competitor":"the competitor's known weakness or gap, or 'Not publicly documented'"}]
}
Give 5 to 7 comparison rows. Single quotes inside strings, never double quotes. No markdown fences.`;

  const { text } = await claudeWithWebResearch(system, user, 6000, SYNTHESIS_MODEL, {
    maxSearches: 5,
    maxFetches: 3,
    maxContentTokensPerFetch: 4000,
    timeoutMs: 180_000,
    source: 'businessSegment.battlecard',
  });

  try {
    return sanitizeBattlecard(parseJsonRobust(text));
  } catch {
    // The research turn answered in prose or broken JSON; one cheap reshape
    // pass recovers it without paying for the research again.
    const reshaped = await claudeCreateDirect(
      'Convert the text into the requested JSON. Output ONLY valid JSON. Do not add facts.',
      `Shape: {"segmentContext":"","coreWinTheme":"","opportunityAreas":[""],"comparison":[{"dimension":"","yourSolution":"","competitor":""}]}\n\nTEXT:\n${text.slice(0, 20000)}`,
      4000, SYNTHESIS_MODEL, 90_000, undefined, 'businessSegment.battlecard.reshape'
    );
    return sanitizeBattlecard(parseJsonRobust(reshaped));
  }
}
