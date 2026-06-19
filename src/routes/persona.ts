import { Router, Request, Response } from 'express';
import { researchIndustryReport } from '../services/parallelAI';
import { claudeCreateDirect } from '../services/claudeAI';

const router = Router();

const SYNTHESIS_MODEL = 'claude-sonnet-4-6';

router.post('/tailored-pitch', async (req: Request, res: Response) => {
  const {
    yourName, yourTitle, yourCompany, yourOffering, targetAudience,
    targetName, targetTitle, targetCompany, targetIndustry, targetPainPoints, targetRecentNews,
    caseStudyCompany, caseStudyIndustry, caseStudyProblem, caseStudySolution, caseStudyMetrics, caseStudyOutcome,
  } = req.body;

  try {
    // Step 1: Research target executive and company using Parallel.AI
    const targetSearchQueries = [
      `${targetName} ${targetCompany} ${targetTitle} challenges`,
      `${targetCompany} ${targetIndustry} market trends news`,
    ];

    let targetResearch = '';
    try {
      const researchResults = await researchIndustryReport(targetSearchQueries);
      targetResearch = researchResults.join('\n\n---\n\n');
    } catch (err) {
      console.warn('[persona] Research failed, continuing with provided context:', err);
      targetResearch = '';
    }

    // Step 2: Use Claude to synthesize outreach
    const prompt = `You are a strategic sales engineering expert. Analyze the following information and generate high-conversion sales outreach materials.

USER PROFILE:
- Name: ${yourName}
- Title: ${yourTitle}
- Company: ${yourCompany}
- What they offer: ${yourOffering}
- Target audience: ${targetAudience}

TARGET EXECUTIVE:
- Name: ${targetName}
- Title: ${targetTitle}
- Company: ${targetCompany}
- Industry: ${targetIndustry}
- Known pain points: ${targetPainPoints || '(Research below)'}
- Recent news/activity: ${targetRecentNews || '(None provided)'}

MARKET RESEARCH ON TARGET:
${targetResearch || '(No additional research available)'}

PROOF POINT / CASE STUDY:
- Client company: ${caseStudyCompany}
- Industry: ${caseStudyIndustry}
- Problem they faced: ${caseStudyProblem}
- Solution provided: ${caseStudySolution}
- Key metrics: ${caseStudyMetrics}
- Outcome/impact: ${caseStudyOutcome}

YOUR TASK:
1. Identify the VALUE GAP: Where the target executive's pain points intersect with the user's solution capability.
2. Generate THREE outreach pieces:

A) LINKEDIN CONNECTION REQUEST (max 300 characters)
   - Reference a specific detail from the target's profile, company, or recent news (NOT generic)
   - Create urgency or curiosity without being salesy
   - Make it feel personal and research-based

B) PROFESSIONAL EMAIL
   - Internal-style subject line (as if from a peer, not a vendor)
   - Peer-to-peer tone, consultative
   - Open with acknowledgment of their world/challenges
   - Feature ONE metric-driven proof point from the case study (quantified impact)
   - Use plain language, avoid marketing jargon
   - End with low-friction interest-based CTA (not "let's schedule a call")
   - 150-200 words for body

C) 30-SECOND IN-PERSON PITCH SCRIPT
   - Conversational, as if you're explaining to a peer over coffee
   - Focus on business transformation, not features
   - Start with the pain point they likely face
   - Bridge to the business outcome (not solution features)
   - 30 seconds when read aloud (~75-90 words)
   - No marketing jargon

Return ONLY valid JSON with this exact structure:
{
  "valueGap": "2-3 sentence summary of the specific value gap identified",
  "linkedinMessage": "LinkedIn message text",
  "email": {
    "subject": "Email subject line",
    "body": "Email body text"
  },
  "pitchScript": "30-second pitch script"
}

Ensure all strings are properly escaped. Output valid JSON only.`;

    const text = await claudeCreateDirect(
      'You are a strategic sales engineering AI. Generate high-conversion sales outreach that is consultative, specific, and human. Output ONLY valid JSON.',
      prompt,
      2000,
      SYNTHESIS_MODEL,
      120000,
      0.2 // Slightly creative but consistent
    );

    // Parse JSON response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in response');

    const result = JSON.parse(jsonMatch[0]);

    res.json(result);
  } catch (err) {
    console.error('[persona] Error:', err);
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to generate pitch',
    });
  }
});

export default router;
