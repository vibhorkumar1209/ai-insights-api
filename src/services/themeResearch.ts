import { ThemeInput } from '@ai-insights/types';
import { claudeWithWebResearch, SYNTHESIS_MODEL } from './claudeAI';
import { buildThemeResearchQuery, researchCompanyThemes } from './parallelAI';
import { filterLiveUrls, isRedirectWrapper, resolveFinalUrl } from './urlValidator';

// Themes research. Parallel.AI returns prose with no reliable link to where
// each fact came from, and in production it had been failing outright, which
// silently left the themes to the model's own knowledge and its sources to
// "Not publicly disclosed". Claude's web search returns the actual page URLs
// it read, so every source shown can be checked against them.
const SYSTEM = `You are a research analyst. Every fact you report must come from a page or search result you actually retrieved with your tools in this session. Never use memory for facts, figures or URLs. After each fact, write the exact URL of the page it came from. Never write a URL you did not retrieve.`;

export interface ThemeResearch {
  notes: string;
  /** Page URLs the web tools actually returned. Empty when research fell back. */
  urls: string[];
}

export async function researchThemes(input: ThemeInput): Promise<ThemeResearch> {
  const label = `${input.companyName}${input.companyDomain ? ` (website: ${input.companyDomain})` : ''}`;
  const brief = `${buildThemeResearchQuery(label, input.themeType, input)}

OUTPUT: plain text research notes grouped by the numbered areas and discovery questions above. Put the source page URL after every fact. Prefer primary sources (annual reports, SEC filings, investor presentations, earnings call transcripts, company press releases, sustainability reports) and reputable news. Write "NOT FOUND" where you could not verify something.`;

  try {
    const r = await claudeWithWebResearch(SYSTEM, brief, 8000, SYNTHESIS_MODEL, {
      maxSearches: 8,
      legacySearch: true,
      timeoutMs: 270_000,
      source: 'themes.research',
    });
    if (r.text.trim().length >= 200 && r.urls.length > 0) return { notes: r.text, urls: r.urls };
    console.warn('[themes] web research came back thin, falling back to Parallel.AI');
  } catch (err) {
    console.warn('[themes] web research failed, falling back to Parallel.AI:', err instanceof Error ? err.message : err);
  }
  return { notes: await researchCompanyThemes(label, input.themeType, input), urls: [] };
}

// ── Source verification ──────────────────────────────────────────────────────

const URL_IN_TEXT = /https?:\/\/[^\s|)"'\]<>]+[^\s|).,;:"'\]<>]/g;
const NO_SOURCE = 'No verified source found';

function norm(u: string): string {
  return u.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
}

/**
 * Keeps a cited URL only when the research actually retrieved it (or, for the
 * Parallel.AI fallback, when it appears in the research text), resolves
 * redirect wrappers to the page they land on, and drops anything that does not
 * load. A theme with nothing left says so plainly instead of showing a
 * plausible but unverified link.
 */
export async function verifyThemeSources<T extends { source?: string }>(rows: T[], research: ThemeResearch): Promise<T[]> {
  const allowed = new Set((research.urls.length ? research.urls : research.notes.match(URL_IN_TEXT) || []).map(norm));
  return Promise.all(rows.map(async (row) => {
    const cited = Array.from(new Set((row.source || '').match(URL_IN_TEXT) || []));
    const kept: string[] = [];
    for (const url of cited) {
      if (!allowed.has(norm(url))) continue;
      const direct = isRedirectWrapper(url) ? await resolveFinalUrl(url) : url;
      if (direct && !kept.includes(direct)) kept.push(direct);
    }
    const live = (await filterLiveUrls(kept.join(' | '), '')) || '';
    return { ...row, source: live || NO_SOURCE };
  }));
}
